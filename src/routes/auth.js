import express from 'express';
import { supabase, supabaseAuth } from '../supabaseClient.js';
import { requireAuth } from '../auth.js';
import { trialStatus } from '../trials.js';
import { logEvent } from '../logger.js';

const router = express.Router();

/**
 * POST /auth/register
 * Hai kịch bản:
 *  - Có organization_name  -> tạo tài khoản + tổ chức mới, người đăng ký là ADMIN tổ chức
 *  - Có invite_token       -> tạo tài khoản và tham gia tổ chức đã mời với vai trò được gán sẵn
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, organization_name, invite_token } = req.body || {};

    if (!email || !password) return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });
    if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự' });
    if (!organization_name && !invite_token) {
      return res.status(400).json({ error: 'Cần nhập tên doanh nghiệp hoặc mã lời mời' });
    }

    let invite = null;
    if (invite_token) {
      const { data } = await supabase
        .from('organization_members')
        .select('*')
        .eq('invite_token', invite_token)
        .maybeSingle();
      if (!data) return res.status(400).json({ error: 'Mã lời mời không hợp lệ hoặc đã được dùng' });
      if (data.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({ error: `Lời mời này dành cho email ${data.email}` });
      }
      invite = data;
    }

    // 1. Tạo user trong Supabase Auth (xác nhận email luôn để dùng được ngay)
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name || '' },
    });
    if (createErr) {
      const msg = /already been registered|already exists/i.test(createErr.message)
        ? 'Email này đã được đăng ký'
        : createErr.message;
      return res.status(400).json({ error: msg });
    }

    const userId = created.user.id;

    // 2. Hồ sơ người dùng
    await supabase.from('app_users').upsert({
      id: userId,
      email,
      full_name: full_name || '',
    });

    // 3. Gắn vào tổ chức
    if (invite) {
      await supabase
        .from('organization_members')
        .update({ user_id: userId, status: 'active', invite_token: null })
        .eq('id', invite.id);
      await logEvent({ scope: 'auth', organizationId: invite.organization_id, userId, message: `Thành viên ${email} đã chấp nhận lời mời` });
    } else {
      const { data: freePlan } = await supabase
        .from('plans')
        .select('id, trial_days')
        .eq('code', 'free')
        .maybeSingle();

      // Đồng hồ dùng thử bắt đầu chạy ngay khi đăng ký
      const trialDays = Number(freePlan?.trial_days || 0);
      const now = new Date();
      const expiresAt = trialDays > 0
        ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const { data: org, error: orgErr } = await supabase
        .from('organizations')
        .insert({
          name: organization_name,
          owner_id: userId,
          plan_id: freePlan?.id || null,
          contact_email: email,
          status: 'active',
          billing_status: 'trial',
          trial_started_at: now.toISOString(),
          plan_expires_at: expiresAt,
        })
        .select()
        .single();
      if (orgErr) throw orgErr;

      await supabase.from('organization_members').insert({
        organization_id: org.id,
        user_id: userId,
        email,
        role: 'admin',
        status: 'active',
      });

      await supabase.from('folders').insert({
        organization_id: org.id,
        name: 'Tài liệu chung',
        created_by: userId,
      });

      await logEvent({ scope: 'auth', organizationId: org.id, userId, message: `Doanh nghiệp mới đăng ký: ${organization_name} (dùng thử ${trialDays} ngày)` });
    }

    // 4. Đăng nhập luôn để trả token về cho frontend
    const { data: session, error: signErr } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (signErr) return res.json({ message: 'Đăng ký thành công, vui lòng đăng nhập', requires_login: true });

    res.json({ access_token: session.session.access_token, refresh_token: session.session.refresh_token });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /auth/login  { email, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Thiếu email hoặc mật khẩu' });

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });

    const userId = data.user.id;
    // Đảm bảo luôn có hồ sơ app_users (phòng trường hợp user tạo tay trên Supabase)
    await supabase.from('app_users').upsert(
      { id: userId, email: data.user.email, last_login_at: new Date().toISOString() },
      { onConflict: 'id', ignoreDuplicates: false }
    );

    res.json({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /auth/me — thông tin tài khoản + danh sách tổ chức đang tham gia
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    let organizations = [];

    if (req.user.is_system_admin) {
      const { data } = await supabase
        .from('organizations')
        .select('id, name, status, plan:plans(code, name)')
        .order('created_at', { ascending: false })
        .limit(200);
      organizations = (data || []).map((o) => ({ ...o, role: 'admin' }));
    } else {
      const { data } = await supabase
        .from('organization_members')
        .select('role, status, organization:organizations(id, name, status, billing_status, plan_expires_at, trial_data_purged_at, plan:plans(code, name, trial_days, ocr_enabled))')
        .eq('user_id', req.user.id)
        .eq('status', 'active');
      organizations = (data || [])
        .filter((m) => m.organization)
        .map((m) => ({ ...m.organization, role: m.role, trial: trialStatus(m.organization) }));
    }

    res.json({ user: req.user, organizations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /auth/change-password { current_password, new_password }
 */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!new_password || new_password.length < 6) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
    }
    const { error: checkErr } = await supabaseAuth.auth.signInWithPassword({
      email: req.user.email,
      password: current_password || '',
    });
    if (checkErr) return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password: new_password });
    if (error) throw error;
    res.json({ message: 'Đã đổi mật khẩu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /auth/profile { full_name, phone }
 */
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { full_name, phone } = req.body || {};
    const { data, error } = await supabase
      .from('app_users')
      .update({ full_name, phone })
      .eq('id', req.user.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /auth/invite/:token — xem thông tin lời mời (không cần đăng nhập)
 */
router.get('/invite/:token', async (req, res) => {
  const { data } = await supabase
    .from('organization_members')
    .select('email, role, organization:organizations(name)')
    .eq('invite_token', req.params.token)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: 'Lời mời không tồn tại hoặc đã được sử dụng' });
  res.json({ email: data.email, role: data.role, organization_name: data.organization?.name });
});

export default router;
