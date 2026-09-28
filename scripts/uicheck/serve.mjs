// Serves the marketing site on 4600 and the application shell on 4601, with a
// stub API so the logged-in pages render.
import http from 'http';
import fs from 'fs';
import path from 'path';

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };

function fileServer(root, api) {
  return (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (api) { const handled = api(p, res, req); if (handled) return; }
    const f = path.join(root, p === '/' ? 'index.html' : p.replace(/^\//, ''));
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain' });
      res.end(d);
    });
  };
}

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../..');
const SITE_DIR = process.env.SITE_DIR || path.join(ROOT, 'site');
const APP_DIR = process.env.APP_DIR || path.join(ROOT, 'public');

http.createServer(fileServer(SITE_DIR)).listen(4600);

// Mirrors src/payments/cycles.js decoratePlan, so the stub serves the same
// shape the real API does.
function deco(p) {
  const m = Number(p.price_usd || 0), y = Number(p.price_usd_yearly || 0), ok = m > 0 && y > 0;
  return { ...p, price: m, price_monthly: m, price_yearly: y, has_yearly: ok,
    yearly_per_month: ok ? Math.round((y/12)*100)/100 : 0,
    yearly_saving: ok ? Math.round((m*12 - y)*100)/100 : 0,
    yearly_saving_pct: ok ? Math.round((1 - y/(m*12))*100) : 0 };
}
const PLANS = [
  { id:'p1', code:'free', name:'Free trial', description:'Everything except OCR, for 3 days.', price_usd:0, price_usd_yearly:0, trial_days:3, ocr_enabled:false, api_enabled:false, max_api_calls_per_month:0, max_documents:20, max_members:5, max_storage_mb:100, max_questions_per_month:500, max_ocr_pages_per_month:0 },
  { id:'p4', code:'starter', name:'Starter', description:'For a small team.', price_usd:5, price_usd_yearly:49, trial_days:0, ocr_enabled:false, api_enabled:false, max_api_calls_per_month:0, max_documents:100, max_members:5, max_storage_mb:1000, max_questions_per_month:1500, max_ocr_pages_per_month:0 },
  { id:'p2', code:'pro', name:'Professional', description:'For a growing team.', price_usd:19, price_usd_yearly:187, trial_days:0, ocr_enabled:true, api_enabled:false, max_api_calls_per_month:0, max_documents:500, max_members:30, max_storage_mb:5000, max_questions_per_month:10000, max_ocr_pages_per_month:2000 },
  { id:'p3', code:'business', name:'Business', description:'For a whole company.', price_usd:79, price_usd_yearly:777, trial_days:0, ocr_enabled:true, api_enabled:true, max_api_calls_per_month:20000, max_documents:10000, max_members:300, max_storage_mb:50000, max_questions_per_month:100000, max_ocr_pages_per_month:20000 },
].map(deco);
/** By code, never by position: the list grows and positions move. */
const PLAN = (code) => PLANS.find((x) => x.code === code);
const MSGS = [
  { id:'c1', name:'Jane Smith', email:'jane@acme.com', company:'Acme Inc.', status:'new',
    created_at:'2026-09-24T09:12:00Z', read_at:null,
    message:'We have about 400 policy documents in SharePoint and nobody can find anything.\n\nCould we see a demo next week?' },
  { id:'c2', name:'<img src=x onerror=alert(1)>', email:'"><script>alert(2)</script>@evil.example', company:'<b>bold</b>',
    status:'new', created_at:'2026-09-24T08:02:00Z', read_at:null,
    message:'<script>alert(3)</script> and some <b>markup</b> in the body too.' },
  { id:'c3', name:'Tom Reed', email:'tom@globex.com', company:null, status:'read',
    created_at:'2026-09-20T14:30:00Z', read_at:'2026-09-20T15:00:00Z',
    message:'What happens to our documents if we cancel?' },
];
const KEYS = [
  { id:'k1', name:'Intranet help page', key_prefix:'bck_a1b2c3', folder_ids:['f1'],
    created_at:'2026-09-01T00:00:00Z', last_used_at:'2026-09-25T08:12:00Z', expires_at:null,
    revoked_at:null, calls_this_month:1180 },
  { id:'k2', name:'Nightly report job', key_prefix:'bck_d4e5f6', folder_ids:null,
    created_at:'2026-08-14T00:00:00Z', last_used_at:'2026-09-24T02:00:00Z', expires_at:'2027-08-14T00:00:00Z',
    revoked_at:null, calls_this_month:60 },
  { id:'k3', name:'Old prototype', key_prefix:'bck_99aabb', folder_ids:null,
    created_at:'2026-06-01T00:00:00Z', last_used_at:null, expires_at:null,
    revoked_at:'2026-08-30T00:00:00Z', calls_this_month:0 },
];
const J = (res, d) => { res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify(d)); return true; };

http.createServer(fileServer(APP_DIR, (p, res, req) => {
  // PATCH on a message really changes it, so the unread badge can be tested
  // end to end rather than assumed.
  const m = /^\/admin\/contact\/([^/]+)$/.exec(p);
  if (m && req?.method === 'PATCH') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const row = MSGS.find((x) => x.id === m[1]);
      if (row) Object.assign(row, JSON.parse(body || '{}'));
      J(res, row || {});
    });
    return true;
  }

  if (p === '/auth/me') return J(res, {
    user: { id:'u1', email:'admin@company.com', full_name:'Alex Morgan', is_system_admin:true },
    organizations: [{ id:'o1', name:'Acme Inc.', role:'admin', billing_status:'paid', plan:PLAN('pro'), trial:{ isTrial:false } }],
  });
  if (p === '/public/billing/plans') return J(res, { currency:'USD', providers:[{ id:'paypal', name:'PayPal / Credit or debit card', description:'Pay with PayPal balance, credit or debit card' }], plans:PLANS });
  if (p.endsWith('/billing')) return J(res, {
    plan: PLAN('pro'), billing_status:'paid', plan_expires_at:'2026-12-31T00:00:00Z', trial:{ isTrial:false },
    usage: { documents:12, members:4, questions_this_month:340, storage_mb:82, ocr_pages_this_month:15,
      limits:{ max_documents:500, max_members:30, max_questions_per_month:10000, max_storage_mb:5000, max_ocr_pages_per_month:2000 } },
    payments: [{ id:'x1', created_at:'2026-09-01T00:00:00Z', period_start:'2026-09-01', period_end:'2027-09-01', amount:187, currency:'USD', billing_cycle:'yearly', method:'paypal', status:'paid', paid_at:'2026-09-01T00:00:00Z' }],
    available_plans: PLANS, providers:[{ id:'paypal', name:'PayPal / Credit or debit card', description:'Pay' }],
  });
  // API keys for the organization console.
  if (/\/api-keys$/.test(p) && req?.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      const k = { id: 'k' + (KEYS.length + 1), name: b.name, key_prefix: 'bck_9f3a2c',
                  folder_ids: b.folder_ids?.length ? b.folder_ids : null,
                  created_at: new Date().toISOString(), last_used_at: null,
                  expires_at: null, revoked_at: null, calls_this_month: 0,
                  key: 'bck_' + 'x'.repeat(43) };
      KEYS.push(k);
      J(res, k);
    });
    return true;
  }
  if (/\/api-keys$/.test(p)) return J(res, {
    keys: KEYS, api_enabled: true, calls_this_month: 1240, calls_included: 20000,
  });
  if (p === '/admin/contact/unread') return J(res, { unread: MSGS.filter((m) => m.status === 'new').length });
  if (p === '/admin/contact') return J(res, { items: MSGS, unread: MSGS.filter((m) => m.status === 'new').length });
  // /admin/plans answers an ARRAY, not the generic object below; the plans
  // table reads it directly and renders nothing when handed an object.
  if (p === '/admin/plans') return J(res, PLANS.map((x, i) => ({ ...x, organization_count: [0, 4, 1][i], is_active: true, sort_order: i })));
  // The affiliate's own page: enrolled, with money in all three states so the
  // held / ready / paid columns are each exercised.
  if (p === '/affiliate') return J(res, {
    enrolled: true, eligible: true, rates: { monthly: 0.20, yearly: 0.30 },
    affiliate: { id:'a1', code:'mk7qtv3n', paypal_email:'alex@example.com', status:'active',
      created_at:'2026-07-01T00:00:00Z', link:'https://botclarify.com/?ref=mk7qtv3n' },
    balance: { pending: 45.60, available: 233.10, paid: 78.00, referred: 4, paying: 2 },
    referrals: [
      { name:'Globex', referred_at:'2026-08-02T00:00:00Z', paying:true },
      { name:'Initech', referred_at:'2026-09-11T00:00:00Z', paying:false },
    ],
    commissions: [
      { id:'m1', amount:233.10, currency:'USD', billing_cycle:'yearly', rate:0.30, status:'approved',
        available_at:'2026-09-01T00:00:00Z', created_at:'2026-08-02T00:00:00Z' },
      { id:'m2', amount:15.80, currency:'USD', billing_cycle:'monthly', rate:0.20, status:'pending',
        available_at:'2026-11-01T00:00:00Z', created_at:'2026-09-24T00:00:00Z' },
      { id:'m3', amount:78.00, currency:'USD', billing_cycle:'monthly', rate:0.20, status:'paid',
        available_at:'2026-07-15T00:00:00Z', created_at:'2026-06-15T00:00:00Z' },
    ],
    payouts: [{ id:'po1', amount:78.00, currency:'USD', method:'paypal', reference:'8XY123', paid_at:'2026-07-20T00:00:00Z' }],
  });
  if (p === '/admin/affiliates') return J(res, {
    rates: { monthly: 0.20, yearly: 0.30 },
    affiliates: [
      { id:'a1', user_id:'u1', code:'mk7qtv3n', paypal_email:'alex@example.com', status:'active',
        created_at:'2026-07-01T00:00:00Z', user:{ email:'alex@example.com', full_name:'Alex Morgan' },
        pending:45.60, available:233.10, paid:78.00, referred:4, paying:2 },
      // No payout address and nothing payable: the row must still render, and
      // must not offer a Record payout button.
      { id:'a2', user_id:'u2', code:'wqz4bn8s', paypal_email:null, status:'suspended',
        created_at:'2026-08-20T00:00:00Z', user:{ email:'sam@example.com', full_name:'Sam Diaz' },
        pending:0, available:0, paid:0, referred:1, paying:0 },
    ],
  });
  if (/\/billing\/subscription$/.test(p)) return J(res, {
    subscription: { id:'s1', status:'active', billing_cycle:'monthly', amount:19, currency:'USD',
      plan:{ name:'Professional' }, last_payment_at:'2026-09-01T00:00:00Z',
      activated_at:'2026-06-01T00:00:00Z', approve_url:null },
  });

  if (/\/folders$/.test(p)) return J(res, { folders: [
    { id:'f1', name:'Employee handbook', visibility:'public' },
    { id:'f2', name:'Contracts', visibility:'private' },
  ] });
  // Only API paths get the empty-but-well-shaped answer. Without this guard the
  // stub also answers /admin.html with JSON, every page renders as a blob of
  // text, and the suites fail in a way that looks like a bug in the pages.
  if (p.startsWith('/orgs/') || p.startsWith('/admin/') || p.startsWith('/auth/') || p.startsWith('/public/') || p === '/affiliate' || p.startsWith('/affiliate/')) {
    return J(res, { items:[], total:0, folders:[], members:[], documents:[], checks:[], organizations:[], users:[], admins:[], env_emails:[], env_pending:[] });
  }
  return false;
})).listen(4601, () => console.log('site 4600, app 4601'));
