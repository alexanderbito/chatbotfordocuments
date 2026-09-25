/**
 * Regression suite for annual billing.
 *
 * The point of these tests is not that the arithmetic is hard — it is that
 * every one of them fails in a way the customer notices and we do not. A
 * checkout that charges the monthly price for a yearly plan, or a webhook that
 * grants twelve months for one month's money, looks perfectly normal in the
 * logs. So the suite asserts on the numbers that reach the payments row and
 * the gateway, not on what the code intended.
 *
 * Run:  node scripts/yeartest.mjs      (from the repository root)
 */
import http from 'http';
import assert from 'assert';

// src/payments/paypal.js only honours PAYPAL_API_BASE when NODE_ENV is 'test',
// deliberately, so that one stray environment variable in production cannot
// redirect real payments. Set it here rather than relying on the person running
// the suite to remember: without it the tests quietly call the real sandbox and
// fail with "fetch failed", which reads like a broken change rather than a
// missing variable.
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------
// A stand-in Supabase. supabase-js speaks PostgREST over HTTP, so the
// cheapest honest fake is an HTTP server rather than a mocked module: the
// real client, the real query builder and the real serialisation are all
// exercised, and only the database is imaginary.
// ---------------------------------------------------------------------
const DB = { payments: [], system_logs: [], organizations: [] };
const rpcCalls = [];

const PLANS = {
  pro: { id: 'plan-pro', code: 'pro', name: 'Professional', price_usd: 19, price_usd_yearly: 187, is_active: true },
  biz: { id: 'plan-biz', code: 'business', name: 'Business', price_usd: 79, price_usd_yearly: 777, is_active: true },
  month_only: { id: 'plan-mo', code: 'starter', name: 'Starter', price_usd: 9, price_usd_yearly: 0, is_active: true },
  free: { id: 'plan-free', code: 'free', name: 'Free trial', price_usd: 0, price_usd_yearly: 0, is_active: true },
};

function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}

const supa = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await readBody(req);
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  if (url.pathname === '/rest/v1/rpc/activate_paid_plan') {
    const args = JSON.parse(body || '{}');
    rpcCalls.push(args);
    const pay = DB.payments.find((p) => p.id === args.p_payment_id);
    if (!pay) return json(400, { message: 'not found' });
    if (pay.paid_at) return json(200, false);          // already handled
    // Mirror of the SQL: the months come off the row, never off the caller.
    const months = pay.billing_cycle === 'yearly' ? 12 : 1;
    pay.paid_at = new Date().toISOString();
    pay.status = 'paid';
    pay.months_granted = months;
    return json(200, true);
  }

  const table = url.pathname.replace('/rest/v1/', '');

  // PostgREST answers .single() with a bare object rather than a one-element
  // array, and supabase-js asks for that with this Accept header. A stub that
  // always returns an array looks fine until the caller reads .id off it and
  // gets undefined — which is how the first run of this suite caught the
  // payment row never reaching the PayPal call at all.
  const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');
  const one = (code, row) => json(code, wantsObject ? row : [row]);

  if (req.method === 'POST') {
    const row = JSON.parse(body);
    const saved = { id: `row-${DB[table].length + 1}`, ...row };
    DB[table].push(saved);
    return one(201, saved);
  }
  if (req.method === 'PATCH') {
    const idEq = url.searchParams.get('id');
    const id = idEq ? idEq.replace('eq.', '') : null;
    const row = DB[table].find((r) => r.id === id);
    if (row) Object.assign(row, JSON.parse(body));
    return row ? one(200, row) : json(200, []);
  }
  return json(200, []);
});

// ---------------------------------------------------------------------
// A stand-in PayPal. It records what it was asked to charge, which is the
// number that actually leaves our control.
// ---------------------------------------------------------------------
const paypalOrders = [];
const pp = http.createServer(async (req, res) => {
  const body = await readBody(req);
  res.setHeader('Content-Type', 'application/json');
  if (req.url.includes('/v1/oauth2/token')) return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3000 }));
  if (req.url.includes('/v2/checkout/orders')) {
    const order = JSON.parse(body);
    paypalOrders.push(order);
    return res.end(JSON.stringify({
      id: `PP-${paypalOrders.length}`,
      status: 'CREATED',
      links: [{ rel: 'approve', href: `https://paypal.test/approve/${paypalOrders.length}` }],
    }));
  }
  res.end(JSON.stringify({}));
});

await new Promise((r) => supa.listen(4711, r));
await new Promise((r) => pp.listen(4712, r));

process.env.SUPABASE_URL = 'http://127.0.0.1:4711';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.PAYPAL_CLIENT_ID = 'cid';
process.env.PAYPAL_SECRET = 'secret';
process.env.PAYPAL_API_BASE = 'http://127.0.0.1:4712';
process.env.PAYPAL_ENV = 'sandbox';
process.env.APP_BASE_URL = 'https://app.botclarify.test';

const { startCheckout, markPaid } = await import('../src/payments/index.js');
const { normalizeCycle, priceFor, monthsFor, decoratePlan } = await import('../src/payments/cycles.js');

// ---------------------------------------------------------------------
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
const ORG = { id: 'org-1', name: 'Acme Inc.' };
const fakeReq = { headers: { host: 'app.botclarify.test' }, protocol: 'https' };

console.log('\nGiá theo chu kỳ');

await test('a monthly checkout charges the monthly price', async () => {
  const r = await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'monthly' });
  assert.strictEqual(r.amount, 19);
  assert.strictEqual(r.billing_cycle, 'monthly');
});

await test('a yearly checkout charges the yearly price, not twelve monthly ones', async () => {
  const r = await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  assert.strictEqual(r.amount, 187);
  assert.notStrictEqual(r.amount, 19 * 12);
});

await test('the amount PayPal is asked for matches the amount we recorded', async () => {
  paypalOrders.length = 0;
  const r = await startCheckout({ org: ORG, plan: PLANS.biz, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  const charged = Number(paypalOrders.at(-1).purchase_units[0].amount.value);
  assert.strictEqual(charged, 777);
  assert.strictEqual(charged, r.amount);
});

await test('the order carries the payment id the webhook looks it up by', async () => {
  // custom_id is the only link from a PayPal notification back to our row. If
  // it is empty the money arrives and the plan is never activated, and nothing
  // anywhere reports an error.
  paypalOrders.length = 0;
  DB.payments.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  const unit = paypalOrders.at(-1).purchase_units[0];
  assert.strictEqual(unit.custom_id, DB.payments.at(-1).id);
  assert.ok(unit.custom_id, 'custom_id rỗng');
  assert.notStrictEqual(unit.invoice_id, 'undefined');
});

await test('the payer is told how long the payment covers', async () => {
  paypalOrders.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  assert.match(paypalOrders.at(-1).purchase_units[0].description, /12 months/);
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'monthly' });
  assert.match(paypalOrders.at(-1).purchase_units[0].description, /1 month/);
});

console.log('\nGiá không đến từ trình duyệt');

await test('an amount sent by the browser is ignored', async () => {
  // The old shape of this bug: a client posting {amount: 1} and being billed $1.
  const r = await startCheckout({
    org: ORG, plan: { ...PLANS.pro, price_usd_yearly: 187 }, providerId: 'paypal',
    req: fakeReq, cycle: 'yearly', amount: 1, price: 1, price_usd: 1,
  });
  assert.strictEqual(r.amount, 187);
});

await test('an unknown cycle falls back to monthly rather than to a free year', async () => {
  for (const bad of ['YEARLY', 'yearly ', 'lifetime', '', null, undefined, 0, {}]) {
    assert.strictEqual(normalizeCycle(bad), 'monthly', `${JSON.stringify(bad)} nên thành monthly`);
  }
  const r = await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'lifetime' });
  assert.strictEqual(r.amount, 19);
});

await test('a plan with no yearly price refuses a yearly checkout instead of charging 0', async () => {
  await assert.rejects(
    () => startCheckout({ org: ORG, plan: PLANS.month_only, providerId: 'paypal', req: fakeReq, cycle: 'yearly' }),
    /not sold yearly/,
  );
});

await test('a free plan still cannot be checked out', async () => {
  await assert.rejects(
    () => startCheckout({ org: ORG, plan: PLANS.free, providerId: 'paypal', req: fakeReq, cycle: 'monthly' }),
    /no price set/,
  );
});

console.log('\nKích hoạt sau khi trả tiền');

await test('the cycle is stored on the payment row', async () => {
  DB.payments.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  assert.strictEqual(DB.payments.at(-1).billing_cycle, 'yearly');
});

await test('a yearly payment grants twelve months', async () => {
  DB.payments.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  const row = DB.payments.at(-1);
  await markPaid({ payment: row });
  assert.strictEqual(row.months_granted, 12);
});

await test('a monthly payment grants one month', async () => {
  DB.payments.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'monthly' });
  const row = DB.payments.at(-1);
  await markPaid({ payment: row });
  assert.strictEqual(row.months_granted, 1);
});

await test('markPaid cannot name its own number of months', async () => {
  // The whole reason p_months was removed. If this ever passes a count again,
  // a caller — or anything that can reach markPaid — can buy a decade for $19.
  DB.payments.length = 0;
  rpcCalls.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'monthly' });
  const row = DB.payments.at(-1);
  await markPaid({ payment: row, months: 120 });
  assert.strictEqual(rpcCalls.at(-1).p_months, undefined, 'p_months vẫn còn được gửi đi');
  assert.strictEqual(row.months_granted, 1);
});

await test('a webhook delivered twice only grants the period once', async () => {
  DB.payments.length = 0;
  await startCheckout({ org: ORG, plan: PLANS.pro, providerId: 'paypal', req: fakeReq, cycle: 'yearly' });
  const row = DB.payments.at(-1);
  const first = await markPaid({ payment: row });
  const second = await markPaid({ payment: row });
  const third = await markPaid({ payment: { ...row } });   // a fresh read of the same row
  assert.strictEqual(first.activated, true);
  assert.strictEqual(second.activated, false);
  assert.strictEqual(third.activated, false);
  assert.strictEqual(row.months_granted, 12);
});

console.log('\nCon số hiển thị cho khách');

await test('the advertised saving is 18% on both paid plans', () => {
  assert.strictEqual(decoratePlan(PLANS.pro).yearly_saving_pct, 18);
  assert.strictEqual(decoratePlan(PLANS.biz).yearly_saving_pct, 18);
});

await test('the saving follows an edited price instead of staying at 18%', () => {
  // A system admin halves the yearly price; the badge must say 50%, not 18%.
  const edited = decoratePlan({ ...PLANS.pro, price_usd_yearly: 114 });
  assert.strictEqual(edited.yearly_saving_pct, 50);
});

await test('the per-month equivalent keeps its cents', () => {
  const p = decoratePlan(PLANS.pro);
  assert.strictEqual(p.yearly_per_month, 15.58);
  assert.strictEqual(p.yearly_saving, 41);
});

await test('a monthly-only plan advertises nothing', () => {
  const p = decoratePlan(PLANS.month_only);
  assert.strictEqual(p.has_yearly, false);
  assert.strictEqual(p.yearly_saving_pct, 0);
  assert.strictEqual(p.yearly_per_month, 0);
});

await test('the free plan is not offered yearly', () => {
  assert.strictEqual(decoratePlan(PLANS.free).has_yearly, false);
});

await test('the price shown and the price charged come from one function', () => {
  // decoratePlan feeds the pricing page; priceFor feeds the checkout. If these
  // ever disagree, the customer is quoted one number and billed another.
  for (const plan of Object.values(PLANS)) {
    const shown = decoratePlan(plan);
    assert.strictEqual(priceFor(plan, 'monthly'), shown.price_monthly);
    assert.strictEqual(priceFor(plan, 'yearly'), shown.price_yearly);
  }
});

await test('twelve months is twelve months', () => {
  assert.strictEqual(monthsFor('yearly'), 12);
  assert.strictEqual(monthsFor('monthly'), 1);
  assert.strictEqual(monthsFor('nonsense'), 1);
});

console.log(`\n${pass} đạt, ${fail} hỏng\n`);
supa.close(); pp.close();
process.exit(fail ? 1 : 0);
