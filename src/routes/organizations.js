import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { getUsage } from '../limits.js';
import { availableProviders } from '../payments/index.js';
import { maybeSweep } from '../trials.js';
import foldersRouter from './folders.js';
import documentsRouter from './documents.js';
import membersRouter from './members.js';
import chatRouter from './chat.js';
import billingRouter from './billing.js';

const router = express.Router();

// Các nhóm chức năng con của một tổ chức
router.use('/:orgId/folders', foldersRouter);
router.use('/:orgId/documents', documentsRouter);
router.use('/:orgId/members', membersRouter);
router.use('/:orgId/chat', chatRouter);
router.use('/:orgId/billing', billingRouter);

/** GET /orgs/:orgId — thông tin tổ chức + vai trò của người đang đăng nhập */
router.get('/:orgId', requireAuth, requireOrgMember, async (req, res) => {
  // Bám vào lưu lượng thật để dọn dữ liệu hết hạn, không cần cron ngoài
  maybeSweep();

  res.json({
    organization: {
      id: req.org.id,
      name: req.org.name,
      status: req.org.status,
      billing_status: req.org.billing_status,
      plan: req.org.plan,
      plan_expires_at: req.org.plan_expires_at,
      contact_email: req.org.contact_email,
      tax_code: req.org.tax_code,
      created_at: req.org.created_at,
    },
    role: req.membership.role,
    trial: req.trial,
  });
});

/** PATCH /orgs/:orgId — cập nhật hồ sơ doanh nghiệp (admin tổ chức) */
router.patch('/:orgId', requireAuth, requireOrgMember, requireOrgAdmin, async (req, res) => {
  try {
    const patch = {};
    for (const f of ['name', 'contact_email', 'tax_code']) {
      if (req.body?.[f] !== undefined) patch[f] = req.body[f];
    }
    const { data, error } = await supabase
      .from('organizations')
      .update(patch)
      .eq('id', req.org.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/overview — số liệu cho dashboard admin tổ chức */
router.get('/:orgId/overview', requireAuth, requireOrgMember, requireOrgAdmin, async (req, res) => {
  try {
    const usage = await getUsage(req.org.id, req.org.plan);

    const since = new Date();
    since.setDate(since.getDate() - 29);
    since.setHours(0, 0, 0, 0);

    const [{ data: statusRows }, { data: recentChats }, { data: recentDocs }, { data: chatDays }] = await Promise.all([
      supabase.from('documents').select('status').eq('organization_id', req.org.id),
      supabase
        .from('chat_messages')
        .select('id, question, user_email, created_at')
        .eq('organization_id', req.org.id)
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('documents')
        .select('id, filename, status, created_at')
        .eq('organization_id', req.org.id)
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('chat_messages')
        .select('created_at')
        .eq('organization_id', req.org.id)
        .gte('created_at', since.toISOString()),
    ]);

    const byStatus = { ready: 0, processing: 0, failed: 0 };
    for (const r of statusRows || []) byStatus[r.status] = (byStatus[r.status] || 0) + 1;

    // Chuỗi 30 ngày gần nhất cho biểu đồ
    const series = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      series.push({ day: d.toISOString().slice(0, 10), questions: 0 });
    }
    const idx = Object.fromEntries(series.map((s, i) => [s.day, i]));
    for (const c of chatDays || []) {
      const k = new Date(c.created_at).toISOString().slice(0, 10);
      if (idx[k] !== undefined) series[idx[k]].questions++;
    }

    res.json({
      usage,
      documents_by_status: byStatus,
      recent_chats: recentChats || [],
      recent_documents: recentDocs || [],
      questions_series: series,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/billing — gói cước hiện tại + lịch sử thanh toán */
router.get('/:orgId/billing', requireAuth, requireOrgMember, requireOrgAdmin, async (req, res) => {
  try {
    const [{ data: payments }, { data: plans }] = await Promise.all([
      supabase
        .from('payments')
        .select('*')
        .eq('organization_id', req.org.id)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase.from('plans').select('*').eq('is_active', true).order('sort_order'),
    ]);

    const usage = await getUsage(req.org.id, req.org.plan);
    res.json({
      plan: req.org.plan,
      billing_status: req.org.billing_status,
      plan_expires_at: req.org.plan_expires_at,
      billing_country: req.org.billing_country || 'VN',
      trial: req.trial,
      usage,
      payments: payments || [],
      available_plans: plans || [],
      providers: availableProviders(req.org.billing_country),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
