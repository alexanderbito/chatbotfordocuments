import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireSystemAdmin } from '../auth.js';
import { getUsage } from '../limits.js';
import { logEvent } from '../logger.js';

const router = express.Router();
router.use(requireAuth, requireSystemAdmin);

// =====================================================================
// DASHBOARD & THỐNG KÊ TOÀN HỆ THỐNG
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

    // Doanh thu đã ghi nhận
    const { data: paid } = await supabase.from('payments').select('amount_vnd, created_at').eq('status', 'paid');
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const revenueTotal = (paid || []).reduce((s, p) => s + (p.amount_vnd || 0), 0);
    const revenueMonth = (paid || [])
      .filter((p) => (p.created_at || '').slice(0, 7) === monthKey)
      .reduce((s, p) => s + (p.amount_vnd || 0), 0);

    // Phân bố theo gói cước
    const { data: orgPlans } = await supabase.from('organizations').select('status, plan:plans(code, name)');
    const byPlan = {};
    let suspended = 0;
    for (const o of orgPlans || []) {
      const name = o.plan?.name || 'Chưa gán gói';
      byPlan[name] = (byPlan[name] || 0) + 1;
      if (o.status === 'suspended') suspended++;
    }

    res.json({
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
      revenue: { total_vnd: revenueTotal, this_month_vnd: revenueMonth },
      by_plan: byPlan,
      series,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// QUẢN LÝ TỔ CHỨC
// =====================================================================

/** GET /admin/organizations?q=&status= */
router.get('/organizations', async (req, res) => {
  try {
    let query = supabase
      .from('organizations')
      .select('*, plan:plans(id, code, name, price_vnd, max_documents, max_members)')
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

/** GET /admin/organizations/:id — chi tiết 1 tổ chức */
router.get('/organizations/:id', async (req, res) => {
  try {
    const { data: org, error } = await supabase
      .from('organizations')
      .select('*, plan:plans(*)')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!org) return res.status(404).json({ error: 'Không tìm thấy tổ chức' });

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
      message: `Admin hệ thống cập nhật tổ chức ${data.name}`,
      detail: patch,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /admin/organizations/:id — xoá vĩnh viễn (cascade toàn bộ dữ liệu) */
router.delete('/organizations/:id', async (req, res) => {
  try {
    const { data: org } = await supabase.from('organizations').select('name').eq('id', req.params.id).maybeSingle();
    const { error } = await supabase.from('organizations').delete().eq('id', req.params.id);
    if (error) throw error;
    await logEvent({ level: 'warn', scope: 'system', userId: req.user.id, message: `Đã xoá tổ chức ${org?.name || req.params.id}` });
    res.json({ message: 'Đã xoá tổ chức và toàn bộ dữ liệu liên quan' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// NGƯỜI DÙNG
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

/** PATCH /admin/users/:id { is_system_admin, status } */
router.patch('/users/:id', async (req, res) => {
  try {
    const patch = {};
    if (req.body?.is_system_admin !== undefined) patch.is_system_admin = !!req.body.is_system_admin;
    if (req.body?.status) patch.status = req.body.status;
    if (req.params.id === req.user.id && patch.is_system_admin === false) {
      return res.status(400).json({ error: 'Không thể tự gỡ quyền admin hệ thống của chính mình' });
    }
    const { data, error } = await supabase.from('app_users').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// GÓI CƯỚC
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
    if (!code || !name) return res.status(400).json({ error: 'Thiếu mã hoặc tên gói' });
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
    if (inUse?.length) return res.status(400).json({ error: 'Gói đang được tổ chức sử dụng, hãy chuyển gói trước khi xoá' });
    const { error } = await supabase.from('plans').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Đã xoá gói cước' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizePlan(body = {}) {
  const out = {};
  const strs = ['code', 'name', 'description'];
  const nums = ['price_vnd', 'max_documents', 'max_members', 'max_storage_mb', 'max_questions_per_month', 'sort_order'];
  for (const f of strs) if (body[f] !== undefined) out[f] = body[f];
  for (const f of nums) if (body[f] !== undefined) out[f] = Number(body[f]) || 0;
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  return out;
}

// =====================================================================
// THANH TOÁN
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

/** POST /admin/payments — ghi nhận một khoản thanh toán và gia hạn gói */
router.post('/payments', async (req, res) => {
  try {
    const { organization_id, plan_id, amount_vnd, period_start, period_end, status, method, reference, note } = req.body || {};
    if (!organization_id) return res.status(400).json({ error: 'Thiếu tổ chức' });

    const { data, error } = await supabase
      .from('payments')
      .insert({
        organization_id,
        plan_id: plan_id || null,
        amount_vnd: Number(amount_vnd) || 0,
        period_start: period_start || null,
        period_end: period_end || null,
        status: status || 'paid',
        method: method || 'bank_transfer',
        reference: reference || null,
        note: note || null,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    // Ghi nhận thanh toán thành công thì cập nhật gói + hạn dùng của tổ chức
    if ((status || 'paid') === 'paid') {
      const patch = { billing_status: 'paid' };
      if (plan_id) patch.plan_id = plan_id;
      if (period_end) patch.plan_expires_at = new Date(period_end).toISOString();
      await supabase.from('organizations').update(patch).eq('id', organization_id);
    }

    await logEvent({ scope: 'billing', organizationId: organization_id, userId: req.user.id, message: `Ghi nhận thanh toán ${Number(amount_vnd).toLocaleString('vi-VN')} đ` });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/payments/:id', async (req, res) => {
  try {
    const patch = {};
    for (const f of ['status', 'note', 'reference', 'method']) if (req.body?.[f] !== undefined) patch[f] = req.body[f];
    const { data, error } = await supabase.from('payments').update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// NHẬT KÝ & SỨC KHOẺ HỆ THỐNG
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

/** GET /admin/failed-documents — các tài liệu xử lý lỗi trên toàn hệ thống */
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

/** GET /admin/health — kiểm tra kết nối các dịch vụ phụ thuộc */
router.get('/health', async (req, res) => {
  const checks = [];

  // Supabase
  const t0 = Date.now();
  try {
    const { error } = await supabase.from('organizations').select('id', { head: true, count: 'exact' });
    checks.push({ name: 'Supabase (Postgres)', ok: !error, ms: Date.now() - t0, detail: error?.message || 'Kết nối bình thường' });
  } catch (e) {
    checks.push({ name: 'Supabase (Postgres)', ok: false, ms: Date.now() - t0, detail: e.message });
  }

  // Cloudflare R2
  const t1 = Date.now();
  try {
    const { getDownloadUrl } = await import('../storage.js');
    await getDownloadUrl('healthcheck-probe', null, 60);
    checks.push({ name: 'Cloudflare R2 (lưu trữ)', ok: true, ms: Date.now() - t1, detail: 'Cấu hình hợp lệ' });
  } catch (e) {
    checks.push({ name: 'Cloudflare R2 (lưu trữ)', ok: false, ms: Date.now() - t1, detail: e.message });
  }

  // Voyage AI
  const t2 = Date.now();
  try {
    const { embedText } = await import('../embed.js');
    await embedText('kiểm tra kết nối');
    checks.push({ name: 'Voyage AI (embedding)', ok: true, ms: Date.now() - t2, detail: 'Gọi API thành công' });
  } catch (e) {
    checks.push({ name: 'Voyage AI (embedding)', ok: false, ms: Date.now() - t2, detail: e.message });
  }

  // DeepSeek
  const t3 = Date.now();
  try {
    const { generateAnswer } = await import('../llm.js');
    await generateAnswer('Xin chào', [{ content: 'Đây là đoạn văn bản kiểm tra kết nối.', filename: 'healthcheck.txt' }]);
    checks.push({ name: 'DeepSeek (mô hình trả lời)', ok: true, ms: Date.now() - t3, detail: 'Gọi API thành công' });
  } catch (e) {
    checks.push({ name: 'DeepSeek (mô hình trả lời)', ok: false, ms: Date.now() - t3, detail: e.message });
  }

  res.json({ checked_at: new Date().toISOString(), checks });
});

export default router;
