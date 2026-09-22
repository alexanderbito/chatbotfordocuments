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
import { payos, paypal } from '../payments/index.js';

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

    // Thống kê OCR
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

/**
 * POST /admin/users — tạo một tài khoản quản trị hệ thống mới.
 * Tài khoản này không thuộc doanh nghiệp nào.
 */
router.post('/users', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';
    const fullName = req.body?.full_name || '';

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Email không hợp lệ' });
    if (password.length < 8) return res.status(400).json({ error: 'Mật khẩu quản trị hệ thống phải có ít nhất 8 ký tự' });

    const { data: existed } = await supabase.from('app_users').select('id').ilike('email', email).maybeSingle();
    if (existed) return res.status(400).json({ error: 'Email này đã có tài khoản. Dùng nút cấp quyền ở danh sách người dùng.' });

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (createErr) {
      const msg = /already been registered|already exists/i.test(createErr.message)
        ? 'Email này đã được đăng ký' : createErr.message;
      return res.status(400).json({ error: msg });
    }

    await supabase.from('app_users').upsert({
      id: created.user.id, email, full_name: fullName, is_system_admin: true,
    });

    await logEvent({
      level: 'warn', scope: 'auth', userId: req.user.id,
      message: `Tạo tài khoản quản trị hệ thống mới: ${email}`,
    });

    res.json({ id: created.user.id, email, full_name: fullName, is_system_admin: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /admin/system-admins — ai đang có quyền quản trị hệ thống */
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
      // Email khai báo trong biến môi trường nhưng chưa đăng ký tài khoản
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
      return res.status(400).json({ error: 'Không thể tự gỡ quyền admin hệ thống của chính mình' });
    }

    if (patch.is_system_admin === false) {
      const { data: target } = await supabase.from('app_users').select('email').eq('id', req.params.id).maybeSingle();
      if (target && isSystemAdminEmail(target.email)) {
        return res.status(400).json({
          error: `Email ${target.email} được cấp quyền qua biến môi trường SYSTEM_ADMIN_EMAILS. Hãy gỡ khỏi biến đó trên máy chủ, gỡ ở đây không có tác dụng.`,
        });
      }
    }

    // Phải luôn còn ít nhất một quản trị hệ thống
    if (patch.is_system_admin === false || patch.status === 'disabled') {
      const { count } = await supabase
        .from('app_users')
        .select('id', { count: 'exact', head: true })
        .eq('is_system_admin', true)
        .eq('status', 'active');
      if ((count || 0) <= 1) {
        return res.status(400).json({ error: 'Đây là quản trị hệ thống hoạt động duy nhất, không thể gỡ quyền hoặc khoá.' });
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
  const strs = ['code', 'name', 'name_en', 'description', 'description_en'];
  const nums = ['price_vnd', 'price_usd', 'max_documents', 'max_members', 'max_storage_mb', 'max_questions_per_month', 'max_ocr_pages_per_month', 'sort_order'];
  for (const f of strs) if (body[f] !== undefined) out[f] = body[f];
  for (const f of nums) if (body[f] !== undefined) out[f] = Number(body[f]) || 0;
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  if (body.ocr_enabled !== undefined) out.ocr_enabled = !!body.ocr_enabled;
  if (body.trial_days !== undefined) out.trial_days = Number(body.trial_days) || 0;
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

/**
 * POST /admin/maintenance/fix-filenames
 * Sửa lại tên tài liệu đã lưu bị lỗi font (mojibake latin-1) hoặc còn ở dạng NFD.
 * Chạy ?dry_run=1 để xem trước danh sách sẽ đổi mà chưa ghi vào CSDL.
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
          message: `Đã sửa tên cho ${changes.length} tài liệu bị lỗi font`,
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
 * Dọn dữ liệu của các tổ chức đã hết hạn dùng thử.
 * ?dry_run=1 để chỉ xem danh sách sẽ bị dọn.
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

/** POST /admin/organizations/:id/purge-data — dọn dữ liệu một tổ chức cụ thể */
router.post('/organizations/:id/purge-data', async (req, res) => {
  try {
    const result = await purgeOrganizationData(req.params.id, { reason: 'admin hệ thống yêu cầu' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

  // Gemini — chỉ dùng cho OCR, nên thiếu key là cảnh báo chứ không phải lỗi chặn
  const t4 = Date.now();
  if (!isOcrEnabled()) {
    checks.push({
      name: 'Gemini (nhận dạng PDF scan)',
      ok: false,
      optional: true,
      ms: 0,
      detail: 'Chưa cấu hình GEMINI_API_KEY — PDF dạng scan sẽ báo lỗi khi tải lên',
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
        results.push({ model, ok: r.ok, detail: r.ok ? 'sẵn sàng' : (body?.error?.message || `HTTP ${r.status}`) });
      } catch (e) {
        results.push({ model, ok: false, detail: e.message });
      }
    }
    const anyOk = results.some((r) => r.ok);
    checks.push({
      name: 'Gemini (nhận dạng PDF scan)',
      ok: anyOk,
      ms: Date.now() - t4,
      detail: anyOk
        ? `Chuỗi dự phòng: ${results.map((r) => `${r.model} (${r.ok ? 'OK' : 'lỗi'})`).join(' → ')}`
        : results.map((r) => `${r.model}: ${r.detail}`).join(' | '),
    });
  }

  // Cổng thanh toán — sai cấu hình ở đây là khách trả tiền mà không lên gói,
  // nên kiểm tra tách riêng từng cổng thay vì gộp một dòng chung chung.
  for (const [id, label] of [['payos', 'payOS (VietQR, VND)'], ['paypal', 'PayPal (USD)']]) {
    const t = Date.now();
    const provider = id === 'payos' ? payos : paypal;
    if (!provider.isEnabled()) {
      checks.push({ name: label, ok: false, optional: true, ms: 0, detail: 'Chưa cấu hình — cổng này không hiện ở trang thanh toán' });
      continue;
    }
    try {
      const d = await provider.diagnose();
      checks.push({ name: label, ok: d.ok, warning: d.warning, ms: Date.now() - t, detail: d.detail });
    } catch (e) {
      checks.push({ name: label, ok: false, ms: Date.now() - t, detail: e.message });
    }
  }

  // APP_BASE_URL sai là link quay về sau thanh toán và chữ ký webhook PayPal đều hỏng
  const configured = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const actual = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  checks.push({
    name: 'APP_BASE_URL (địa chỉ công khai)',
    ok: !!configured && configured === actual,
    warning: !!configured && configured !== actual,
    ms: 0,
    detail: !configured
      ? `Chưa đặt APP_BASE_URL — đang tự suy ra "${actual}". Đặt hẳn biến này, nếu không link quay về sau thanh toán sẽ sai khi đổi tên miền.`
      : configured === actual
        ? configured
        : `APP_BASE_URL đang là "${configured}" nhưng bạn đang truy cập qua "${actual}". Webhook PayPal ký theo địa chỉ nên lệch là chữ ký hỏng.`,
  });

  res.json({ checked_at: new Date().toISOString(), checks, queue: queueStats() });
});

export default router;
