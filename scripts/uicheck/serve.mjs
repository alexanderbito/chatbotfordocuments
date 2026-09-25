// Serves the marketing site on 4600 and the application shell on 4601, with a
// stub API so the logged-in pages render.
import http from 'http';
import fs from 'fs';
import path from 'path';

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };

function fileServer(root, api) {
  return (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (api) { const handled = api(p, res); if (handled) return; }
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
  { id:'p1', code:'free', name:'Free trial', description:'Everything except OCR, for 3 days.', price_usd:0, price_usd_yearly:0, trial_days:3, ocr_enabled:false, max_documents:20, max_members:5, max_storage_mb:100, max_questions_per_month:500, max_ocr_pages_per_month:0 },
  { id:'p2', code:'pro', name:'Professional', description:'For a growing team.', price_usd:19, price_usd_yearly:187, trial_days:0, ocr_enabled:true, max_documents:500, max_members:30, max_storage_mb:5000, max_questions_per_month:10000, max_ocr_pages_per_month:2000 },
  { id:'p3', code:'business', name:'Business', description:'For a whole company.', price_usd:79, price_usd_yearly:777, trial_days:0, ocr_enabled:true, max_documents:10000, max_members:300, max_storage_mb:50000, max_questions_per_month:100000, max_ocr_pages_per_month:20000 },
].map(deco);
const J = (res, d) => { res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify(d)); return true; };

http.createServer(fileServer(APP_DIR, (p, res) => {
  if (p === '/auth/me') return J(res, {
    user: { id:'u1', email:'admin@company.com', full_name:'Alex Morgan', is_system_admin:true },
    organizations: [{ id:'o1', name:'Acme Inc.', role:'admin', billing_status:'paid', plan:PLANS[1], trial:{ isTrial:false } }],
  });
  if (p === '/public/billing/plans') return J(res, { currency:'USD', providers:[{ id:'paypal', name:'PayPal / Credit or debit card', description:'Pay with PayPal balance, credit or debit card' }], plans:PLANS });
  if (p.endsWith('/billing')) return J(res, {
    plan: PLANS[1], billing_status:'paid', plan_expires_at:'2026-12-31T00:00:00Z', trial:{ isTrial:false },
    usage: { documents:12, members:4, questions_this_month:340, storage_mb:82, ocr_pages_this_month:15,
      limits:{ max_documents:500, max_members:30, max_questions_per_month:10000, max_storage_mb:5000, max_ocr_pages_per_month:2000 } },
    payments: [{ id:'x1', created_at:'2026-09-01T00:00:00Z', period_start:'2026-09-01', period_end:'2027-09-01', amount:187, currency:'USD', billing_cycle:'yearly', method:'paypal', status:'paid', paid_at:'2026-09-01T00:00:00Z' }],
    available_plans: PLANS, providers:[{ id:'paypal', name:'PayPal / Credit or debit card', description:'Pay' }],
  });
  if (p.startsWith('/orgs/') || p.startsWith('/admin/')) return J(res, { items:[], total:0, folders:[], members:[], documents:[], checks:[], organizations:[], users:[], admins:[], env_emails:[], env_pending:[] });
  return false;
})).listen(4601, () => console.log('site 4600, app 4601'));
