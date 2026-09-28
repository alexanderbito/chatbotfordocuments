/**
 * Regression suite for subscriptions and the affiliate programme.
 *
 * Both features move money without anybody watching: a renewal is charged by
 * PayPal on a schedule, and a commission is created by a webhook. The failures
 * that matter are therefore silent ones — a renewal applied twice, a commission
 * paid to the wrong person, a cancelled subscription that keeps charging — so
 * the tests drive the real handlers against a stubbed PayPal and read what
 * actually landed in the tables.
 *
 * Run:  node scripts/subtest.mjs      (from the repository root)
 */
import http from 'http';
import assert from 'assert';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------
// Stand-in Supabase. The real supabase-js client talks to it over HTTP, so
// the query builder and its filters are genuinely exercised.
// ---------------------------------------------------------------------
const DB = {
  plans: [], organizations: [], organization_members: [], subscriptions: [],
  payments: [], affiliates: [], referrals: [], commissions: [],
  affiliate_payouts: [], system_settings: [], system_logs: [], app_users: [],
};
const rpcCalls = [];

function readBody(req) {
  return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
}

function applyFilters(rows, params) {
  let out = rows;
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    const [op, ...rest] = String(raw).split('.');
    const value = rest.join('.');
    if (op === 'eq') out = out.filter((r) => String(r[key] ?? '') === value);
    else if (op === 'neq') out = out.filter((r) => String(r[key] ?? '') !== value);
    else if (op === 'is') out = out.filter((r) => (value === 'null' ? r[key] == null : r[key] != null));
    else if (op === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      out = out.filter((r) => list.includes(String(r[key])));
    }
  }
  return out;
}

// Mirrors record_commission in migration v13. Kept deliberately close to the
// SQL: if the two ever drift, the SQL suite (scripts/afftest.sql) is the one
// that decides, and this stub exists only so the JS paths can be exercised.
function recordCommission(paymentId) {
  const p = DB.payments.find((x) => x.id === paymentId);
  if (!p || !p.paid_at) return null;
  if (DB.commissions.some((c) => c.payment_id === paymentId)) return null;

  const ref = DB.referrals.find((r) => r.organization_id === p.organization_id);
  if (!ref) return null;
  const aff = DB.affiliates.find((a) => a.id === ref.affiliate_id);
  if (!aff || aff.status !== 'active') return null;

  const org = DB.organizations.find((o) => o.id === p.organization_id);
  if (org?.owner_id === aff.user_id) return null;
  if (DB.organization_members.some((m) =>
    m.organization_id === p.organization_id && m.user_id === aff.user_id && m.role === 'admin')) return null;

  const rate = p.billing_cycle === 'yearly' ? 0.30 : 0.20;
  const amount = Math.round(Number(p.amount) * rate * 100) / 100;
  if (amount <= 0) return null;

  const id = `com-${DB.commissions.length + 1}`;
  DB.commissions.push({
    id, affiliate_id: aff.id, organization_id: p.organization_id, payment_id: paymentId,
    billing_cycle: p.billing_cycle, rate, base_amount: p.amount, amount, currency: p.currency,
    status: 'pending', available_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    created_at: new Date().toISOString(),
  });
  ref.first_paid_at = ref.first_paid_at || p.paid_at;
  return id;
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

    if (fn === 'record_commission') return send(200, recordCommission(args.p_payment_id));

    if (fn === 'activate_paid_plan') {
      const p = DB.payments.find((x) => x.id === args.p_payment_id);
      if (!p) return send(400, { message: 'not found' });
      if (p.paid_at) return send(200, false);
      const months = p.billing_cycle === 'yearly' ? 12 : 1;
      const org = DB.organizations.find((o) => o.id === p.organization_id);
      const base = new Date(Math.max(Date.now(), new Date(org?.plan_expires_at || 0).getTime()));
      const end = new Date(base); end.setMonth(base.getMonth() + months);
      if (org) { org.plan_expires_at = end.toISOString(); org.billing_status = 'paid'; org.plan_id = p.plan_id || org.plan_id; }
      p.paid_at = new Date().toISOString(); p.status = 'paid'; p.months_granted = months;
      return send(200, true);
    }
    if (fn === 'affiliate_balance') {
      const mine = DB.commissions.filter((c) => c.affiliate_id === args.p_affiliate_id);
      const now = Date.now();
      return send(200, [{
        pending_amount: mine.filter((c) => c.status === 'pending' && new Date(c.available_at) > now)
          .reduce((s, c) => s + c.amount, 0),
        available_amount: mine.filter((c) => ['pending', 'approved'].includes(c.status) && new Date(c.available_at) <= now)
          .reduce((s, c) => s + c.amount, 0),
        paid_amount: mine.filter((c) => c.status === 'paid').reduce((s, c) => s + c.amount, 0),
        referred_count: DB.referrals.filter((r) => r.affiliate_id === args.p_affiliate_id).length,
        paying_count: DB.referrals.filter((r) => r.affiliate_id === args.p_affiliate_id && r.first_paid_at).length,
      }]);
    }
    return send(200, null);
  }

  const table = url.pathname.replace('/rest/v1/', '');
  if (!DB[table]) DB[table] = [];

  if (req.method === 'POST') {
    const row = JSON.parse(body);
    // Unique constraints the tests rely on.
    if (table === 'referrals' && DB.referrals.some((r) => r.organization_id === row.organization_id)) {
      return send(409, { code: '23505', message: 'duplicate key' });
    }
    if (table === 'payments' && row.provider_ref
        && DB.payments.some((p) => p.provider === row.provider && p.provider_ref === row.provider_ref)) {
      return send(409, { code: '23505', message: 'duplicate key' });
    }
    const saved = { id: row.id || `${table}-${DB[table].length + 1}`, created_at: new Date().toISOString(), ...row };
    DB[table].push(saved);
    return send(201, wantsObject ? saved : [saved]);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    let rows = applyFilters(DB[table], url.searchParams);
    const select = url.searchParams.get('select') || '';
    if (table === 'organizations' && /plan:plans/.test(select)) {
      rows = rows.map((o) => ({ ...o, plan: DB.plans.find((p) => p.id === o.plan_id) || null }));
    }
    if (table === 'subscriptions' && /plan:plans/.test(select)) {
      rows = rows.map((s) => ({ ...s, plan: DB.plans.find((p) => p.id === s.plan_id) || null }));
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
await new Promise((r) => supa.listen(4751, r));

// ---------------------------------------------------------------------
// Stand-in PayPal. Records what it was asked to do, which is the point:
// the amount that leaves our control is the number worth asserting on.
// ---------------------------------------------------------------------
const paypalCalls = [];
let refuseCancel = false;
const pp = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const path = new URL(req.url, 'http://x').pathname;
  // The token endpoint is form-encoded, everything else is JSON. Parsing
  // unconditionally as JSON is what tripped this up the first time.
  let parsed = null;
  if (body) { try { parsed = JSON.parse(body); } catch { parsed = body; } }
  paypalCalls.push({ path, method: req.method, body: parsed });
  res.setHeader('Content-Type', 'application/json');

  if (path.includes('/oauth2/token')) return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3000 }));
  if (path === '/v1/catalogs/products') return res.end(JSON.stringify({ id: 'PROD-1' }));
  if (path === '/v1/billing/plans') return res.end(JSON.stringify({ id: `P-${paypalCalls.length}` }));
  if (/\/deactivate$/.test(path)) return res.end(JSON.stringify({}));
  if (path === '/v1/billing/subscriptions') {
    return res.end(JSON.stringify({
      id: `I-SUB${paypalCalls.length}`,
      status: 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: `https://paypal.test/approve/${paypalCalls.length}` }],
    }));
  }
  if (/\/cancel$/.test(path)) {
    // PayPal refuses to cancel a subscription that was never approved:
    // /cancel wants ACTIVE or SUSPENDED and answers 422 otherwise.
    if (refuseCancel) {
      res.writeHead(422);
      return res.end(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', message: 'Invalid subscription status' }));
    }
    return res.end(JSON.stringify({}));
  }
  res.end(JSON.stringify({}));
});
await new Promise((r) => pp.listen(4752, r));

process.env.SUPABASE_URL = 'http://127.0.0.1:4751';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.PAYPAL_CLIENT_ID = 'cid';
process.env.PAYPAL_SECRET = 'secret';
process.env.PAYPAL_API_BASE = 'http://127.0.0.1:4752';
process.env.APP_BASE_URL = 'https://app.botclarify.test';

const subs = await import('../src/payments/subscriptions.js');
const paypal = await import('../src/payments/paypal.js');

// ---------------------------------------------------------------------
const PLAN_PRO = { id: 'plan-pro', code: 'pro', name: 'Professional', price_usd: 19, price_usd_yearly: 187, is_active: true };
const PLAN_STARTER = { id: 'plan-starter', code: 'starter', name: 'Starter', price_usd: 5, price_usd_yearly: 49, is_active: true };

function seed() {
  for (const k of Object.keys(DB)) DB[k] = [];
  rpcCalls.length = 0; paypalCalls.length = 0; refuseCancel = false;
  DB.plans.push({ ...PLAN_PRO }, { ...PLAN_STARTER });
  DB.organizations.push(
    { id: 'org-a', name: 'Acme', owner_id: 'user-a', status: 'active', billing_status: 'trial', plan_id: 'plan-pro', contact_email: 'a@acme.test' },
    { id: 'org-b', name: 'Globex', owner_id: 'user-b', status: 'active', billing_status: 'trial', plan_id: 'plan-pro' },
  );
}

let pass = 0, fail = 0;
async function test(name, fn) {
  seed();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
}

const org = () => DB.organizations.find((o) => o.id === 'org-a');
const plan = () => DB.plans.find((p) => p.id === 'plan-pro');
const starter = () => DB.plans.find((p) => p.id === 'plan-starter');

console.log('\nGói Starter');

await test('the Starter plan is $5 a month and $49 a year', () => {
  assert.strictEqual(starter().price_usd, 5);
  assert.strictEqual(starter().price_usd_yearly, 49);
  // 5 × 12 × 0.82 = 49.2, rounded to 49 — so the advertised saving holds.
  const saving = Math.round((1 - 49 / (5 * 12)) * 100);
  assert.strictEqual(saving, 18, `giảm ${saving}% chứ không phải 18%`);
});

console.log('\nĐăng ký tự gia hạn');

await test('a subscription is created and returns an approval link', async () => {
  const r = await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  assert.ok(r.approve_url.startsWith('https://paypal.test/'));
  assert.strictEqual(r.amount, 19);
  assert.strictEqual(DB.subscriptions.length, 1);
  assert.strictEqual(DB.subscriptions[0].status, 'pending');
});

await test('the yearly cycle charges the yearly price', async () => {
  const r = await subs.startSubscription({ org: org(), plan: plan(), cycle: 'yearly', userId: 'user-a', baseUrl: 'https://app.test' });
  assert.strictEqual(r.amount, 187);
  const planCall = paypalCalls.find((c) => c.path === '/v1/billing/plans');
  assert.strictEqual(planCall.body.billing_cycles[0].pricing_scheme.fixed_price.value, '187.00');
  assert.strictEqual(planCall.body.billing_cycles[0].frequency.interval_unit, 'YEAR');
});

await test('the PayPal plan is told to bill for ever, not a fixed number of times', async () => {
  await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  const planCall = paypalCalls.find((c) => c.path === '/v1/billing/plans');
  assert.strictEqual(planCall.body.billing_cycles[0].total_cycles, 0);
});

await test('the subscription carries our row id, so events can be traced back', async () => {
  const r = await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  const call = paypalCalls.find((c) => c.path === '/v1/billing/subscriptions');
  assert.strictEqual(call.body.custom_id, r.subscription_id);
});

await test('a price change makes a new PayPal plan rather than charging the old price', async () => {
  await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  const first = DB.plans.find((p) => p.id === 'plan-pro').paypal_plan_id_monthly;
  DB.subscriptions[0].status = 'cancelled';

  // The admin raises the price.
  DB.plans.find((p) => p.id === 'plan-pro').price_usd = 25;
  await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  const second = DB.plans.find((p) => p.id === 'plan-pro').paypal_plan_id_monthly;
  assert.notStrictEqual(second, first, 'vẫn dùng plan PayPal cũ với giá cũ');
  const lastPlan = paypalCalls.filter((c) => c.path === '/v1/billing/plans').at(-1);
  assert.strictEqual(lastPlan.body.billing_cycles[0].pricing_scheme.fixed_price.value, '25.00');
});

await test('an unchanged price reuses the PayPal plan instead of making a new one', async () => {
  await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  const made = paypalCalls.filter((c) => c.path === '/v1/billing/plans').length;
  DB.subscriptions[0].status = 'cancelled';
  await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  assert.strictEqual(paypalCalls.filter((c) => c.path === '/v1/billing/plans').length, made);
});

await test('an organization cannot run two subscriptions at once', async () => {
  await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  await assert.rejects(
    () => subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' }),
    /already has a subscription/);
});

await test('a plan with no yearly price is refused yearly', async () => {
  DB.plans.find((p) => p.id === 'plan-pro').price_usd_yearly = 0;
  await assert.rejects(
    () => subs.startSubscription({ org: org(), plan: plan(), cycle: 'yearly', userId: 'user-a', baseUrl: 'https://app.test' }),
    /not sold yearly/);
  assert.strictEqual(DB.subscriptions.length, 0, 'để lại subscription treo');
});

console.log('\nGia hạn tự động');

async function subscribed(cycle = 'monthly') {
  const r = await subs.startSubscription({ org: org(), plan: plan(), cycle, userId: 'user-a', baseUrl: 'https://app.test' });
  const row = DB.subscriptions.find((s) => s.id === r.subscription_id);
  row.status = 'active';
  return row;
}

await test('a renewal writes a payment and extends the plan', async () => {
  const sub = await subscribed('monthly');
  const out = await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(out.activated, true);
  assert.strictEqual(DB.payments.length, 1);
  assert.strictEqual(DB.payments[0].months_granted, 1);
  assert.strictEqual(DB.payments[0].subscription_id, sub.id);
  assert.strictEqual(org().billing_status, 'paid');
});

await test('a yearly renewal grants twelve months', async () => {
  const sub = await subscribed('yearly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 187, currency: 'USD', raw: {} });
  assert.strictEqual(DB.payments[0].months_granted, 12);
});

await test('the same renewal delivered twice only buys one period', async () => {
  // PayPal retries webhooks. This is the failure that would go unnoticed for
  // months and then show up as a customer with a plan running years ahead.
  const sub = await subscribed('monthly');
  const first = await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  const second = await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(first.activated, true);
  assert.strictEqual(second.activated, false);
  assert.strictEqual(DB.payments.length, 1);
});

await test('the amount recorded is what PayPal actually took', async () => {
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 17.5, currency: 'USD', raw: {} });
  assert.strictEqual(Number(DB.payments[0].amount), 17.5);
});

await test('a renewal marks the subscription active and stamps the date', async () => {
  const sub = await subscribed('monthly');
  sub.status = 'pending';
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  const row = DB.subscriptions.find((s) => s.id === sub.id);
  assert.strictEqual(row.status, 'active');
  assert.ok(row.last_payment_at);
});

console.log('\nHuỷ và các sự kiện khác');

await test('cancelling tells PayPal and records it locally', async () => {
  const sub = await subscribed('monthly');
  const r = await subs.cancelSubscription({ org: org(), subscriptionId: sub.id, userId: 'user-a' });
  assert.strictEqual(r.status, 'cancelled');
  assert.ok(paypalCalls.some((c) => /\/cancel$/.test(c.path)));
  assert.strictEqual(DB.subscriptions[0].status, 'cancelled');
  assert.ok(DB.subscriptions[0].cancelled_at);
});

await test('cancelling does not shorten the period already paid for', async () => {
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  const expiry = org().plan_expires_at;
  await subs.cancelSubscription({ org: org(), subscriptionId: sub.id, userId: 'user-a' });
  assert.strictEqual(org().plan_expires_at, expiry, 'huỷ mà cắt luôn thời gian đã trả');
  assert.strictEqual(org().billing_status, 'paid');
});

await test('an approval that was never finished can still be cancelled', async () => {
  // The lock-out this guards against: PayPal will not cancel a subscription it
  // never had approved, and while the pending row survives, the one-live-per-
  // organization rule refuses every further attempt. A customer who closed the
  // approval tab could never subscribe again.
  const r = await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  assert.strictEqual(DB.subscriptions[0].status, 'pending');

  refuseCancel = true;
  const out = await subs.cancelSubscription({ org: org(), subscriptionId: r.subscription_id, userId: 'user-a' });
  assert.strictEqual(out.status, 'cancelled');
  assert.strictEqual(DB.subscriptions[0].status, 'cancelled');

  // ...and the customer can start again, which is the point.
  refuseCancel = false;
  const again = await subs.startSubscription({ org: org(), plan: plan(), cycle: 'monthly', userId: 'user-a', baseUrl: 'https://app.test' });
  assert.ok(again.approve_url);
});

await test('a live subscription that PayPal refuses to cancel reports the failure', async () => {
  // The opposite case. Saying "renewal stopped" when PayPal is still charging
  // is the one outcome worse than an error message.
  const sub = await subscribed('monthly');
  refuseCancel = true;
  await assert.rejects(
    subs.cancelSubscription({ org: org(), subscriptionId: sub.id, userId: 'user-a' }));
  assert.strictEqual(DB.subscriptions[0].status, 'active', 'đã báo huỷ trong khi PayPal vẫn thu');
});

await test("one organization cannot cancel another's subscription", async () => {
  const sub = await subscribed('monthly');
  await assert.rejects(
    () => subs.cancelSubscription({ org: DB.organizations.find((o) => o.id === 'org-b'), subscriptionId: sub.id, userId: 'user-b' }),
    /not found/);
  assert.strictEqual(DB.subscriptions[0].status, 'active');
});

await test('a failed payment suspends the subscription without ending the paid period', async () => {
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  const expiry = org().plan_expires_at;
  await subs.applySubscriptionStatus(DB.subscriptions[0], 'suspended', {});
  assert.strictEqual(DB.subscriptions[0].status, 'suspended');
  assert.strictEqual(org().plan_expires_at, expiry);
});

console.log('\nĐọc sự kiện webhook');

await test('a renewal is read from the sale, not from the subscription', () => {
  const evt = paypal.readSubscriptionEvent({
    event_type: 'PAYMENT.SALE.COMPLETED',
    resource: { id: 'SALE-9', billing_agreement_id: 'I-SUB1', amount: { total: '19.00', currency: 'USD' } },
  });
  assert.strictEqual(evt.kind, 'payment');
  assert.strictEqual(evt.saleId, 'SALE-9');
  assert.strictEqual(evt.providerRef, 'I-SUB1');
  assert.strictEqual(evt.amount, 19);
});

await test('a one-off sale is not mistaken for a renewal', () => {
  // No billing_agreement_id means no subscription behind it.
  const evt = paypal.readSubscriptionEvent({
    event_type: 'PAYMENT.SALE.COMPLETED',
    resource: { id: 'SALE-9', amount: { total: '19.00' } },
  });
  assert.strictEqual(evt.providerRef, null);
});

await test('each lifecycle event maps to the right status', () => {
  const cases = {
    'BILLING.SUBSCRIPTION.ACTIVATED': 'active',
    'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled',
    'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended',
    'BILLING.SUBSCRIPTION.EXPIRED': 'expired',
    'BILLING.SUBSCRIPTION.PAYMENT.FAILED': 'suspended',
  };
  for (const [type, expected] of Object.entries(cases)) {
    const evt = paypal.readSubscriptionEvent({ event_type: type, resource: { id: 'I-SUB1' } });
    assert.strictEqual(evt.kind, 'lifecycle', type);
    assert.strictEqual(evt.status, expected, type);
  }
});

await test('an unrelated event is ignored', () => {
  assert.strictEqual(paypal.readSubscriptionEvent({ event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} }).kind, 'other');
});

console.log('\nHoa hồng affiliate');

function makeAffiliate({ id = 'aff-1', user = 'user-z', code = 'zztest12' } = {}) {
  DB.affiliates.push({ id, user_id: user, code, status: 'active' });
  return id;
}

await test('a monthly renewal earns the referrer 20%', async () => {
  makeAffiliate();
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions.length, 1);
  assert.strictEqual(DB.commissions[0].amount, 3.80);
  assert.strictEqual(DB.commissions[0].rate, 0.20);
});

await test('a yearly renewal earns 30%', async () => {
  makeAffiliate();
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('yearly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 187, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions[0].amount, 56.10);
  assert.strictEqual(DB.commissions[0].rate, 0.30);
});

await test('every renewal earns, not only the first', async () => {
  // The whole promise of the programme. If this ever regresses, affiliates
  // keep referring and quietly stop being paid.
  makeAffiliate();
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  for (const sale of ['SALE-1', 'SALE-2', 'SALE-3']) {
    await subs.recordSubscriptionPayment({ subscription: sub, saleId: sale, amount: 19, currency: 'USD', raw: {} });
  }
  assert.strictEqual(DB.commissions.length, 3);
  // Summed in cents. Postgres adds numerics exactly; this stub is JS, where
  // 3.80 + 3.80 + 3.80 is 11.399999999999999 and the test would be wrong
  // about the code rather than the code being wrong about the money.
  const cents = DB.commissions.reduce((s, c) => s + Math.round(c.amount * 100), 0);
  assert.strictEqual(cents, 1140);
});

await test('a renewal charged at an unexpected amount is recorded and flagged', async () => {
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-X', amount: 12, currency: 'USD', raw: {} });
  // What PayPal actually took, not what we hoped it would take.
  assert.strictEqual(Number(DB.payments[0].amount), 12);
  assert.strictEqual(org().billing_status, 'paid');
  // ...and it left a trace at error level, because our plan and PayPal's have
  // drifted apart and nothing else would ever say so.
  assert.ok(
    DB.system_logs.some((l) => l.level === 'error' && /different amount/i.test(l.message || '')),
    'thu sai số tiền mà không có gì ghi lại');
});

await test('a repeated webhook does not earn a second commission', async () => {
  makeAffiliate();
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions.length, 1);
});

await test('nobody earns from an organization they own', async () => {
  makeAffiliate({ user: 'user-a' });   // user-a owns org-a
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions.length, 0);
});

await test('nor from one they administer', async () => {
  makeAffiliate({ user: 'user-z' });
  DB.organization_members.push({ organization_id: 'org-a', user_id: 'user-z', role: 'admin' });
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions.length, 0);
});

await test('a suspended affiliate earns nothing more', async () => {
  makeAffiliate();
  DB.affiliates[0].status = 'suspended';
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions.length, 0);
});

await test('a payment with no referral earns nothing', async () => {
  makeAffiliate();
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions.length, 0);
});

await test('the commission is held, not immediately payable', async () => {
  makeAffiliate();
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 19, currency: 'USD', raw: {} });
  assert.ok(new Date(DB.commissions[0].available_at) > new Date(), 'trả được ngay, không giữ lại ngày nào');
  assert.strictEqual(DB.commissions[0].status, 'pending');
});

await test('the commission follows the amount charged, not the list price', async () => {
  makeAffiliate();
  DB.referrals.push({ organization_id: 'org-a', affiliate_id: 'aff-1' });
  const sub = await subscribed('monthly');
  await subs.recordSubscriptionPayment({ subscription: sub, saleId: 'SALE-1', amount: 10, currency: 'USD', raw: {} });
  assert.strictEqual(DB.commissions[0].amount, 2.00);
  assert.strictEqual(Number(DB.commissions[0].base_amount), 10);
});

console.log(`\n${pass} đạt, ${fail} hỏng\n`);
supa.close(); pp.close();
process.exit(fail ? 1 : 0);
