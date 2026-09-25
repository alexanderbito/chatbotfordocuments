import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireSystemAdmin } from '../auth.js';
import { getUsage } from '../limits.js';
import { logEvent } from '../logger.js';
import { decodeFilename } from '../utils/filename.js';
import { queueStats } from '../queue.js';
import { purgeExpiredTrials, purgeOrganizationData } from '../trials.js';
import { systemAdminEmails, isSystemAdminEmail } from '../systemAdmins.js';
import { isOcrEnabled, ocrModels } from '../ocr.js';
import { paypal } from '../payments/index.js';
import { renderInvoice, sendInvoice } from './billing.js';

const router = express.Router();
router.use(requireAuth, requireSystemAdmin);

// =====================================================================
// DASHBOARD & PLATFORM-WIDE STATISTICS
// =====================================================================

/** GET /admin/overview */
router.get('/overview', async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);

    const [orgs, users, docs, chunks, chats, chats30, docs30, failedDocs, sizes] = await Promise.all([
      supabase.from('organizations').select('id', { count: 'exact', head: true }),
      supabase.from('app_users').select('id', { count: 'exact', head: true }),
      supabase.from('documents').select('id', { count: 'exact', head: true }),
      supabase.from('document_chunks').select('id', { count: 'exact', head: true }),
      supabase.from('chat_messages').select('id', { count: 'exact', head: true }),
      supabase.from('chat_messages').select('created_at').gte('created_at', since.toISOString()),
      supabase.from('documents').select('created_at').gte('created_at', since.toISOString()),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      supabase.from('documents').select('size_bytes'),
    ]);

    const series = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      series.push({ day: d.toISOString().slice(0, 10), questions: 0, documents: 0 });
    }
    const idx = Object.fromEntries(series.map((s, i) => [s.day, i]));
    for (const c of chats30.data || []) {
      const k = new Date(c.created_at).toISOString().slice(0, 10);
      if (idx[k] !== undefined) series[idx[k]].questions++;
    }
    for (const d of docs30.data || []) {
      const k = new Date(d.created_at).toISOString().slice(0, 10);
      if (idx[k] !== undefined) series[idx[k]].documents++;
    }

    const storageBytes = (sizes.data || []).reduce((s, d) => s + (d.size_bytes || 0), 0);

    // Recorded revenue. Only USD rows are summed: any legacy row settled in
    // another currency would otherwise be added to the total at face value.
    const { data: paid } = await supabase.from('payments').select('amount, currency, created_at').eq('status', 'paid');
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const usd = (paid || []).filter((p) => (p.currency || 'USD') === 'USD');
    const revenueTotal = usd.reduce((s, p) => s + Number(p.amount || 0), 0);
    const revenueMonth = usd
      .filter((p) => (p.created_at || '').slice(0, 7) === monthKey)
      .reduce((s, p) => s + Number(p.amount || 0), 0);

    // Breakdown by plan
    const { data: orgPlans } = await supabase.from('organizations').select('status, plan:plans(code, name)');
    const byPlan = {};
    let suspended = 0;
    for (const o of orgPlans || []) {
      const name = o.plan?.name || 'No plan assigned';
      byPlan[name] = (byPlan[name] || 0) + 1;
      if (o.status === 'suspended') suspended++;
    }

    // OCR statistics
    const { data: ocrRows } = await supabase.from('documents').select('ocr_pages, extraction_method, created_at');
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const ocr = (ocrRows || []).reduce(
      (acc, d) => {
        acc.pages_total += d.ocr_pages || 0;
        if ((d.created_at || '').slice(0, 7) === monthPrefix) acc.pages_this_month += d.ocr_pages || 0;
        if (d.extraction_method === 'ocr') acc.documents += 1;
        return acc;
      },
      { documents: 0, pages_total: 0, pages_this_month: 0 }
    );

    res.json({
      ocr,
      totals: {
        organizations: orgs.count || 0,
        users: users.count || 0,
        documents: docs.count || 0,
        chunks: chunks.count || 0,
        questions: chats.count || 0,
        failed_documents: failedDocs.count || 0,
        suspended_organizations: suspended,
        storage_mb: Math.round((storageBytes / (1024 * 1024)) * 100) / 100,
      },
      revenue: { total: revenueTotal, this_month: revenueMonth },
      by_plan: byPlan,
      series,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// ORGANIZATION MANAGEMENT
// =====================================================================

/** GET /admin/organizations?q=&status= */
router.get('/organizations', async (req, res) => {
  try {
    let query = supabase
      .from('organizations')
      .select('*, plan:plans(id, code, name, price_usd, max_documents, max_members)')
      .order('created_at', { ascending: false });

    if (req.query.q) query = query.ilike('name', `%${req.query.q}%`);
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;

    const orgIds = (data || []).map((o) => o.id);
    const counts = { docs: {}, members: {}, chats: {} };

    if (orgIds.length) {
      const [{ data: docs }, { data: members }, { data: chats }] = await Promise.all([
        supabase.from('documents').select('organization_id').in('organization_id', orgIds),
        supabase.from('organization_members').select('organization_id').in('organization_id', orgIds),
        supabase.from('chat_messages').select('organization_id').in('organization_id', orgIds),
      ]);
      for (const d of docs || []) counts.docs[d.organization_id] = (counts.docs[d.organization_id] || 0) + 1;
      for (const m of members || []) counts.members[m.organization_id] = (counts.members[m.organization_id] || 0) + 1;
      for (const c of chats || []) counts.chats[c.organization_id] = (counts.chats[c.organization_id] || 0) + 1;
    }

    const ownerIds = [...new Set((data || []).map((o) => o.owner_id).filter(Boolean))];
    let owners = {};
    if (ownerIds.length) {
      const { data: us } = await supabase.from('app_users').select('id, email, full_name').in('id', ownerIds);
      owners = Object.fromEntries((us || []).map((u) => [u.id, u]));
    }

    res.json(
      (data || []).map((o) => ({
        ...o,
        owner_email: owners[o.owner_id]?.email || '—',
        owner_name: owners[o.owner_id]?.full_name || '',
        document_count: counts.docs[o.id] || 0,
        member_count: counts.members[o.id] || 0,
        question_count: counts.chats[o.id] || 0,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/organizations/:id — full detail for one organization */
router.get('/organizations/:id', async (req, res) => {
  try {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('*, plan:plans(*)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const [usage, { data: members }, { data: payments }, { data: recentDocs }] = await Promise.all([
      getUsage(org.id, org.plan),
      supabase.from('organization_members').select('email, role, status, created_at').eq('organization_id', org.id),
      supabase.from('payments').select('*').eq('organization_id', org.id).order('created_at', { ascending: false }).limit(20),
      supabase.from('documents').select('id, filename, status, created_at').eq('organization_id', org.id).order('created_at', { ascending: false }).limit(10),
    ]);

    res.json({ organization: org, usage, members: members || [], payments: payments || [], recent_documents: recentDocs || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /admin/organizations/:id { name, status, plan_id, billing_status, plan_expires_at, note } */
router.patch('/organizations/:id', async (req, res) => {
  try {
    const patch = {};
    for (const f of ['name', 'status', 'plan_id', 'billing_status', 'plan_expires_at', 'note', 'contact_email', 'tax_code']) {
      if (req.body?.[f] !== undefined) patch[f] = req.body[f] || null;
    }
    const { data, error } = await supabase
      .from('organizations')
      .update(patch)
      .eq('id', req.params.id)
      .select('*, plan:plans(*)')
      .single();
    if (error) throw error;

    await logEvent({
      scope: 'billing',
      organizationId: req.params.id,
      userId: req.user.id,
      message: `System admin updated the organization ${data.name}`,
      detail: patch,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /admin/organizations/:id — permanent delete, cascading to all its data */
router.delete('/organizations/:id', async (req, res) => {
  try {
    const { data: org } = await supabase.from('organizations').select('name').eq('id', req.params.id).maybeSingle();
    const { error } = await supabase.from('organizations').delete().eq('id', req.params.id);
    if (error) throw error;
    await logEvent({ level: 'warn', scope: 'system', userId: req.user.id, message: `Deleted the organization ${org?.name || req.params.id}` });
    res.json({ message: 'Organization and all related data deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// USERS
// =====================================================================

/** GET /admin/users?q= */
router.get('/users', async (req, res) => {
  try {
    let query = supabase.from('app_users').select('*').order('created_at', { ascending: false }).limit(500);
    if (req.query.q) query = query.ilike('email', `%${req.query.q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/users — create a new system administrator account.
 * The account belongs to no organization.
 */
router.post('/users', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    const fullName = req.body?.full_name || '';

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email address is not valid' });
    if (password.length < 8) return res.status(400).json({ error: 'A system administrator password must be at least 8 characters' });

    const { data: existed } = await supabase.from('app_users').select('id').ilike('email', email).maybeSingle();
    if (existed) return res.status(400).json({ error: 'That email already has an account. Use "Grant admin" in the user list instead.' });

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (createErr) {
      const msg = /already been registered|already exists/i.test(createErr.message)
        ? 'That email is already registered' : createErr.message;
      return res.status(400).json({ error: msg });
    }

    await supabase.from('app_users').upsert({
      id: created.user.id, email, full_name: fullName, is_system_admin: true,
    });

    await logEvent({
      level: 'warn', scope: 'auth', userId: req.user.id,
      message: `Created a new system administrator account: ${email}`,
    });

    res.json({ id: created.user.id, email, full_name: fullName, is_system_admin: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/system-admins — who currently holds system access */
router.get('/system-admins', async (req, res) => {
  try {
    const { data } = await supabase
      .from('app_users')
      .select('id, email, full_name, status, last_login_at, created_at')
      .eq('is_system_admin', true)
      .order('created_at');

    const envList = systemAdminEmails();
    res.json({
      admins: (data || []).map((u) => ({ ...u, from_env: envList.includes(String(u.email).toLowerCase()) })),
      env_emails: envList,
      // Listed in the environment variable but has not registered an account yet
      env_pending: envList.filter((e) => !(data || []).some((u) => String(u.email).toLowerCase() === e)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /admin/users/:id { is_system_admin, status } */
router.patch('/users/:id', async (req, res) => {
  try {
    const patch = {};
    if (req.body?.is_system_admin !== undefined) patch.is_system_admin = !!req.body.is_system_admin;
    if (req.body?.status) patch.status = req.body.status;
    if (req.params.id === req.user.id && patch.is_system_admin === false) {
      return res.status(400).json({ error: 'You cannot revoke your own system access' });
    }

    if (patch.is_system_admin === false) {
      const { data: target } = await supabase.from('app_users').select('email').eq('id', req.params.id).maybeSingle();
      if (target && isSystemAdminEmail(target.email)) {
        return res.status(400).json({
          error: `${target.email} is granted access through the SYSTEM_ADMIN_EMAILS environment variable. Remove it there on the server — revoking here has no effect.`,
        });
      }
    }

    // There must always be at least one system administrator left
    if (patch.is_system_admin === false || patch.status === 'disabled') {
      const { count } = await supabase
        .from('app_users')
        .select('id', { count: 'exact', head: true })
        .eq('is_system_admin', true)
        .eq('status', 'active');
      if ((count || 0) <= 1) {
        return res.status(400).json({ error: 'This is the only active system administrator, so it cannot be revoked or blocked.' });
      }
    }
    const { data, error } = await supabase.from('app_users').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// PLANS
// =====================================================================

router.get('/plans', async (req, res) => {
  const { data, error } = await supabase.from('plans').select('*').order('sort_order');
  if (error) return res.status(500).json({ error: error.message });

  const { data: orgs } = await supabase.from('organizations').select('plan_id');
  const counts = {};
  for (const o of orgs || []) counts[o.plan_id] = (counts[o.plan_id] || 0) + 1;

  res.json((data || []).map((p) => ({ ...p, organization_count: counts[p.id] || 0 })));
});

router.post('/plans', async (req, res) => {
  try {
    const { code, name } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'Plan code and name are required' });
    const { data, error } = await supabase.from('plans').insert(sanitizePlan(req.body)).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/plans/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('plans').update(sanitizePlan(req.body)).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/plans/:id', async (req, res) => {
  try {
    const { data: inUse } = await supabase.from('organizations').select('id').eq('plan_id', req.params.id).limit(1);
    if (inUse?.length) return res.status(400).json({ error: 'Organizations are still on this plan. Move them to another plan before deleting it.' });
    const { error } = await supabase.from('plans').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizePlan(body = {}) {
  const out = {};
  const strs = ['code', 'name', 'description'];
  const nums = ['price_usd', 'price_usd_yearly', 'max_documents', 'max_members', 'max_storage_mb', 'max_questions_per_month', 'max_ocr_pages_per_month', 'sort_order'];
  for (const f of strs) if (body[f] !== undefined) out[f] = body[f];
  for (const f of nums) if (body[f] !== undefined) out[f] = Number(body[f]) || 0;
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  if (body.ocr_enabled !== undefined) out.ocr_enabled = !!body.ocr_enabled;
  if (body.trial_days !== undefined) out.trial_days = Number(body.trial_days) || 0;
  return out;
}

// =====================================================================
// PAYMENTS
// =====================================================================

router.get('/payments', async (req, res) => {
  try {
    let query = supabase
      .from('payments')
      .select('*, organization:organizations(name), plan:plans(name)')
      .order('created_at', { ascending: false })
      .limit(300);
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/payments — record a payment by hand and extend the plan */
router.post('/payments', async (req, res) => {
  try {
    const { organization_id, plan_id, amount, period_start, period_end, status, method, reference, note, billing_cycle } = req.body || {};
    if (!organization_id) return res.status(400).json({ error: 'An organization is required' });
    const paid = (status || 'paid') === 'paid';

    const { data, error } = await supabase
      .from('payments')
      .insert({
        organization_id,
        plan_id: plan_id || null,
        amount: Number(amount) || 0,
        currency: 'USD',
        billing_cycle: billing_cycle === 'yearly' ? 'yearly' : 'monthly',
        period_start: period_start || null,
        period_end: period_end || null,
        status: status || 'paid',
        // A hand-recorded payment marked as received is received: without
        // paid_at the row showed as "Received" in the table while the invoice
        // route refused it as unpaid, and the download button never appeared.
        // These rows do not go through activate_paid_plan — the admin sets the
        // dates themselves below — so paid_at has to be written here.
        paid_at: paid ? new Date().toISOString() : null,
        method: method || 'manual',
        reference: reference || null,
        note: note || null,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    // A payment recorded as received updates the organization's plan and expiry
    if (paid) {
      const patch = { billing_status: 'paid' };
      if (plan_id) patch.plan_id = plan_id;
      if (period_end) patch.plan_expires_at = new Date(period_end).toISOString();
      await supabase.from('organizations').update(patch).eq('id', organization_id);
    }

    await logEvent({ scope: 'billing', organizationId: organization_id, userId: req.user.id, message: `Recorded a payment of $${Number(amount || 0).toLocaleString('en-US')}` });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/payments/:id/invoice.pdf — the same invoice, for any organization */
router.get('/payments/:id/invoice.pdf', async (req, res) => {
  try {
    const { data: payment } = await supabase
      .from('payments')
      .select('*, plan:plans(name, description)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!payment) return res.status(404).json({ error: 'Transaction not found' });
    if (!payment.paid_at) {
      return res.status(409).json({ error: 'This payment has not been received yet, so there is no invoice for it' });
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', payment.organization_id)
      .maybeSingle();
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const out = await renderInvoice(payment, org);
    sendInvoice(res, out.pdf, out.payment);
  } catch (err) {
    console.error('invoice error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/payments/:id', async (req, res) => {
  try {
    const patch = {};
    for (const f of ['note', 'reference', 'method'] ) if (req.body?.[f] !== undefined) patch[f] = req.body[f];

    // Marking a row as received goes through activate_paid_plan rather than
    // writing status and paid_at here.
    //
    // Writing paid_at by hand looked harmless and was not: paid_at is the one
    // marker that means "this money has already bought time". Stamping it on a
    // PENDING GATEWAY row — which is what the "Mark as received" button offers
    // for every pending row, PayPal ones included — made the later webhook a
    // no-op, so the customer paid and the plan was never extended, silently and
    // with nothing left that could repair it. Going through the function means
    // the row is only ever marked paid together with the time it bought, and a
    // webhook that arrives afterwards correctly finds the work already done.
    if (req.body?.status === 'paid') {
      const { data: activated, error: rpcError } = await supabase.rpc('activate_paid_plan', { p_payment_id: req.params.id });
      if (rpcError) throw rpcError;
      await logEvent({
        scope: 'billing', userId: req.user.id,
        message: activated
          ? `Marked payment ${req.params.id} as received and extended the plan`
          : `Payment ${req.params.id} was already recorded as received`,
      });
    } else if (req.body?.status !== undefined) {
      patch.status = req.body.status;
    }

    if (Object.keys(patch).length) {
      const { error } = await supabase.from('payments').update(patch).eq('id', req.params.id);
      if (error) throw error;
    }
    const { data, error } = await supabase.from('payments').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// ACTIVITY LOG & SYSTEM HEALTH
// =====================================================================

router.get('/logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(200, parseInt(req.query.size || '50', 10));
    const from = (page - 1) * size;

    let query = supabase
      .from('system_logs')
      .select('*, organization:organizations(name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + size - 1);

    if (req.query.level) query = query.eq('level', req.query.level);
    if (req.query.scope) query = query.eq('scope', req.query.scope);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data || [], total: count || 0, page, size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/failed-documents — documents that failed to process, platform-wide */
router.get('/failed-documents', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('id, filename, error_message, created_at, organization:organizations(id, name)')
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/**
 * POST /admin/maintenance/fix-filenames
 * Repair stored document names that are latin-1 mojibake or still in NFD form.
 * Pass ?dry_run=1 to preview the changes without writing to the database.
 */
router.post('/maintenance/fix-filenames', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;

    const { data: docs, error } = await supabase
      .from('documents')
      .select('id, filename, organization_id');
    if (error) throw error;

    const changes = [];
    for (const d of docs || []) {
      const fixed = decodeFilename(d.filename);
      if (fixed && fixed !== d.filename) changes.push({ id: d.id, from: d.filename, to: fixed });
    }

    if (!dryRun) {
      for (const c of changes) {
        await supabase.from('documents').update({ filename: c.to }).eq('id', c.id);
      }
      if (changes.length) {
        await logEvent({
          scope: 'system',
          userId: req.user.id,
          message: `Repaired the names of ${changes.length} documents`,
        });
      }
    }

    res.json({ scanned: (docs || []).length, changed: changes.length, dry_run: dryRun, changes: changes.slice(0, 100) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/maintenance/purge-trials
 * Purge the data of organizations whose trial has expired.
 * Pass ?dry_run=1 to list what would be purged without touching anything.
 */
router.post('/maintenance/purge-trials', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === '1';

    if (dryRun) {
      const { data, error } = await supabase.rpc('list_expired_trials', { grace_hours: 0 });
      if (error) throw error;
      return res.json({ dry_run: true, organizations: data || [] });
    }

    const result = await purgeExpiredTrials();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/organizations/:id/purge-data — purge one specific organization */
router.post('/organizations/:id/purge-data', async (req, res) => {
  try {
    const result = await purgeOrganizationData(req.params.id, { reason: 'requested by a system administrator' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/health — check connectivity to every upstream service */
router.get('/health', async (req, res) => {
  const checks = [];

  // Supabase
  const t0 = Date.now();
  try {
    const { error } = await supabase.from('organizations').select('id', { head: true, count: 'exact' });
    checks.push({ name: 'Supabase (Postgres)', ok: !error, ms: Date.now() - t0, detail: error?.message || 'Connection healthy' });
  } catch (e) {
    checks.push({ name: 'Supabase (Postgres)', ok: false, ms: Date.now() - t0, detail: e.message });
  }

  // Cloudflare R2
  const t1 = Date.now();
  try {
    const { getDownloadUrl } = await import('../storage.js');
    await getDownloadUrl('healthcheck-probe', null, 60);
    checks.push({ name: 'Cloudflare R2 (storage)', ok: true, ms: Date.now() - t1, detail: 'Configuration valid' });
  } catch (e) {
    checks.push({ name: 'Cloudflare R2 (storage)', ok: false, ms: Date.now() - t1, detail: e.message });
  }

  // Voyage AI
  const t2 = Date.now();
  try {
    const { embedText } = await import('../embed.js');
    await embedText('connectivity check');
    checks.push({ name: 'Voyage AI (embeddings)', ok: true, ms: Date.now() - t2, detail: 'API call succeeded' });
  } catch (e) {
    checks.push({ name: 'Voyage AI (embeddings)', ok: false, ms: Date.now() - t2, detail: e.message });
  }

  // DeepSeek
  const t3 = Date.now();
  try {
    const { generateAnswer } = await import('../llm.js');
    await generateAnswer('Hello', [{ content: 'This is a short passage used to check connectivity.', filename: 'healthcheck.txt' }]);
    checks.push({ name: 'DeepSeek (answer model)', ok: true, ms: Date.now() - t3, detail: 'API call succeeded' });
  } catch (e) {
    checks.push({ name: 'DeepSeek (answer model)', ok: false, ms: Date.now() - t3, detail: e.message });
  }

  // Gemini is only used for OCR, so a missing key is a warning rather than a failure
  const t4 = Date.now();
  if (!isOcrEnabled()) {
    checks.push({
      name: 'Gemini (scanned-PDF OCR)',
      ok: false,
      optional: true,
      ms: 0,
      detail: 'GEMINI_API_KEY is not set — uploading a scanned PDF will fail',
    });
  } else {
    const models = ocrModels();
    const results = [];
    for (const model of models) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
          headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
          signal: AbortSignal.timeout(15000),
        });
        const body = await r.json().catch(() => ({}));
        results.push({ model, ok: r.ok, detail: r.ok ? 'ready' : (body?.error?.message || `HTTP ${r.status}`) });
      } catch (e) {
        results.push({ model, ok: false, detail: e.message });
      }
    }
    const anyOk = results.some((r) => r.ok);
    checks.push({
      name: 'Gemini (scanned-PDF OCR)',
      ok: anyOk,
      ms: Date.now() - t4,
      detail: anyOk
        ? `Fallback chain: ${results.map((r) => `${r.model} (${r.ok ? 'OK' : 'failed'})`).join(' → ')}`
        : results.map((r) => `${r.model}: ${r.detail}`).join(' | '),
    });
  }

  // Payment gateway. A misconfiguration here means customers pay and never get
  // upgraded, so it is checked on its own line rather than folded into a summary.
  {
    const t = Date.now();
    const label = 'PayPal (USD)';
    if (!paypal.isEnabled()) {
      checks.push({ name: label, ok: false, optional: true, ms: 0, detail: 'Not configured — no payment method is offered at checkout' });
    } else {
      try {
        const d = await paypal.diagnose();
        checks.push({ name: label, ok: d.ok, warning: d.warning, ms: Date.now() - t, detail: d.detail });
      } catch (e) {
        checks.push({ name: label, ok: false, ms: Date.now() - t, detail: e.message });
      }
    }
  }

  // A wrong APP_BASE_URL breaks both the post-payment return link and PayPal's webhook signature
  const configured = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const actual = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  checks.push({
    name: 'APP_BASE_URL (public address)',
    ok: !!configured && configured === actual,
    warning: !!configured && configured !== actual,
    ms: 0,
    detail: !configured
      ? `APP_BASE_URL is not set — falling back to "${actual}". Set it explicitly, or the post-payment return link will break the moment the domain changes.`
      : configured === actual
        ? configured
        : `APP_BASE_URL is "${configured}" but you reached this page over "${actual}". PayPal signs webhooks against the address, so a mismatch breaks signature verification.`,
  });

  res.json({ checked_at: new Date().toISOString(), checks, queue: queueStats() });
});

export default router;
