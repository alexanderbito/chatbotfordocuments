import express from 'express';
import { supabase, supabaseAuth } from '../supabaseClient.js';
import { requireAuth } from '../auth.js';
import { trialStatus } from '../trials.js';
import { isSystemAdminEmail } from '../systemAdmins.js';
import { logEvent } from '../logger.js';

const router = express.Router();

/**
 * POST /auth/register
 * Two scenarios:
 *  - organization_name present -> create the account plus a new organization; the registrant becomes its ADMIN
 *  - invite_token present      -> create the account and join the inviting organization with the role already assigned
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name, organization_name, invite_token } = req.body || {};

    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // An email listed in SYSTEM_ADMIN_EMAILS is a system administrator account: it does not
    // belong to any company, so we do not require a company name.
    const isSysAdmin = isSystemAdminEmail(email);

    if (!isSysAdmin && !organization_name && !invite_token) {
      return res.status(400).json({ error: 'Enter a company name or an invite code' });
    }

    let invite = null;
    if (invite_token) {
      const { data } = await supabase
        .from('organization_members')
        .select('*')
        .eq('invite_token', invite_token)
        .maybeSingle();
      if (!data) return res.status(400).json({ error: 'This invite code is invalid or has already been used' });
      if (data.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(400).json({ error: `This invite is for ${data.email}` });
      }
      invite = data;
    }

    // 1. Create the user in Supabase Auth (confirm the email immediately so the account is usable right away)
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: full_name || '' },
    });
    if (createErr) {
      const msg = /already been registered|already exists/i.test(createErr.message)
        ? 'This email is already registered'
        : createErr.message;
      return res.status(400).json({ error: msg });
    }

    const userId = created.user.id;

    // 2. User profile
    await supabase.from('app_users').upsert({
      id: userId,
      email,
      full_name: full_name || '',
      is_system_admin: isSysAdmin,
    });

    // 3. Attach to an organization
    if (isSysAdmin && !invite) {
      // System administrators sit outside every organization
      await logEvent({ scope: 'auth', userId, message: `System administrator account created: ${email}` });
    } else if (invite) {
      await supabase
        .from('organization_members')
        .update({ user_id: userId, status: 'active', invite_token: null })
        .eq('id', invite.id);
      await logEvent({ scope: 'auth', organizationId: invite.organization_id, userId, message: `Member ${email} accepted the invite` });
    } else {
      const { data: freePlan } = await supabase
        .from('plans')
        .select('id, trial_days')
        .eq('code', 'free')
        .maybeSingle();

      // The trial clock starts the moment the organization registers
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
        name: 'General',
        created_by: userId,
      });

      await logEvent({ scope: 'auth', organizationId: org.id, userId, message: `New company registered: ${organization_name} (${trialDays}-day trial)` });
    }

    // 4. Sign in right away so the frontend receives a token
    const { data: session, error: signErr } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (signErr) return res.json({ message: 'Registration successful, please sign in', requires_login: true });

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
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Incorrect email or password' });

    const userId = data.user.id;
    // Make sure an app_users profile always exists (in case the user was created by hand in Supabase)
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
 * GET /auth/me — account details plus the organizations the user belongs to
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
      return res.status(400).json({ error: 'The new password must be at least 6 characters' });
    }
    const { error: checkErr } = await supabaseAuth.auth.signInWithPassword({
      email: req.user.email,
      password: current_password || '',
    });
    if (checkErr) return res.status(400).json({ error: 'Your current password is incorrect' });

    const { error } = await supabase.auth.admin.updateUserById(req.user.id, { password: new_password });
    if (error) throw error;
    res.json({ message: 'Password changed' });
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
 * GET /auth/invite/:token — look up an invite (no sign-in required)
 */
router.get('/invite/:token', async (req, res) => {
  const { data } = await supabase
    .from('organization_members')
    .select('email, role, organization:organizations(name)')
    .eq('invite_token', req.params.token)
    .maybeSingle();
  if (!data) return res.status(404).json({ error: 'This invite does not exist or has already been used' });
  res.json({ email: data.email, role: data.role, organization_name: data.organization?.name });
});

export default router;
