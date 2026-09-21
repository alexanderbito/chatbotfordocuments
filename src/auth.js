import { supabase } from './supabaseClient.js';
import { trialStatus, EXPIRED_MESSAGE } from './trials.js';
import { isSystemAdminEmail } from './systemAdmins.js';

/**
 * Lấy access token từ header Authorization: Bearer <token>
 */
function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Bắt buộc đăng nhập. Gắn req.user = { id, email, full_name, is_system_admin, ... }
 */
export async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'Bạn cần đăng nhập để tiếp tục' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại' });
    }

    const { data: profile } = await supabase
      .from('app_users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profile?.status === 'disabled') {
      return res.status(403).json({ error: 'Tài khoản đã bị khoá' });
    }

    // Quyền admin hệ thống: cờ trong CSDL HOẶC email nằm trong SYSTEM_ADMIN_EMAILS.
    // Vế thứ hai là đường "phá kính lấy búa" để lập tài khoản đầu tiên và để
    // lấy lại quyền nếu lỡ tự gỡ mất.
    const byEnv = isSystemAdminEmail(data.user.email);
    const isSystemAdmin = !!profile?.is_system_admin || byEnv;

    // Nếu được cấp qua biến môi trường mà CSDL chưa ghi nhận thì đồng bộ lại,
    // để các trang liệt kê người dùng hiển thị đúng.
    if (byEnv && profile && !profile.is_system_admin) {
      supabase.from('app_users').update({ is_system_admin: true }).eq('id', data.user.id)
        .then(() => {}, (err) => console.error('không đồng bộ được cờ admin:', err.message));
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
      full_name: profile?.full_name || data.user.user_metadata?.full_name || '',
      is_system_admin: isSystemAdmin,
      is_env_admin: byEnv,
    };
    next();
  } catch (err) {
    console.error('requireAuth error:', err);
    res.status(500).json({ error: 'Lỗi xác thực: ' + err.message });
  }
}

/**
 * Chỉ cho phép admin hệ thống (super admin).
 */
export function requireSystemAdmin(req, res, next) {
  if (!req.user?.is_system_admin) {
    return res.status(403).json({ error: 'Chỉ admin hệ thống mới được truy cập khu vực này' });
  }
  next();
}

/**
 * Tìm organization_id trong params / body / query / header.
 */
function resolveOrgId(req) {
  return (
    req.params.orgId ||
    req.params.id ||
    req.body?.organization_id ||
    req.query?.organization_id ||
    req.headers['x-organization-id'] ||
    null
  );
}

/**
 * Bắt buộc là thành viên của tổ chức. Gắn req.org và req.membership.
 * Admin hệ thống luôn đi qua được (role = 'system').
 */
export async function requireOrgMember(req, res, next) {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Thiếu mã tổ chức (organization_id)' });

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('*, plan:plans(*)')
      .eq('id', orgId)
      .maybeSingle();

    if (orgErr) throw orgErr;
    if (!org) return res.status(404).json({ error: 'Không tìm thấy tổ chức' });

    if (req.user.is_system_admin) {
      req.org = org;
      req.membership = { role: 'admin', status: 'active', system: true };
      req.trial = trialStatus(org);
      return next();
    }

    if (org.status === 'suspended') {
      return res.status(403).json({ error: 'Tổ chức đang bị tạm khoá. Vui lòng liên hệ quản trị hệ thống.' });
    }

    const { data: membership } = await supabase
      .from('organization_members')
      .select('*')
      .eq('organization_id', orgId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!membership || membership.status !== 'active') {
      return res.status(403).json({ error: 'Bạn không thuộc tổ chức này' });
    }

    req.org = org;
    req.membership = membership;
    req.trial = trialStatus(org);
    next();
  } catch (err) {
    console.error('requireOrgMember error:', err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Chặn các hành động chính khi gói dùng thử đã hết hạn.
 *
 * Cố ý KHÔNG chặn ở requireOrgMember: admin vẫn phải vào được trang gói cước
 * và thiết lập để nâng cấp. Chỉ chặn những việc tiêu tốn tài nguyên:
 * tải tài liệu lên và hỏi chatbot.
 */
export function blockIfTrialExpired(req, res, next) {
  if (req.membership?.system) return next();      // admin hệ thống luôn qua
  if (req.trial?.isTrial && req.trial.expired) {
    return res.status(402).json({
      error: EXPIRED_MESSAGE,
      trial_expired: true,
      data_purged: req.trial.purged,
    });
  }
  next();
}

/**
 * Bắt buộc là admin của tổ chức (chạy sau requireOrgMember).
 */
export function requireOrgAdmin(req, res, next) {
  if (req.membership?.role !== 'admin') {
    return res.status(403).json({ error: 'Chỉ admin của tổ chức mới được thực hiện thao tác này' });
  }
  next();
}
