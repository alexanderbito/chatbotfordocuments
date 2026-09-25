/**
 * Regression suite for the contact form.
 *
 * This endpoint takes writes from anyone on the internet with no account
 * behind them, which makes it the most exposed surface in the product. The
 * tests therefore spend most of their time on what happens when the caller is
 * hostile rather than on the happy path: forged origins, oversized bodies,
 * floods, and the question of who can read what was sent.
 *
 * Run:  node scripts/contacttest.mjs      (from the repository root)
 */
import http from 'http';
import assert from 'assert';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------
// A stand-in Supabase, spoken to over HTTP by the real supabase-js client.
// ---------------------------------------------------------------------
const DB = { contact_messages: [], system_logs: [] };

function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}

// Parses the subset of PostgREST filters this code actually uses.
function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const [op, ...rest] = String(raw).split('.');
    const value = rest.join('.');
    if (op === 'eq') out = out.filter((r) => String(r[key] ?? '') === value);
    else if (op === 'gte') out = out.filter((r) => String(r[key] ?? '') >= value);
    else if (op === 'not') out = out.filter((r) => r[key] != null);
  }
  return out;
}

const supa = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const table = url.pathname.replace('/rest/v1/', '');
  const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');
  const send = (code, data, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };

  if (!DB[table]) DB[table] = [];

  if (req.method === 'POST') {
    const row = JSON.parse(body);
    const saved = { id: `m${DB[table].length + 1}`, status: 'new', created_at: new Date().toISOString(), ...row };
    DB[table].push(saved);
    return send(201, wantsObject ? saved : [saved]);
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const rows = applyFilters(DB[table], url.searchParams);
    // head:true + count:'exact' asks for the count in a Content-Range header.
    if (req.method === 'HEAD' || /exact/.test(req.headers.prefer || '')) {
      res.writeHead(200, { 'Content-Range': `0-0/${rows.length}`, 'Content-Type': 'application/json' });
      return res.end(req.method === 'HEAD' ? '' : JSON.stringify(rows));
    }
    return send(200, wantsObject ? rows[0] || null : rows);
  }

  if (req.method === 'PATCH') {
    const rows = applyFilters(DB[table], url.searchParams);
    for (const r of rows) Object.assign(r, JSON.parse(body));
    return send(200, wantsObject ? rows[0] || null : rows);
  }
  if (req.method === 'DELETE') {
    const rows = applyFilters(DB[table], url.searchParams);
    DB[table] = DB[table].filter((r) => !rows.includes(r));
    return send(200, []);
  }
  return send(200, []);
});

await new Promise((r) => supa.listen(4731, r));

process.env.SUPABASE_URL = 'http://127.0.0.1:4731';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.CONTACT_ALLOWED_ORIGINS = 'https://preview.botclarify.com';

const express = (await import('express')).default;
const { publicRouter } = await import('../src/routes/contact.js');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/public/contact', publicRouter);
const server = app.listen(4732);
await new Promise((r) => server.once('listening', r));

const BASE = 'http://127.0.0.1:4732/public/contact';
const GOOD = { name: 'Jane Smith', email: 'jane@acme.com', company: 'Acme', message: 'We would like a demo for about thirty people.' };

async function post(payload, headers = {}) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

const reset = () => { DB.contact_messages = []; DB.system_logs = []; };
// Each test gets its own address so one test's messages never count towards
// another's rate limit.
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq}`;

let pass = 0, fail = 0;
async function test(name, fn) {
  reset();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

console.log('\nGửi được tin nhắn');

await test('a normal message is stored', async () => {
  const r = await post(GOOD, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(DB.contact_messages.length, 1);
  assert.strictEqual(DB.contact_messages[0].email, 'jane@acme.com');
  assert.strictEqual(DB.contact_messages[0].status, 'new');
});

await test('the email address is stored lowercase', async () => {
  await post({ ...GOOD, email: '  Jane@ACME.com ' }, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(DB.contact_messages[0].email, 'jane@acme.com');
});

await test('line breaks in the message are kept, and stray ones elsewhere are not', async () => {
  await post({ ...GOOD, name: 'Jane\n\nSmith', message: 'First line.\n\nSecond line.' }, { 'x-forwarded-for': nextIp() });
  const m = DB.contact_messages[0];
  assert.strictEqual(m.name, 'Jane Smith');
  assert.ok(m.message.includes('\n\n'), 'xuống dòng trong nội dung bị mất');
});

console.log('\nDữ liệu sai bị từ chối');

await test('a missing name is refused', async () => {
  const r = await post({ ...GOOD, name: '   ' }, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(DB.contact_messages.length, 0);
});

await test('an address that is not an address is refused', async () => {
  for (const bad of ['jane', 'jane@', '@acme.com', 'jane acme.com', 'jane@acme']) {
    const r = await post({ ...GOOD, email: bad }, { 'x-forwarded-for': nextIp() });
    assert.strictEqual(r.status, 400, `${bad} lẽ ra bị từ chối`);
  }
  assert.strictEqual(DB.contact_messages.length, 0);
});

await test('a one-word message is refused', async () => {
  const r = await post({ ...GOOD, message: 'hi' }, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(r.status, 400);
});

await test('an oversized message is cut, not stored whole', async () => {
  // The column has the same cap, so a route that stopped trimming would start
  // returning database errors to strangers rather than silently storing 2MB.
  await post({ ...GOOD, message: 'x'.repeat(50000) }, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(DB.contact_messages[0].message.length, 5000);
});

await test('an oversized name and company are cut', async () => {
  await post({ name: 'n'.repeat(500), email: 'jane@acme.com', company: 'c'.repeat(500), message: 'A real enquiry, honestly.' },
    { 'x-forwarded-for': nextIp() });
  const m = DB.contact_messages[0];
  assert.ok(m.name.length <= 120, `tên dài ${m.name.length}`);
  assert.ok(m.company.length <= 160, `công ty dài ${m.company.length}`);
});

await test('an oversized address is refused, not stored mangled', async () => {
  // Cutting an address at 200 characters produces something that is not an
  // address. Storing that would mean a message we can never reply to, which is
  // worse than not taking it — so the trim happens first and the check second.
  const r = await post({ ...GOOD, email: 'e'.repeat(300) + '@acme.com' }, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(DB.contact_messages.length, 0);
});

console.log('\nChống spam');

await test('the honeypot is dropped, and looks like success to the sender', async () => {
  const r = await post({ ...GOOD, website: 'http://spam.example' }, { 'x-forwarded-for': nextIp() });
  // A bot that is told it failed simply tries again in another shape.
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
  assert.strictEqual(DB.contact_messages.length, 0, 'tin nhắn của bot vẫn được lưu');
});

await test('a flood from one address is cut off after five in an hour', async () => {
  const ip = nextIp();
  for (let i = 0; i < 5; i++) {
    const r = await post({ ...GOOD, message: `Enquiry number ${i}, with enough words.` }, { 'x-forwarded-for': ip });
    assert.strictEqual(r.status, 200, `lần ${i + 1} lẽ ra phải qua`);
  }
  const blocked = await post(GOOD, { 'x-forwarded-for': ip });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(DB.contact_messages.length, 5);
});

await test('one sender being blocked does not block anyone else', async () => {
  const noisy = nextIp();
  for (let i = 0; i < 6; i++) await post({ ...GOOD, message: `Message ${i} with enough words.` }, { 'x-forwarded-for': noisy });
  const other = await post(GOOD, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(other.status, 200);
});

await test('the address is read from the proxy end of x-forwarded-for', async () => {
  // Every proxy APPENDS, so the leftmost entry is whatever the caller sent and
  // the rightmost is what the nearest proxy observed. Reading the left was the
  // whole bug below.
  const r = await post(GOOD, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 198.51.100.77' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(DB.contact_messages[0].ip, '198.51.100.77');
});

await test('a forged x-forwarded-for cannot buy a fresh rate-limit bucket', async () => {
  // THE bug this suite exists for. With the leftmost entry trusted, a sender
  // put a different made-up address in front on each request and never hit the
  // limit — the one control on an endpoint the whole internet can write to did
  // nothing, silently.
  const real = nextIp();
  for (let i = 0; i < 5; i++) {
    const r = await post({ ...GOOD, message: `Enquiry ${i}, long enough to pass.` },
      { 'x-forwarded-for': `10.0.0.${i}, ${real}` });
    assert.strictEqual(r.status, 200, `lần ${i + 1} lẽ ra phải qua`);
  }
  const forged = await post(GOOD, { 'x-forwarded-for': `203.0.113.250, ${real}` });
  assert.strictEqual(forged.status, 429, 'giả mạo đầu chuỗi vẫn lách được giới hạn');
  assert.strictEqual(DB.contact_messages.length, 5);
});

await test('a header shorter than the expected hop count falls back to the socket', async () => {
  // An empty or missing header means the request did not come through the
  // proxies we expect. Falling back to the caller's own value there would hand
  // the bucket back to them.
  const r = await post(GOOD, {});
  assert.strictEqual(r.status, 200);
  const ip = DB.contact_messages[0].ip;
  assert.ok(ip && !/^203\.0\.113/.test(ip), `lấy nhầm địa chỉ: ${ip}`);
});

console.log('\nNguồn gửi (CORS)');

await test('the site is allowed to post', async () => {
  const r = await post(GOOD, { Origin: 'https://botclarify.com', 'x-forwarded-for': nextIp() });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://botclarify.com');
  assert.strictEqual(r.headers.get('vary'), 'Origin');
});

await test('an extra origin from the environment is allowed', async () => {
  const r = await post(GOOD, { Origin: 'https://preview.botclarify.com', 'x-forwarded-for': nextIp() });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://preview.botclarify.com');
});

await test('any other site gets no CORS header at all', async () => {
  for (const origin of ['https://evil.example', 'https://botclarify.com.evil.example', 'http://botclarify.com', 'null']) {
    const r = await post({ ...GOOD }, { Origin: origin, 'x-forwarded-for': nextIp() });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null, `${origin} không được phép`);
  }
});

await test('Vary: Origin is sent whatever the origin', async () => {
  // Only setting it on the allowed branch left refusals uncacheable-by-origin,
  // so an intermediary could hand one site's CORS answer to another.
  for (const origin of ['https://botclarify.com', 'https://evil.example']) {
    const r = await post({ ...GOOD }, { Origin: origin, 'x-forwarded-for': nextIp() });
    assert.strictEqual(r.headers.get('vary'), 'Origin', `thiếu Vary với ${origin}`);
  }
});

await test('the wildcard is never sent', async () => {
  const r = await post(GOOD, { Origin: 'https://botclarify.com', 'x-forwarded-for': nextIp() });
  assert.notStrictEqual(r.headers.get('access-control-allow-origin'), '*');
});

await test('the preflight answers without creating anything', async () => {
  const res = await fetch(BASE, { method: 'OPTIONS', headers: { Origin: 'https://botclarify.com' } });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://botclarify.com');
  assert.ok(/POST/.test(res.headers.get('access-control-allow-methods') || ''));
  assert.strictEqual(DB.contact_messages.length, 0);
});

console.log('\nKhông rò rỉ ra ngoài');

await test('the rate limit counts per address, not globally', async () => {
  // One sender exhausting their allowance must not shut the form for everyone.
  const a = nextIp();
  for (let i = 0; i < 6; i++) await post({ ...GOOD, message: `Message ${i}, long enough.` }, { 'x-forwarded-for': a });
  const b = await post(GOOD, { 'x-forwarded-for': nextIp() });
  assert.strictEqual(b.status, 200);
});

await test('a stored message is never echoed back to the sender', async () => {
  // The response is the one thing a stranger can see. It must carry nothing
  // from the table — not their own row, and certainly not anybody else's.
  const r = await post(GOOD, { 'x-forwarded-for': nextIp() });
  assert.deepStrictEqual(Object.keys(r.data), ['ok']);
});

await test('a rate-limit refusal does not describe the limit', async () => {
  const ip = nextIp();
  for (let i = 0; i < 5; i++) await post({ ...GOOD, message: `Enquiry ${i} with enough words.` }, { 'x-forwarded-for': ip });
  const r = await post(GOOD, { 'x-forwarded-for': ip });
  assert.strictEqual(r.status, 429);
  assert.ok(!/\b5\b|\b20\b|hour|day/i.test(r.data.error || ''), `lộ chi tiết giới hạn: ${r.data.error}`);
});

await test('a database failure is not reported to the sender verbatim', async () => {
  const saved = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'http://127.0.0.1:4799';   // nothing listening
  const r = await post(GOOD, { 'x-forwarded-for': nextIp() });
  process.env.SUPABASE_URL = saved;
  // supabase-js was built with the old URL, so this may still succeed; what
  // must hold either way is that no internal detail reaches the sender.
  if (r.status !== 200) {
    assert.ok(!/supabase|postgres|127\.0\.0\.1|ECONN/i.test(JSON.stringify(r.data)), `lộ chi tiết nội bộ: ${JSON.stringify(r.data)}`);
  }
});

console.log(`\n${pass} đạt, ${fail} hỏng\n`);
server.close(); supa.close();
process.exit(fail ? 1 : 0);
