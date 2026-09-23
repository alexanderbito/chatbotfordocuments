# BotClarify — a SaaS chatbot that answers questions about company documents

Each company signs up for an administrator account, uploads its documents (organized
into folders), and the system indexes them and serves a chatbot that answers
**only from that company's own documents**. The administrator invites colleagues into
the organization; ordinary members can do nothing but talk to the chatbot.

Stack: Node/Express · Supabase (Postgres + pgvector) · Cloudflare R2 · Voyage AI (embeddings) ·
DeepSeek (LLM) · Gemini (OCR) · Render/Railway (hosting). The front end is plain HTML/CSS/JS,
**with no build step**.

The product is English-only: the interface, the plan names and the chatbot's replies are all
in English, whatever language the uploaded documents happen to be written in.

---

## 1. Architecture and data flow

One Express process serves both the static front end from `public/` and the JSON API from
`src/routes/`. There is no separate worker service; document processing runs in the same
process behind a small in-memory queue (`src/queue.js`).

**Upload and indexing** (`POST /orgs/:orgId/documents`):

1. The file arrives through multer, capped at 25 MB, and is stored in Cloudflare R2
   (`src/storage.js`). The bucket does not need to be public: downloads are served through
   signed URLs that expire after 5 minutes, and only organization administrators can request one.
2. Text is extracted in `src/textExtract.js` — `pdf-parse` for PDF, `mammoth` for `.docx`,
   plain UTF-8 for `.txt`. Any other MIME type is rejected.
3. If a PDF yields almost no text it is treated as a scan and handed to the OCR path in
   `src/ocr.js`, which sends page batches to Gemini (section 11).
4. The text is split into overlapping chunks (`src/chunk.js`, 1000 characters with 150 of
   overlap) and embedded with Voyage AI `voyage-4-lite`, 1024 dimensions (`src/embed.js`).
5. Chunks and vectors land in the `document_chunks` table, which is indexed with pgvector.

**Asking a question** (`POST /orgs/:orgId/chat`):

1. `src/access.js` computes the exact set of folders the caller is allowed to read, taking
   private folders and inherited restrictions into account.
2. That set is passed to the SQL function `match_document_chunks_acl`, so the similarity
   search itself is scoped both by organization and by folder permission. This fails closed:
   a mistake in the permission calculation returns nothing rather than returning a document
   the user should not see.
3. The matching chunks become the context for DeepSeek (`src/llm.js`), which is instructed to
   answer only from that context, to cite its sources, and to reply in the language the question was asked in (see `BOT_REPLY_LANGUAGE`).
4. The question, the answer and the sources are written to the chat history.

**Payments** run through PayPal only (section 10). The PayPal webhook route is mounted in
`src/index.js` **before** `express.json()`, because signature verification needs the request
body verbatim.

---

## 2. The three roles

| Role | Entry point | What it can do |
|---|---|---|
| **System administrator** (super admin) | `/sysadmin.html` | Manage every organization, plan, payment, user, log entry, and check system health |
| **Organization administrator** | `/admin.html` | Upload / delete / download documents, manage folders, invite members and set their permissions, read the chat history, see plan usage |
| **Member** | `/chat.html` | Talk to the chatbot **within the folders they are allowed to read**, and read their own history |

Every API route enforces these rules on the server. Hiding a button in the interface is never
the only check.

---

## 3. Interface pages

| Path | Purpose |
|---|---|
| `/login.html` | Sign in |
| `/register.html` | Register a new company, or accept an invitation (`?invite=<token>`) |
| `/chat.html` | The question-and-answer workspace, for every member |
| `/admin.html` | Organization admin console: Overview · Documents & folders · Members · Chat history · Plan & billing · Settings |
| `/sysadmin.html` | System admin console: Dashboard · Organizations · Plan & billing · Payments · Users · Activity log · System health |
| `/pricing.html` | The public price list, in USD |
| `/billing-return.html` | Where the payer lands after checking out |
| `/` | Redirects to the right console for whoever is signed in |

---

## 4. First-time setup

### Step 1 — The database

In **Supabase Dashboard -> SQL Editor -> New query**, run these files in order:

1. `supabase_schema.sql` — only needed on a brand-new project. Creates `organizations`,
   `documents`, `document_chunks` and enables pgvector.
2. `migration_v2_auth.sql` — **required**. Creates the auth, permission, folder, member,
   plan and log tables, and updates the search function.
3. `migration_v3_ocr.sql` — **required**. Adds the OCR quota and the OCR tracking columns.
4. `migration_v4_ocr_retry.sql` — **required**. Adds the retry counters and the table that
   caches finished OCR batches.
5. `migration_v5_folder_acl.sql` — **required**. Adds public/private folder visibility and
   per-email folder permissions.
6. `migration_v6_payments.sql` — **required**. Adds USD pricing and gateway checkout.
7. `migration_v7_trial.sql` — **required**. Turns the free plan into a 3-day trial with no OCR.
8. `migration_v8_english_plans.sql` — **required**. Moves the plan catalogue to English. Plan names and descriptions live in the database and are rendered on the pricing page, the sign-up page and the "Current plan" card, so a database seeded before the switch keeps showing its original text until this runs.

**Run them in that order.** Every file from v3 onwards starts with a precondition check and
stops with a clear message if an earlier file has not been run.

If you hit `relation "..." does not exist`, run `kiem_tra_migration.sql`. It is a read-only
diagnostic that prints which migration stage the database is at and which tables exist.
The two usual causes:

- An earlier migration file was never run.
- **The SQL Editor is open on the wrong Supabase project.** If the app on Render works fine
  but the SQL Editor claims tables are missing, this is almost always it — compare the
  `SUPABASE_URL` in Render's Environment tab against the project open in the dashboard.

`migration_v2_auth.sql` is safe to run repeatedly; it uses `if not exists` throughout.

> If the project still stores 1536-dimension embeddings from an older OpenAI setup, run
> `migration_to_voyage.sql` first. It wipes documents and chunks, so everything has to be
> re-uploaded and re-indexed afterwards.

### Step 2 — Environment variables

```bash
cp .env.example .env    # then fill in the real values
```

**Supabase**

| Variable | Required | Meaning |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase -> Project Settings -> API |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | The service role key. Server-side only, never sent to the browser |
| `SUPABASE_ANON_KEY` | Recommended | The `anon public` key, used for the sign-in call. If left empty the service role key is used instead |

**Cloudflare R2**

| Variable | Required | Meaning |
|---|---|---|
| `R2_ACCOUNT_ID` | Yes | Cloudflare Dashboard -> R2 |
| `R2_ACCESS_KEY_ID` | Yes | R2 -> Manage API Tokens |
| `R2_SECRET_ACCESS_KEY` | Yes | As above |
| `R2_BUCKET_NAME` | Yes | The bucket that holds uploaded files |
| `R2_PUBLIC_URL` | No | Only needed if the bucket is public. Downloads use signed 5-minute URLs, so a private bucket is fine |

**Voyage AI (embeddings)**

| Variable | Required | Meaning |
|---|---|---|
| `VOYAGE_API_KEY` | Yes | The free tier includes 200 million tokens |
| `VOYAGE_BASE_URL` | No | Point at an internal proxy or gateway instead of calling `api.voyageai.com` directly |

**DeepSeek (answer generation)**

| Variable | Required | Meaning |
|---|---|---|
| `DEEPSEEK_API_KEY` | Yes | |
| `DEEPSEEK_BASE_URL` | Yes | `https://api.deepseek.com` |
| `BOT_REPLY_LANGUAGE` | No | Which language the chatbot answers in. Defaults to `auto`: the answer mirrors the language of the question, whatever language the documents are written in. Set a language name such as `English` to pin every answer to one language instead |

**Gemini (OCR for scanned PDFs)**

| Variable | Required | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | Only for OCR | From https://aistudio.google.com/apikey. Leave it empty and the app still runs, but scanned PDFs fail on upload |
| `GEMINI_OCR_MODELS` | No | Comma-separated fallback chain. Default `gemini-3.5-flash,gemini-3.5-flash-lite` |
| `OCR_RETRY_ROUNDS` | No | Retry rounds per page batch. Default 5 |
| `OCR_DOC_RETRIES` | No | How many times a whole document reschedules itself. Default 3 |
| `OCR_MAX_PAGES` | No | Hard cap per file. Default 30 pages |
| `OCR_PAGES_PER_BATCH` | No | Pages per API call. Default 5. Small batches avoid truncated output |
| `OCR_TIMEOUT_MS` | No | Per-request timeout. Default 120000 |
| `OCR_MAX_OUTPUT_TOKENS` | No | Default 32768 |
| `OCR_RETRY_BASE_MS` / `OCR_RETRY_MAX_MS` | No | Backoff floor and ceiling. Defaults 1000 and 60000 |

**Document processing queue**

| Variable | Required | Meaning |
|---|---|---|
| `WORKER_CONCURRENCY` | No | Default 1 — leave it there on Render Free, which has 512 MB of RAM |
| `WORKER_MAX_QUEUE` | No | Default 20 |

**Payments (PayPal)**

| Variable | Required | Meaning |
|---|---|---|
| `PAYPAL_CLIENT_ID` | To sell | developer.paypal.com -> Apps & Credentials |
| `PAYPAL_SECRET` | To sell | As above |
| `PAYPAL_ENV` | **Read the warning below** | `sandbox` or `live`. Defaults to `sandbox` |
| `PAYPAL_WEBHOOK_ID` | To sell | Created when you add the webhook in the PayPal Developer Dashboard. Without it webhooks are rejected, so a payer can pay without getting their plan |
| `APP_BASE_URL` | Recommended | The app's public URL, used for the return links after checkout. On Render it falls back to `RENDER_EXTERNAL_URL` |

> ### `PAYPAL_ENV` must match the credentials
>
> `PAYPAL_ENV` defaults to `sandbox`. **A Live PayPal app REQUIRES `PAYPAL_ENV=live`.**
>
> If you paste Live credentials while the variable is still `sandbox`, those credentials are
> sent to `api-m.sandbox.paypal.com`, which does not know them, and PayPal answers with
> `Client Authentication failed`. That message looks exactly like a mistyped key, so it is
> easy to spend an afternoon re-copying a Client ID that was correct all along.
>
> The system health page detects this specific case: when the credentials fail in the
> configured environment but succeed in the other one, it says so and names the value
> `PAYPAL_ENV` should have.
>
> A related trap: pasting values into Render often picks up a trailing space or newline,
> which corrupts the Basic auth string and produces the same `Client Authentication failed`.
> The credentials are trimmed in `src/payments/paypal.js` for exactly this reason.

**System administration**

| Variable | Required | Meaning |
|---|---|---|
| `SYSTEM_ADMIN_EMAILS` | Recommended | Comma-separated emails that always hold system admin rights. See step 4 |

**Trial cleanup**

| Variable | Required | Meaning |
|---|---|---|
| `CRON_SECRET` | Recommended | Protects `POST /cron/purge-trials`. Leave it empty and that endpoint is disabled |
| `TRIAL_GRACE_HOURS` | No | Hours of grace after expiry before data is deleted. Default 0 |
| `TRIAL_SWEEP_INTERVAL_MS` | No | How often the traffic-driven sweep may run. Default 6 hours |

**Server**

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | No | Default 3000 |

### Step 3 — Run it

```bash
npm install
npm run dev        # http://localhost:3000
```

### Step 4 — Create the first system administrator

There are three ways. Pick one.

**Way 1 — the environment variable (recommended).** Set `SYSTEM_ADMIN_EMAILS` on Render (or in
`.env` locally), then sign up at `/register.html` with exactly that email:

```
SYSTEM_ADMIN_EMAILS=you@company.com
```

An email in this list is **not asked for a company name** and creates no throwaway
organization — a system administrator account sits outside every organization. After signing
in you land straight on `/sysadmin.html`.

This variable is also the break-glass route: effective rights are the database flag **or**
membership of this list. If the flag is ever cleared by accident, adding the email here gets
you back in.

Note that the database flag is switched on at the first sign-in to keep the two in sync, so
**taking an email back out of the variable does not revoke anything**. Revoke it explicitly
with `npm run make-admin -- you@company.com --revoke` or from the Users page of the system
admin console — and remove the email from the variable first, otherwise the revoke is blocked.

**Way 2 — the admin console.** Once one system administrator exists, every further one is
created from `/sysadmin.html` -> **Users** -> **Create system administrator**
(`POST /admin/users`). This is the normal way to add colleagues.

**Way 3 — the command line.** Register the account normally first, then run this on a machine
that has a populated `.env` (it needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`):

```bash
npm run make-admin -- admin@company.com          # grant
npm run make-admin -- admin@company.com --revoke # revoke
npm run make-admin -- --list                     # show who currently has the rights
```

The script refuses to revoke the last remaining system administrator, so the system can never
be left with nobody able to manage it.

⚠️ **A system administrator can read the documents and chat history of EVERY organization on
the platform.** This is not scoped to one tenant and there is no audit gate in front of it.
Grant the role only to people who genuinely need it.

---

## 5. Deploying on Render

The product is two deployments from this one repository:

| What | Render service type | Folder | Domain |
|---|---|---|---|
| The application | Web Service | repository root | `app.botclarify.com` |
| The marketing site | Static Site | `site/` | `botclarify.com` and `www.botclarify.com` |

They are split because the marketing site is plain files with no server behind it. As a static
site it is free, it never sleeps, and a visitor who lands on the home page does not have to
wait for a sleeping application instance to wake up.

### The application — Web Service

- Build command: `npm install`
- Start command: `npm start`
- **Environment** tab: paste in every variable from `.env`. Double-check `SUPABASE_ANON_KEY`,
  `APP_BASE_URL` and `PAYPAL_ENV` — those three are the ones most often forgotten.
- `APP_BASE_URL` must be `https://app.botclarify.com`, not the apex domain. It builds the
  return link after a payment and is what PayPal signs its webhooks against.
- Custom domain: `app.botclarify.com`.

### The marketing site — Static Site

- Root directory: `site`
- Build command: leave empty (there is nothing to build)
- Publish directory: `.`
- Custom domains: `botclarify.com` and `www.botclarify.com`.

Every call-to-action on the marketing site points at `https://app.botclarify.com/register.html`
or `/login.html`. Those links are written out in full in `site/index.html`; the application
points back with the `SITE_URL` constant at the top of `public/assets/app.js`. Changing either
domain means editing those two places.

### DNS

All four records are CNAMEs. Render's Custom Domains page shows the exact targets, including
the two verification records; the shape is:

| Type | Name | Points at |
|---|---|---|
| CNAME | `@` | the static site's `onrender.com` address |
| CNAME | `www` | the static site's `onrender.com` address |
| CNAME | `app` | the web service's `onrender.com` address |

Render does not publish a fixed IP for a service, so the apex record has to be a CNAME. That
is not valid in plain DNS, so the domain needs a provider that flattens it — Cloudflare's free
tier does, and Render documents that combination. Set Cloudflare's proxy to **DNS only** until
the certificates are issued, and SSL/TLS mode to **Full**.

### After changing a domain

Three things have to be updated by hand, and a payment silently fails if any of them is missed:

1. `APP_BASE_URL` on the web service.
2. The webhook URL in the PayPal dashboard — `https://app.botclarify.com/webhooks/paypal`.
   PayPal signs against the address, so a stale one makes every webhook fail signature checks.
3. The external cron job that calls `POST /cron/purge-trials`.

The System health page checks `APP_BASE_URL` against the address you are actually browsing and
warns when they differ, which catches the first of those three.

Run the migrations on Supabase **before** opening the interface for the first time, or every
page will fail with a missing-table error.

Render's Free plan puts the service to sleep after about 15 minutes without traffic. The first
request after that takes tens of seconds. It also means the traffic-driven trial sweep may not
run for an abandoned organization, which is why the external cron route exists (section 9).

---

## 6. API map

```
POST   /auth/register                         register a company, or accept an invitation
POST   /auth/login                            sign in
GET    /auth/me                               profile plus the caller's organizations
POST   /auth/change-password
PATCH  /auth/profile
GET    /auth/invite/:token                    look up an invitation (public)

GET    /orgs/:orgId                           organization details plus the caller's role
PATCH  /orgs/:orgId                           edit the company profile             (org admin)
GET    /orgs/:orgId/overview                  dashboard figures                    (org admin)
GET    /orgs/:orgId/billing                   plan and payment history             (org admin)
POST   /orgs/:orgId/billing/checkout          open a checkout session              (org admin)
GET    /orgs/:orgId/billing/payments/:id      status of one transaction            (org admin)
POST   /orgs/:orgId/billing/payments/:id/capture  capture a PayPal order           (org admin)

GET    /public/billing/plans                  the public price list, in USD, plus the
                                              gateways that are currently configured
GET    /public/plans                          older, leaner plan list kept for compatibility
GET    /healthz                               liveness probe
POST   /cron/purge-trials                     purge expired trial data (header x-cron-secret)
POST   /admin/maintenance/purge-trials        purge on demand                    (system admin)
POST   /webhooks/paypal                       PayPal webhook (signature-verified)

GET    /orgs/:orgId/folders                   the folder tree, filtered by the caller's rights
POST   | PATCH | DELETE  /orgs/:orgId/folders manage folders                       (org admin)
GET    /orgs/:orgId/folders/:id/permissions   emails allowed to read a folder      (org admin)
PUT    /orgs/:orgId/folders/:id/permissions   replace that list of emails          (org admin)

GET    /orgs/:orgId/documents                 list documents                       (org admin)
POST   /orgs/:orgId/documents                 upload (multipart: file, folder_id)  (org admin)
PATCH  /orgs/:orgId/documents/:id             rename or move to another folder     (org admin)
GET    /orgs/:orgId/documents/:id/download    signed download link, valid 5 minutes (org admin)
POST   /orgs/:orgId/documents/:id/reindex     reprocess a failed document          (org admin)
DELETE /orgs/:orgId/documents/:id             delete the document, its chunks and the R2 object

GET    | POST | PATCH | DELETE  /orgs/:orgId/members   manage members              (org admin)

POST   /orgs/:orgId/chat                      ask the chatbot (any member)
GET    /orgs/:orgId/chat/mine                 the caller's own history
GET    /orgs/:orgId/chat/history              the whole organization's history     (org admin)

/admin/*                                      the entire system admin area
       overview · organizations · organizations/:id · users · system-admins
       plans · payments · logs · failed-documents · health
       maintenance/fix-filenames · maintenance/purge-trials
       organizations/:id/purge-data
POST   /admin/users                           create a new system administrator
GET    /admin/system-admins                   who currently holds system admin rights
```

Authentication: the `Authorization: Bearer <access_token>` header, with a token issued by
Supabase Auth.

---

## 7. Plan quotas

The backend enforces quotas at the API level, not merely in the interface:

- Uploading a document: checks the document count and the remaining storage, and returns `402`
  when either is exceeded.
- Inviting a member: checks the member ceiling.
- Asking the chatbot: checks the number of questions used this month.
- OCR on a scanned PDF: checks the OCR pages left this month (section 11).

Three plans are seeded by the migrations — `free` (the 3-day trial), `pro` (Professional,
$19) and `business` (Business, $79) — and every limit and price is editable in
`/sysadmin.html` -> **Plan & billing**.

---

## 8. Public and private folders

Every folder has an access mode:

- **Public** (the default): everyone in the organization can ask the chatbot about the
  documents inside it.
- **Private**: only the emails the administrator has granted can read it.

### Four rules worth knowing

**1. Restrictions are inherited from parent folders.** To read a folder you must have access to
*every* private folder on the path down to it. A public folder nested inside a private one
stays restricted, so nobody can leak data by accident just by creating a subfolder.

**2. Hidden completely.** A member without access never sees the folder's name anywhere,
including in the scope picker on the chat page. A folder name ("Executive salaries") is
sensitive in itself.

**3. The chatbot cannot read what the asker cannot read.** The backend computes the list of
folders the asker may read and passes it into the `match_document_chunks_acl` search function.
This fails closed: if the permission calculation is ever wrong, the user sees nothing rather
than seeing a confidential document. If the client asks for `folder_ids` outside its own
scope, the API returns `403`.

**4. Organization administrators read everything.** They already manage every document, so
there is nothing to grant them.

### Operational notes

- Permissions can only be granted to emails that are **already members** of the organization.
  Unknown addresses are skipped and reported back, so a typo cannot look like a successful grant.
- Removing someone from the organization also revokes their access to private folders.
- Switching a folder from private back to public clears its permission list.
- Deleting a private folder that still holds documents returns `409` and asks for confirmation,
  because those documents would fall back to "Uncategorized" and become readable
  organization-wide.
- Uncategorized documents (`folder_id = null`) count as public within the organization.

---

## 9. The 3-day trial

The free plan is a **3-day trial** with every feature **except OCR for scanned PDFs**. If the
organization does not upgrade within three days its documents are deleted.

### Three stages

**During the three days.** The clock runs from sign-up (`organizations.plan_expires_at`). The
interface shows a countdown banner on every page, turning amber under 24 hours.

**Expired.** Asking the chatbot and uploading documents are blocked with `402`, but the plan
and settings pages **stay reachable** so the customer can upgrade. The block is deliberately
not applied globally: blocking everything would leave the customer no way to pay.

**After expiry.** The purge removes documents, R2 objects, indexed chunks, cached OCR batches
and chat history. It **keeps** the account, the organization, the members and the folder tree,
so a customer who comes back to upgrade can pick up where they left off instead of registering
again.

### When the purge runs

Two independent paths, so nothing depends on a single mechanism:

1. **Traffic-driven** — on any incoming request, if more than `TRIAL_SWEEP_INTERVAL_MS`
   (6 hours by default) has passed since the last sweep, one runs in the background. No
   configuration needed.
2. **External cron** — `POST /cron/purge-trials` with the `x-cron-secret` header. Point a free
   cron service at it once a day. This matters because Render Free sleeps after 15 minutes
   without traffic, so path 1 may never fire for an abandoned organization.

A system administrator can also purge on demand with `POST /admin/maintenance/purge-trials`
(add `?dry_run=1` to only list what would go).

### Which plans get OCR

The `plans.ocr_enabled` column, toggled in `/sysadmin.html` -> **Plan & billing**. A plan with
OCR disabled reports a clear error with an upgrade hint when it meets a scanned PDF, and
**never calls Gemini**, so no cost is incurred.

---

## 10. Payments

PayPal is the only gateway and USD the only currency. Prices live in `plans.price_usd` and are
editable in `/sysadmin.html` -> **Plan & billing**. The public price list is served from
`GET /public/billing/plans`, which also reports which gateways are actually configured on the
server, so the pricing page never offers a checkout that cannot complete.

### The flow

1. The organization admin picks a plan -> `POST /orgs/:orgId/billing/checkout {plan_id, provider}`
2. The server inserts a `payments` row with status `pending`, then asks PayPal for a checkout link
3. The payer approves on PayPal's own pages
4. On return, `/billing-return.html` calls the capture endpoint; the webhook independently
   verifies its signature, then `activate_paid_plan()` runs and the plan takes effect immediately
5. The return page polls the transaction status a few times and reports the outcome

Capture and webhook are two routes to the same result on purpose: capture handles the normal
case, and the webhook covers a payer who closes the tab mid-way.

### Four safety measures

**1. The amount is always computed on the server.** The browser only ever sends `plan_id` and
`provider`. An `amount` in the request body is ignored.

**2. Webhook signatures are verified.** Verification goes through PayPal's own
`verify-webhook-signature` API, which is why the webhook route is mounted **before**
`express.json()` in `src/index.js` and uses `express.raw()`: PayPal checks the signature
against the request body verbatim, and re-serializing a parsed object can reorder keys or
change how numbers are written.

**3. The amount is reconciled.** A webhook reporting an amount that differs from the order by
more than a cent is ignored and logged at `error` level.

**4. A plan cannot be extended twice.** Gateways retry webhooks on a flaky connection, so
there are three layers: an application-level guard (`payments.paid_at`), a guard inside the
SQL function `activate_paid_plan()` (which locks the row with `for update`), and `unique`
constraints on `order_code` and on `(provider, provider_ref)`. `paid_at` is the single marker
for "already handled", because that column is only ever written inside that SQL function.

If the current plan has time left on it, the remaining time is **added** rather than lost.

### Not built yet

- **No recurring billing.** The customer has to pay again each period.
- **No invoicing.** Selling to companies at scale needs an invoicing integration.
- **No refunds in the interface.** Refunds have to be issued from PayPal directly.

---

## 11. OCR for scanned PDFs

When a PDF is uploaded the real text layer is read first. If that yields fewer than roughly
60 characters per page, the file is treated as a scan and handed to Gemini.

How it works:

1. `pdf-lib` splits the file into batches of `OCR_PAGES_PER_BATCH` pages (5 by default). Pure
   JS, no native libraries.
2. Each batch is sent as a PDF straight to `generativelanguage.googleapis.com` — there is
   **no** page-to-image rendering step, which is what keeps the Render deploy a plain Node
   service with no Docker image.
3. The recognized text is reassembled and continues through the normal chunking and embedding
   pipeline.
4. Transient failures are retried in three tiers, described below.

### Surviving "model is overloaded"

Gemini frequently returns 503 *"This model is currently experiencing high demand"* at peak
hours. Three tiers handle it:

**Tier 1 — switch model.** When the primary model reports an overload, the next model in
`GEMINI_OCR_MODELS` is tried immediately. Overload tends to hit individual models, so a
lighter one usually still answers — this tier normally resolves the problem with no waiting
at all.

**Tier 2 — exponential backoff with jitter.** If the whole model chain is busy, wait
1s -> 2s -> 4s -> 8s and so on, capped at `OCR_RETRY_MAX_MS` (60s) with a random spread so
that concurrent processes do not all retry in lockstep, for up to `OCR_RETRY_ROUNDS` rounds.
This is Google's own documented recommendation.

**Tier 3 — reschedule the whole document.** If the overload persists, the document moves to
**Waiting to retry** and reschedules itself after 2 -> 5 -> 10 minutes, up to `OCR_DOC_RETRIES`
times. The interface shows when the next attempt is due, and the administrator can still
press "Retry now".

**Finished work is never redone.** Each successfully recognized batch is stored in
`document_ocr_batches`. A retry only calls Gemini for the batches still missing, which saves
both time and quota. The cache is cleared once the document completes.

Errors that are *not* transient — a bad API key, a malformed request, a blocked document —
fail immediately rather than burning retries.

A document being recognized shows as **Processing** (or **Waiting to retry**) in the
organization admin console, and the number of recognized pages is written to
`documents.ocr_pages` for quota accounting.

**Per-plan quota** (`plans.max_ocr_pages_per_month`, editable in `/sysadmin.html`):
trial 0 pages (OCR is off) · Professional 2,000 · Business 20,000.

**Queueing**: OCR runs sequentially (`WORKER_CONCURRENCY=1`) because Render Free has only
512 MB of RAM. Several files uploaded at once queue rather than running in parallel. Queue
depth is visible on the System health page. With real customers, move this to a dedicated
Background Worker on Render.

---


## 12. Answer language

The chatbot answers in the language the question was asked in, even when the
documents it is quoting are written in another language. A Vietnamese question
about an English handbook comes back in Vietnamese.

How it is decided, in order:

1. If `BOT_REPLY_LANGUAGE` names a language, that language always wins and no
   detection runs at all.
2. Otherwise `src/language.js` inspects the question. Distinctive scripts
   (Vietnamese, Chinese, Japanese, Korean, Thai, Arabic, Hebrew, Greek, Hindi,
   Russian) are recognised on sight. Latin-script languages are identified from
   function words, which also catches Vietnamese typed without tone marks.
   When a language is recognised, the system prompt names it explicitly.
3. If detection is not confident, the system prompt simply instructs the model
   to mirror the question's language.

Naming the language explicitly matters: the retrieved documents sit in the same
prompt, and without an explicit instruction the model tends to drift towards
their language rather than the reader's.

Detection stays silent rather than guessing. `Café résumé` inside an English
sentence, a two-word fragment, or a string of acronyms all fall through to
step 3 instead of picking a language on thin evidence.

The "nothing relevant found" reply never reaches the model at all, so it is
translated in `src/language.js` for every language detection can name, and
falls back to English otherwise.

## 13. Troubleshooting

**The system health page.** `/sysadmin.html` -> **System health** probes every dependency:
Supabase, Cloudflare R2, Voyage AI, DeepSeek, Gemini (each model in the fallback chain), the
payment gateway, and `APP_BASE_URL`. Start here.

**Scanned PDFs fail.** Check the Gemini row on that page. "Not configured" means
`GEMINI_API_KEY` is missing. If a document was blocked by a quota instead, the reason is
spelled out in the status column of the organization admin's Documents page. Remember the
trial plan has OCR switched off entirely.

**PayPal says "Client Authentication failed".** Almost always `PAYPAL_ENV`. See the warning in
step 2. The health page will tell you outright when the credentials work in the other
environment.

**`APP_BASE_URL` shows a warning.** The health page compares the configured value against the
address the request actually arrived on. A mismatch breaks the post-checkout return links.
Leaving it unset makes the app guess from the request, which works until the domain changes.

**Document names show mojibake** (`Quy dinh` rendered as garbage characters). multer 1.x reads
the filename out of the multipart header as latin-1, and macOS sends names in NFD form with
combining marks split off. This is handled in `src/utils/filename.js`: the display name is
decoded again and normalized to NFC, while the R2 object key uses a plain ASCII form so URL
signing stays safe.

Documents uploaded **before** that fix keep the broken name in the database. To repair them:
`/sysadmin.html` -> **System health** -> **Data maintenance** -> "Preview" then "Fix document
names". That is `POST /admin/maintenance/fix-filenames`; add `?dry_run=1` to preview only.

---

## 14. Known limitations

- **Documents are processed inside the web process.** Very large files can time out on Render
  Free. With real customers, split this into a dedicated worker.
- **OCR is capped at 30 pages per file** (`OCR_MAX_PAGES`). Longer files have to be split. The
  cap is deliberate: OCR is billed per page and is slow.
- **Invitations are plain links.** The system generates an invite link for the administrator to
  send by hand; no email service is wired up.
- **No recurring billing.** Each period has to be paid for explicitly.
- **Supabase Free pauses a project after 7 days of inactivity.**
