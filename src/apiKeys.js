import crypto from 'crypto';
import { supabase } from './supabaseClient.js';
import { logEvent } from './logger.js';

/**
 * API key handling.
 *
 * These keys live in customers' own servers, CI configuration and — for a
 * public-facing chatbot — sometimes closer to the edge than anyone intends.
 * Two assumptions follow from that and shape everything here:
 *
 *   1. A key will leak eventually, so a leaked key must be cheap to revoke and
 *      must never reach further than the folders it was given.
 *   2. Our own database may be read by someone who should not read it, so the
 *      key itself is never stored — only a hash, the same way a password is.
 */

const PREFIX = 'bck_';        // BotClarify key. Recognisable in a leak scan.
const VISIBLE = 10;           // characters shown in the interface, e.g. bck_a1b2c3

/**
 * Generate a key. Returned ONCE, to the person who asked for it, and never
 * again: only the hash goes to the database.
 */
export function generateKey() {
  // 32 random bytes, base64url. Guessing one is not a threat model anybody
  // needs to think about again.
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `${PREFIX}${secret}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, VISIBLE) };
}

/**
 * SHA-256, not bcrypt or argon2.
 *
 * A password is short, human-chosen and worth grinding through a dictionary,
 * which is why it needs a slow hash. This key is 256 bits of randomness: there
 * is no dictionary, and a slow hash would only mean every API call pays for a
 * key-derivation function. The property we need is that the stored value does
 * not reveal the key, and a plain digest of a high-entropy secret gives that.
 */
export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

/**
 * Pull the key out of the request.
 *
 * Authorization: Bearer <key> is the form the documentation teaches. The
 * x-api-key header is accepted too because some HTTP clients and no-code tools
 * make a custom header far easier than an Authorization one, and a customer
 * fighting their tooling is a customer who gives up.
 *
 * A key is never read from the query string: URLs end up in server logs, proxy
 * logs, browser history and Referer headers.
 */
export function readKey(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) return bearer[1].trim();
  const header = req.headers['x-api-key'];
  if (header) return String(header).trim();
  return null;
}

/** One shape for every API error, so a client can switch on `code`. */
export function apiError(res, status, code, message, extra = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

/**
 * Authenticate a request, and decide what it may reach.
 *
 * On success the request carries:
 *   req.apiKey        the key row (never the key itself)
 *   req.org           the organization, with its plan
 *   req.apiScope      { folderIds: string[] | null } — null means every folder
 *   req.apiQuota      { used, limit }
 */
export async function requireApiKey(req, res, next) {
  const started = Date.now();
  const presented = readKey(req);

  if (!presented) {
    return apiError(res, 401, 'missing_key',
      'Send your API key as "Authorization: Bearer bck_...". Create one in Plan & billing → API.');
  }

  // Looked up by hash. The key as typed is never compared against anything
  // stored, because nothing stored is the key.
  const { data: key, error } = await supabase
    .from('api_keys')
    .select('*, organization:organizations(id, name, status, billing_status, plan_expires_at, plan:plans(*))')
    .eq('key_hash', hashKey(presented))
    .maybeSingle();

  // One message for "no such key" and for "revoked key". Distinguishing them
  // tells whoever is holding a stolen key whether it was ever real.
  if (error || !key || key.revoked_at) {
    return apiError(res, 401, 'invalid_key', 'This API key is not valid. It may have been revoked.');
  }
  if (key.expires_at && new Date(key.expires_at) <= new Date()) {
    return apiError(res, 401, 'expired_key', 'This API key has expired. Create a new one in Plan & billing → API.');
  }

  const org = key.organization;
  if (!org) {
    return apiError(res, 401, 'invalid_key', 'This API key is not valid. It may have been revoked.');
  }
  if (org.status === 'suspended') {
    return apiError(res, 403, 'organization_suspended', 'This organization is suspended. Contact your administrator.');
  }

  const plan = org.plan;
  if (!plan?.api_enabled) {
    return apiError(res, 403, 'api_not_in_plan',
      `The ${plan?.name || 'current'} plan does not include API access. Upgrade at https://botclarify.com/#pricing.`);
  }

  // An expired subscription stops the API the same way it stops the interface.
  // Checked here rather than trusting billing_status alone, because that column
  // is only updated when a payment arrives, not when time runs out.
  const expired = org.plan_expires_at && new Date(org.plan_expires_at) <= new Date();
  if (org.billing_status !== 'paid' || expired) {
    return apiError(res, 402, 'subscription_inactive',
      'This organization does not have an active subscription.');
  }

  const limit = Number(plan.max_api_calls_per_month || 0);

  // THE COUNT IS TAKEN BEFORE THE WORK, and the row that carries it is written
  // in the same statement that reads the total.
  //
  // Reading the count and then acting on it left every concurrent request
  // looking at the same stale number: with an allowance of 5, sixty parallel
  // calls got 22 answers through. Reserving first makes each request visible to
  // the others the moment it starts.
  const { data: reserved, error: reserveError } = await supabase.rpc('reserve_api_call', {
    p_org_id: org.id,
    p_key_id: key.id,
    p_endpoint: `${req.method} ${req.path}`.slice(0, 120),
  });
  if (reserveError) {
    console.error('[api] could not reserve a call:', reserveError.message);
    return apiError(res, 500, 'internal_error', 'The request could not be completed. Please try again.');
  }
  const row = Array.isArray(reserved) ? reserved[0] : reserved;
  const usageId = row?.usage_id ?? null;
  const usedCount = Number(row?.calls_used || 0);

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - usedCount)));
  res.setHeader('X-RateLimit-Reset', nextMonthIso());

  // A plan that sells the API with an allowance of zero refuses everything.
  // "limit > 0 &&" used to guard this comparison, which quietly made zero mean
  // UNLIMITED — the opposite of what the column says and of what the console
  // promises when it warns about setting it.
  if (usedCount > limit) {
    // The refusal itself is not charged for.
    await finishCall(usageId, 429, Date.now() - started);
    return apiError(res, 429, 'quota_exceeded',
      limit > 0
        ? `This organization has used all ${limit.toLocaleString('en-US')} API calls included this month. The allowance resets on the 1st.`
        : 'This organization\'s plan includes no API calls. Ask your administrator to review the plan.',
      { limit, used: usedCount - 1 });
  }

  req.apiKey = key;
  req.org = { ...org, plan };
  // An array — even an empty one — means the key was deliberately scoped, so it
  // is honoured as written. Treating an empty array as "every folder" turned a
  // restricted key into an unrestricted one; the database now forbids the state
  // as well, but the reader must not be the thing that depends on that.
  req.apiScope = { folderIds: Array.isArray(key.folder_ids) ? key.folder_ids : null };
  req.apiQuota = { used: usedCount - 1, limit };
  req.apiStartedAt = started;
  req.apiUsageId = usageId;

  next();
}

function nextMonthIso() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Write the outcome onto the reserved row. Never throws: a failure to record
 * must not fail the call the customer paid for.
 */
export async function finishCall(usageId, status, durationMs) {
  if (!usageId) return;
  try {
    await supabase.rpc('finish_api_call', {
      p_usage_id: usageId,
      p_status: status,
      p_duration: durationMs ?? null,
    });
  } catch (err) {
    console.error('[api] could not finish usage row:', err.message);
  }
}

/**
 * Close out every answer, whatever it turned out to be.
 *
 * Both 'finish' and 'close' are listened for. 'finish' alone misses a client
 * that hangs up before the response is written — Node emits only 'close' then —
 * and that path had already paid for the embedding, the search and the model.
 * A caller that fired requests and disconnected got the expensive part of the
 * product for nothing.
 */
export function meterApiCalls(req, res, next) {
  if (!req.apiUsageId) return next();
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    // A client that vanished never received an answer, so the status line is
    // meaningless; 499 is the conventional marker for it and keeps the call
    // counted, because the work was still done.
    const status = res.writableFinished ? res.statusCode : 499;
    finishCall(req.apiUsageId, status, Date.now() - (req.apiStartedAt || Date.now()));
  };
  res.on('finish', settle);
  res.on('close', settle);
  next();
}

/**
 * Narrow the folders a request may read to the key's scope.
 *
 * Takes the folder ids the organization's ACL already worked out and INTERSECTS
 * them with the key's own list — never replaces them. A key naming a folder
 * that has since been deleted, or one belonging to another organization, gains
 * nothing from saying so: the intersection can only ever shrink the set.
 */
export function scopeFolders(allowedIds, scope) {
  if (!scope?.folderIds) return { ids: allowedIds, includeUnfiled: true };
  const wanted = new Set(scope.folderIds.map(String));
  return {
    ids: allowedIds.filter((id) => wanted.has(String(id))),
    // A scoped key was pointed at particular folders, so documents filed
    // nowhere are outside what it was given.
    includeUnfiled: false,
  };
}

export async function logKeyEvent(orgId, userId, message, detail) {
  await logEvent({ scope: 'api', organizationId: orgId, userId, message, detail });
}
