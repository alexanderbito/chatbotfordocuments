/**
 * Regression suite for the public API.
 *
 * A key here is a credential a customer will paste into a CI file, a serverless
 * function and eventually a public repository. The tests are written around
 * what happens when one ends up somewhere it should not: they spend their time
 * on isolation between customers, on the folder scope holding, and on the key
 * never being recoverable from anything we store.
 *
 * Run:  node scripts/apitest.mjs      (from the repository root)
 */
import http from 'http';
import assert from 'assert';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------
// A stand-in Supabase, spoken to over HTTP by the real supabase-js client, so
// the query builder and its filters are genuinely exercised.
// ---------------------------------------------------------------------
const DB = { api_keys: [], api_usage: [], folders: [], documents: [], organizations: [], system_logs: [] };
const rpcCalls = [];

// Embedding and answer generation are stubbed at the module level further down;
// these record what the search was asked for.
export const searches = [];

function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}

function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(key)) continue;
    const [op, ...rest] = String(raw).split('.');
    const value = rest.join('.');
    if (op === 'eq') out = out.filter((r) => String(r[key] ?? '') === value);
    else if (op === 'lt') out = out.filter((r) => Number(r[key]) < Number(value));
    else if (op === 'gte') out = out.filter((r) => String(r[key] ?? '') >= value);
    else if (op === 'is') out = out.filter((r) => (value === 'null' ? r[key] == null : r[key] != null));
    else if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      out = out.filter((r) => list.includes(String(r[key])));
    }
  }
  // The documents endpoint uses one `or` for "in these folders OR unfiled".
  const or = params.get('or');
  if (or) {
    const parts = or.replace(/^\(|\)$/g, '').split(/,(?![^(]*\))/);
    out = out.filter((r) => parts.some((p) => {
      const [col, op, ...rest] = p.split('.');
      const val = rest.join('.');
      if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(r[col]));
      if (op === 'is') return val === 'null' ? r[col] == null : r[col] != null;
      return false;
    }));
  }
  return out;
}

const supa = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');
  const send = (code, data, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };

  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.replace('/rest/v1/rpc/', '');
    const args = JSON.parse(body || '{}');
    rpcCalls.push({ fn, args });

    const countFor = (org) => DB.api_usage.filter((u) => u.organization_id === org && u.status < 400).length;

    if (fn === 'api_calls_this_month') return send(200, countFor(args.p_org_id));

    // Mirrors the SQL: the row is written and the total read in one step, so
    // two requests in flight see each other.
    if (fn === 'reserve_api_call') {
      const id = DB.api_usage.length + 1;
      DB.api_usage.push({
        id, organization_id: args.p_org_id, api_key_id: args.p_key_id,
        endpoint: args.p_endpoint, status: 0, created_at: new Date().toISOString(),
      });
      const k = DB.api_keys.find((x) => x.id === args.p_key_id);
      if (k) k.last_used_at = new Date().toISOString();
      return send(200, [{ usage_id: id, calls_used: countFor(args.p_org_id) }]);
    }
    if (fn === 'finish_api_call') {
      const row = DB.api_usage.find((u) => u.id === args.p_usage_id);
      if (row) { row.status = args.p_status; row.duration_ms = args.p_duration; }
      return send(200, null);
    }
    if (fn === 'api_calls_by_key_this_month') {
      const per = {};
      for (const u of DB.api_usage) {
        if (u.organization_id !== args.p_org_id || u.status >= 400 || !u.api_key_id) continue;
        per[u.api_key_id] = (per[u.api_key_id] || 0) + 1;
      }
      return send(200, Object.entries(per).map(([api_key_id, calls]) => ({ api_key_id, calls })));
    }
    if (fn === 'match_document_chunks_acl') {
      searches.push(args);
      const allowed = new Set((args.allowed_folder_ids || []).map(String));
      const hits = DB.documents.filter((d) =>
        d.organization_id === args.match_org_id
        && (d.folder_id == null ? args.include_unfiled : allowed.has(String(d.folder_id))));
      return send(200, hits.map((d) => ({ document_id: d.id, content: d.content || `text of ${d.filename}`, similarity: 0.9 })));
    }
    return send(200, null);
  }

  const table = url.pathname.replace('/rest/v1/', '');
  if (!DB[table]) DB[table] = [];

  if (req.method === 'POST') {
    const row = JSON.parse(body);
    const saved = { id: row.id || `row-${DB[table].length + 1}`, created_at: new Date().toISOString(), ...row };
    DB[table].push(saved);
    return send(201, wantsObject ? saved : [saved]);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    let rows = applyFilters(DB[table], url.searchParams);
    // Joins written as plan:plans(*) / organization:organizations(...)
    const select = url.searchParams.get('select') || '';
    if (table === 'api_keys' && /organization:organizations/.test(select)) {
      rows = rows.map((k) => {
        const org = DB.organizations.find((o) => o.id === k.organization_id);
        return { ...k, organization: org ? { ...org, plan: org.plan } : null };
      });
    }
    if (req.method === 'HEAD' || /exact/.test(req.headers.prefer || '')) {
      res.writeHead(200, { 'Content-Range': `0-0/${rows.length}`, 'Content-Type': 'application/json' });
      return res.end(req.method === 'HEAD' ? '' : JSON.stringify(rows));
    }
    return send(200, wantsObject ? rows[0] ?? null : rows);
  }
  if (req.method === 'PATCH') {
    const rows = applyFilters(DB[table], url.searchParams);
    for (const r of rows) Object.assign(r, JSON.parse(body));
    return send(200, wantsObject ? rows[0] ?? null : rows);
  }
  return send(200, []);
});

await new Promise((r) => supa.listen(4741, r));

// ---------------------------------------------------------------------
// Stand-ins for the embedding service and the model.
//
// Neither is what this suite is about, and calling the real ones would make it
// slow, costly and dependent on the network. Both modules already read their
// base URL from the environment, so they are pointed here instead of being
// monkey-patched — which means the real client libraries, their retries and
// their response parsing are all still exercised.
//
// What the model is GIVEN is recorded, because that is worth asserting on: an
// answer must only ever be built from chunks the key was allowed to reach.
// ---------------------------------------------------------------------
export const answered = [];

const upstream = http.createServer(async (req, res) => {
  const body = await readBody(req);
  res.setHeader('Content-Type', 'application/json');

  if (req.url.includes('/embeddings') && req.url.includes('voyage')) {
    // handled below by path; kept for clarity
  }
  if (req.url.includes('/chat/completions')) {
    const payload = JSON.parse(body || '{}');
    answered.push(payload);
    return res.end(JSON.stringify({
      id: 'stub', object: 'chat.completion', created: Date.now(), model: 'stub',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Stub answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  }
  if (req.url.includes('/embeddings')) {
    return res.end(JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: Array(1024).fill(0.01) }],
      model: 'stub', usage: { total_tokens: 1 },
    }));
  }
  res.end(JSON.stringify({}));
});
await new Promise((r) => upstream.listen(4743, r));

process.env.SUPABASE_URL = 'http://127.0.0.1:4741';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.VOYAGE_API_KEY = 'test';
process.env.VOYAGE_BASE_URL = 'http://127.0.0.1:4743/v1';
process.env.DEEPSEEK_API_KEY = 'test';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:4743/v1';

const { default: express } = await import('express');
const v1Source = await import('../src/routes/v1.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/v1', v1Source.default);
const server = app.listen(4742);
await new Promise((r) => server.once('listening', r));

const { hashKey, generateKey, scopeFolders } = await import('../src/apiKeys.js');

const BASE = 'http://127.0.0.1:4742/v1';

/**
 * Wait for the metering to land.
 *
 * A call is counted from res.on('finish'), i.e. AFTER the answer has gone out,
 * deliberately: a customer should not wait on our bookkeeping, and a jammed
 * meter must not swallow an answer they paid for. The consequence is that the
 * usage row arrives a moment after fetch() resolves, so a test asserting on it
 * has to wait rather than assume.
 */
async function settle(timeoutMs = 1000) {
  const started = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
    if (DB.api_usage.length === last) { if (++stable >= 3) return; }
    else { last = DB.api_usage.length; stable = 0; }
  }
}

async function call(path, { key, method = 'GET', body } = {}) {
  const headers = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

// ---------------------------------------------------------------------
// Fixtures: two organizations, so isolation can be tested rather than assumed.
// ---------------------------------------------------------------------
const PLAN_API = { id: 'p-biz', name: 'Business', api_enabled: true, max_api_calls_per_month: 100 };
const PLAN_NO_API = { id: 'p-pro', name: 'Professional', api_enabled: false, max_api_calls_per_month: 0 };

function seed() {
  for (const k of Object.keys(DB)) DB[k] = [];
  searches.length = 0; rpcCalls.length = 0;

  DB.organizations.push(
    { id: 'org-a', name: 'Acme', status: 'active', billing_status: 'paid', plan_expires_at: '2099-01-01T00:00:00Z', plan: PLAN_API },
    { id: 'org-b', name: 'Globex', status: 'active', billing_status: 'paid', plan_expires_at: '2099-01-01T00:00:00Z', plan: PLAN_API },
    { id: 'org-c', name: 'Initech', status: 'active', billing_status: 'paid', plan_expires_at: '2099-01-01T00:00:00Z', plan: PLAN_NO_API },
  );
  DB.folders.push(
    { id: 'f-public', organization_id: 'org-a', name: 'Handbook', visibility: 'public' },
    { id: 'f-secret', organization_id: 'org-a', name: 'Contracts', visibility: 'private' },
    { id: 'f-other', organization_id: 'org-b', name: 'Globex docs', visibility: 'public' },
  );
  DB.documents.push(
    { id: 'd-public', organization_id: 'org-a', folder_id: 'f-public', filename: 'handbook.pdf', status: 'ready', content: 'Annual leave is 20 days.' },
    { id: 'd-secret', organization_id: 'org-a', folder_id: 'f-secret', filename: 'salaries.xlsx', status: 'ready', content: 'The CEO earns 500000.' },
    { id: 'd-unfiled', organization_id: 'org-a', folder_id: null, filename: 'notes.txt', status: 'ready', content: 'Loose notes.' },
    { id: 'd-other', organization_id: 'org-b', folder_id: 'f-other', filename: 'globex.pdf', status: 'ready', content: 'Globex secret plans.' },
  );
}

function addKey({ id, org, folders = null, revoked = false, expires = null, plan }) {
  const { key, hash, prefix } = generateKey();
  DB.api_keys.push({
    id, organization_id: org, name: id, key_hash: hash, key_prefix: prefix,
    folder_ids: folders, created_at: new Date().toISOString(),
    revoked_at: revoked ? new Date().toISOString() : null, expires_at: expires,
  });
  if (plan) DB.organizations.find((o) => o.id === org).plan = plan;
  return key;
}

let pass = 0, fail = 0;
async function test(name, fn) {
  // Let any metering from the previous test land before wiping the tables,
  // otherwise its row turns up in the middle of this one.
  await settle(300);
  seed();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('\nKhoá không bao giờ lưu dạng thô');

await test('the generated key is never what is stored', () => {
  const { key, hash, prefix } = generateKey();
  assert.ok(key.startsWith('bck_'), 'khoá không có tiền tố nhận dạng');
  assert.ok(key.length > 40, 'khoá quá ngắn');
  assert.notStrictEqual(hash, key);
  assert.ok(!hash.includes(key.slice(4)), 'phần bí mật xuất hiện trong bản băm');
  assert.strictEqual(hash, crypto.createHash('sha256').update(key).digest('hex'));
  // The prefix is short enough that it cannot be brute-forced back to the key.
  assert.ok(key.startsWith(prefix) && prefix.length <= 12);
});

await test('two keys never collide', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generateKey().hash);
  assert.strictEqual(seen.size, 500);
});

console.log('\nXác thực');

await test('no key at all is refused', async () => {
  const r = await call('/me');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error.code, 'missing_key');
});

await test('a made-up key is refused', async () => {
  addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/me', { key: 'bck_totally-made-up' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error.code, 'invalid_key');
});

await test('a revoked key stops working immediately', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', revoked: true });
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error.code, 'invalid_key');
});

await test('a revoked key is not distinguishable from a fake one', async () => {
  // Telling them apart would confirm to whoever holds a stolen key that it was
  // once real, and roughly when it was cut off.
  const revoked = addKey({ id: 'k1', org: 'org-a', revoked: true });
  const a = await call('/me', { key: revoked });
  const b = await call('/me', { key: 'bck_never-existed' });
  assert.deepStrictEqual(a.data, b.data);
  assert.strictEqual(a.status, b.status);
});

await test('an expired key is refused', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', expires: '2020-01-01T00:00:00Z' });
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error.code, 'expired_key');
});

await test('a key is accepted from the x-api-key header too', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const res = await fetch(BASE + '/me', { headers: { 'x-api-key': key } });
  assert.strictEqual(res.status, 200);
});

await test('a key in the query string is NOT accepted', async () => {
  // URLs reach server logs, proxy logs and Referer headers.
  const key = addKey({ id: 'k1', org: 'org-a' });
  const res = await fetch(`${BASE}/me?api_key=${encodeURIComponent(key)}`);
  assert.strictEqual(res.status, 401);
});

console.log('\nGói và hạn mức');

await test('a plan without the API is refused, and says so', async () => {
  const key = addKey({ id: 'k1', org: 'org-c' });
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error.code, 'api_not_in_plan');
});

await test('an unpaid organization is refused', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  DB.organizations.find((o) => o.id === 'org-a').billing_status = 'overdue';
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 402);
  assert.strictEqual(r.data.error.code, 'subscription_inactive');
});

await test('an expired subscription is refused even while billing_status says paid', async () => {
  // billing_status is written when a payment arrives, never when time runs out.
  const key = addKey({ id: 'k1', org: 'org-a' });
  DB.organizations.find((o) => o.id === 'org-a').plan_expires_at = '2020-01-01T00:00:00Z';
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 402);
});

await test('a suspended organization is refused', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  DB.organizations.find((o) => o.id === 'org-a').status = 'suspended';
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error.code, 'organization_suspended');
});

await test('the monthly allowance is enforced', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  DB.organizations.find((o) => o.id === 'org-a').plan = { ...PLAN_API, max_api_calls_per_month: 3 };
  for (let i = 0; i < 3; i++) {
    const r = await call('/me', { key });
    assert.strictEqual(r.status, 200, `lần ${i + 1} lẽ ra phải qua`);
  }
  const blocked = await call('/me', { key });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.data.error.code, 'quota_exceeded');
});

await test('one organization using its allowance does not affect another', async () => {
  const a = addKey({ id: 'k1', org: 'org-a' });
  const b = addKey({ id: 'k2', org: 'org-b' });
  DB.organizations.find((o) => o.id === 'org-a').plan = { ...PLAN_API, max_api_calls_per_month: 2 };
  await call('/me', { key: a }); await call('/me', { key: a });
  assert.strictEqual((await call('/me', { key: a })).status, 429);
  assert.strictEqual((await call('/me', { key: b })).status, 200);
});

await test('the rate headers are present and count down', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const first = await call('/me', { key });
  assert.strictEqual(first.headers.get('x-ratelimit-limit'), '100');
  assert.strictEqual(first.headers.get('x-ratelimit-remaining'), '99');
  const second = await call('/me', { key });
  assert.strictEqual(second.headers.get('x-ratelimit-remaining'), '98');
  assert.ok(second.headers.get('x-ratelimit-reset'), 'thiếu thời điểm đặt lại');
});

await test('a plan with the API on and an allowance of 0 refuses every call', async () => {
  // "limit > 0 &&" in front of the comparison used to make zero mean UNLIMITED,
  // which is the opposite of what the column says and of what the console
  // warns about when an admin sets it.
  const key = addKey({ id: 'k1', org: 'org-a' });
  DB.organizations.find((o) => o.id === 'org-a').plan = { ...PLAN_API, max_api_calls_per_month: 0 };
  const r = await call('/me', { key });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.data.error.code, 'quota_exceeded');
});

await test('concurrent calls cannot overshoot the allowance', async () => {
  // THE bug this test exists for. Reading the count and then acting on it left
  // every request in flight looking at the same stale number: with an allowance
  // of 5, sixty parallel calls got 22 answers through.
  const key = addKey({ id: 'k1', org: 'org-a' });
  DB.organizations.find((o) => o.id === 'org-a').plan = { ...PLAN_API, max_api_calls_per_month: 5 };
  const results = await Promise.all(Array.from({ length: 40 }, () => call('/me', { key })));
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(ok <= 5, `cho qua ${ok} lượt trong khi hạn mức là 5`);
  assert.ok(ok >= 1, 'chặn sạch cả những lượt đầu tiên');
});

await test('a rejected key costs the organization nothing', async () => {
  // Otherwise a leaked-and-revoked key being retried by somebody else's script
  // would burn the customer's allowance.
  addKey({ id: 'k1', org: 'org-a' });
  for (let i = 0; i < 10; i++) await call('/me', { key: 'bck_wrong' });
  await settle(300);
  assert.strictEqual(DB.api_usage.length, 0);
});

console.log('\nCô lập giữa các doanh nghiệp');

await test("a key never reaches another organization's documents", async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'What are the plans?' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(searches.at(-1).match_org_id, 'org-a');
  const names = r.data.sources.map((s) => s.filename);
  assert.ok(!names.includes('globex.pdf'), 'lọt tài liệu của doanh nghiệp khác');
});

await test("a key cannot name another organization's folder", async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'Anything?', folder_ids: ['f-other'] } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error.code, 'folder_not_allowed');
});

await test('the documents list is confined to one organization', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/documents', { key });
  assert.strictEqual(r.status, 200);
  const ids = r.data.documents.map((d) => d.id);
  assert.ok(!ids.includes('d-other'), 'lọt tài liệu của doanh nghiệp khác');
});

await test('the folder list is confined to one organization', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/folders', { key });
  const ids = r.data.folders.map((f) => f.id);
  assert.ok(!ids.includes('f-other'));
  assert.ok(ids.includes('f-public') && ids.includes('f-secret'));
});

console.log('\nPhạm vi thư mục của khoá');

await test('a scoped key only searches its own folders', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-public'] });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'How much leave?' } });
  assert.strictEqual(r.status, 200);
  const search = searches.at(-1);
  assert.deepStrictEqual(search.allowed_folder_ids, ['f-public']);
  assert.strictEqual(search.include_unfiled, false, 'khoá giới hạn vẫn đọc tài liệu chưa xếp thư mục');
  const names = r.data.sources.map((s) => s.filename);
  assert.ok(!names.includes('salaries.xlsx'), 'khoá giới hạn đọc được thư mục kín');
  assert.ok(!names.includes('notes.txt'), 'khoá giới hạn đọc được tài liệu chưa xếp thư mục');
});

await test('a scoped key cannot widen itself by asking', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-public'] });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'Salaries?', folder_ids: ['f-secret'] } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error.code, 'folder_not_allowed');
  assert.deepStrictEqual(r.data.error.denied, ['f-secret']);
});

await test('a scoped key sees only its folders in the folder list', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-public'] });
  const r = await call('/folders', { key });
  assert.deepStrictEqual(r.data.folders.map((f) => f.id), ['f-public']);
  assert.strictEqual(r.data.scoped, true);
});

await test('a scoped key sees only its folders in the document list', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-public'] });
  const r = await call('/documents', { key });
  const ids = r.data.documents.map((d) => d.id);
  assert.deepStrictEqual(ids, ['d-public']);
});

await test('a scoped key is refused a document list for a folder outside its scope', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-public'] });
  const r = await call('/documents?folder_id=f-secret', { key });
  assert.strictEqual(r.status, 403);
});

await test('an unscoped key reaches everything in its own organization', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/documents', { key });
  const ids = r.data.documents.map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ['d-public', 'd-secret', 'd-unfiled']);
});

await test('an empty folder scope reads nothing, not everything', async () => {
  // A stored [] is neither "these folders" nor "all folders", and the reader
  // used to resolve it as "all" — turning a restricted key into an
  // unrestricted one. The database now forbids the state too, but the reader
  // must not be the thing that depends on that.
  const key = addKey({ id: 'k1', org: 'org-a', folders: [] });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'Anything at all?' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error.code, 'no_folders_in_scope');

  const docs = await call('/documents', { key });
  assert.deepStrictEqual(docs.data.documents, [], 'khoá phạm vi rỗng vẫn liệt kê được tài liệu');

  const me = await call('/me', { key });
  assert.deepStrictEqual(me.data.key.scoped_to_folders, [], 'khoá phạm vi rỗng tự báo là không giới hạn');
});

await test('scopeFolders can only ever shrink the set', () => {
  // Named folders that do not exist, or belong elsewhere, must add nothing.
  const all = ['a', 'b'];
  assert.deepStrictEqual(scopeFolders(all, { folderIds: null }).ids, all);
  assert.deepStrictEqual(scopeFolders(all, { folderIds: ['a'] }).ids, ['a']);
  assert.deepStrictEqual(scopeFolders(all, { folderIds: ['a', 'zzz'] }).ids, ['a']);
  assert.deepStrictEqual(scopeFolders(all, { folderIds: ['zzz'] }).ids, []);
  // An empty list is a list, not an absence of one.
  assert.deepStrictEqual(scopeFolders(all, { folderIds: [] }).ids, []);
  assert.strictEqual(scopeFolders(all, { folderIds: [] }).includeUnfiled, false);
});

await test('a key scoped to folders that were all deleted answers nothing', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-gone'] });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'Anything?' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error.code, 'no_folders_in_scope');
});

console.log('\nHình dạng yêu cầu và câu trả lời');

await test('an empty question is refused', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/chat', { key, method: 'POST', body: { question: '   ' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error.code, 'missing_question');
});

await test('an enormous question is refused rather than sent to the model', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const before = searches.length;
  const r = await call('/chat', { key, method: 'POST', body: { question: 'x'.repeat(5000) } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error.code, 'question_too_long');
  assert.strictEqual(searches.length, before, 'vẫn gọi tìm kiếm dù câu hỏi quá dài');
});

await test('sources carry both the id and the filename', async () => {
  const key = addKey({ id: 'k1', org: 'org-a', folders: ['f-public'] });
  const r = await call('/chat', { key, method: 'POST', body: { question: 'Leave?' } });
  assert.ok(r.data.sources.length > 0);
  for (const s of r.data.sources) {
    assert.ok(s.document_id && s.filename, `nguồn thiếu trường: ${JSON.stringify(s)}`);
  }
});

await test('every error carries a stable code', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const cases = [
    await call('/me'),
    await call('/me', { key: 'bck_x' }),
    await call('/chat', { key, method: 'POST', body: {} }),
    await call('/nope', { key }),
  ];
  for (const c of cases) {
    assert.ok(c.data.error?.code, `thiếu mã lỗi: ${JSON.stringify(c.data)}`);
    assert.ok(c.data.error?.message, 'thiếu lời giải thích');
  }
});

await test('an unknown endpoint answers JSON, not an HTML page', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/does-not-exist', { key });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.data.error.code, 'unknown_endpoint');
});

await test('/me never returns the key or its hash', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  const r = await call('/me', { key });
  const body = JSON.stringify(r.data);
  assert.ok(!body.includes(key), 'khoá bị trả về trong câu trả lời');
  assert.ok(!body.includes(hashKey(key)), 'bản băm bị trả về trong câu trả lời');
  assert.ok(!/key_hash/.test(body), 'trường key_hash bị lộ');
});

await test('no CORS header is sent, so a browser cannot use a key', async () => {
  // A key a browser can send is a key that is already public.
  const key = addKey({ id: 'k1', org: 'org-a' });
  const res = await fetch(BASE + '/me', { headers: { Authorization: `Bearer ${key}`, Origin: 'https://anything.example' } });
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
});

console.log('\nGhi nhận lượt dùng');

await test('a successful call is recorded against the right key', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  await call('/me', { key });
  await settle();
  const row = DB.api_usage.at(-1);
  assert.strictEqual(row.organization_id, 'org-a');
  assert.strictEqual(row.api_key_id, 'k1');
  assert.ok(row.endpoint.includes('/me'));
});

await test('a call is recorded even when the endpoint fails', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  await call('/chat', { key, method: 'POST', body: {} });
  await settle();
  assert.strictEqual(DB.api_usage.length, 1);
  assert.strictEqual(DB.api_usage[0].status, 400);
});

await test('using a key updates when it was last used', async () => {
  const key = addKey({ id: 'k1', org: 'org-a' });
  assert.strictEqual(DB.api_keys[0].last_used_at, undefined);
  await call('/me', { key });
  await settle();
  assert.ok(DB.api_keys[0].last_used_at, 'không cập nhật lần dùng cuối');
});

console.log(`\n${pass} đạt, ${fail} hỏng\n`);
server.close(); supa.close(); upstream.close();
process.exit(fail ? 1 : 0);
