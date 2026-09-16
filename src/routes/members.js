import express from 'express';
import crypto from 'crypto';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { checkQuota } from '../limits.js';
import { logEvent } from '../logger.js';

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireOrgMember, requireOrgAdmin);

/** GET /orgs/:orgId/members */
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('organization_members')
      .select('id, email, role, status, invite_token, created_at, user_id')
      .eq('organization_id', req.org.id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const userIds = (data || []).map((m) => m.user_id).filter(Boolean);
    let userMap = {};
    if (userIds.length) {
      const { data: users } = await supabase
        .from('app_users')
        .select('id, full_name, last_login_at')
        .in('id', userIds);
      userMap = Object.fromEntries((users || []).map((u) => [u.id, u]));
    }

    res.json(
      (data || []).map((m) => ({
        ...m,
        full_name: userMap[m.user_id]?.full_name || '',
        last_login_at: userMap[m.user_id]?.last_login_at || null,
        is_owner: req.org.owner_id === m.user_id,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /orgs/:orgId/members  { email, role }
 * Tạo lời mời. Nếu email đã có tài khoản trong hệ thống thì thêm thẳng vào tổ chức.
 */
router.post('/', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role === 'admin' ? 'admin' : 'member';
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Email không hợp lệ' });
    }

    const quota = await checkQuota(req.org.id, req.org.plan, 'invite');
    if (!quota.ok) return res.status(402).json({ error: quota.error });

    const { data: existed } = await supabase
      .from('organization_members')
      .select('id')
      .eq('organization_id', req.org.id)
      .ilike('email', email)
      .maybeSingle();
    if (existed) return res.status(400).json({ error: 'Email này đã có trong tổ chức' });

    const { data: appUser } = await supabase
      .from('app_users')
      .select('id')
      .ilike('email', email)
      .maybeSingle();

    const inviteToken = appUser ? null : crypto.randomBytes(24).toString('hex');

    const { data, error } = await supabase
      .from('organization_members')
      .insert({
        organization_id: req.org.id,
        user_id: appUser?.id || null,
        email,
        role,
        status: appUser ? 'active' : 'invited',
        invite_token: inviteToken,
        invited_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    await logEvent({ scope: 'auth', organizationId: req.org.id, userId: req.user.id, message: `Mời thành viên ${email} (${role})` });

    res.json({
      member: data,
      invite_link: inviteToken ? `/register.html?invite=${inviteToken}` : null,
      already_registered: !!appUser,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /orgs/:orgId/members/:memberId { role, status } */
router.patch('/:memberId', async (req, res) => {
  try {
    const { data: member } = await supabase
      .from('organization_members')
      .select('*')
      .eq('id', req.params.memberId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Không tìm thấy thành viên' });
    if (member.user_id && member.user_id === req.org.owner_id) {
      return res.status(400).json({ error: 'Không thể thay đổi quyền của chủ sở hữu tổ chức' });
    }

    const patch = {};
    if (req.body?.role) patch.role = req.body.role === 'admin' ? 'admin' : 'member';
    if (req.body?.status) patch.status = req.body.status;

    const { data, error } = await supabase
      .from('organization_members')
      .update(patch)
      .eq('id', req.params.memberId)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /orgs/:orgId/members/:memberId */
router.delete('/:memberId', async (req, res) => {
  try {
    const { data: member } = await supabase
      .from('organization_members')
      .select('*')
      .eq('id', req.params.memberId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!member) return res.status(404).json({ error: 'Không tìm thấy thành viên' });
    if (member.user_id === req.org.owner_id) {
      return res.status(400).json({ error: 'Không thể gỡ chủ sở hữu tổ chức' });
    }

    await supabase.from('organization_members').delete().eq('id', req.params.memberId);
    await logEvent({ scope: 'auth', organizationId: req.org.id, userId: req.user.id, message: `Gỡ thành viên ${member.email}` });
    res.json({ message: 'Đã gỡ thành viên khỏi tổ chức' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
