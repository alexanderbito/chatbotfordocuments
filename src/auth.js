import { supabase } from './supabaseClient.js';
import { trialStatus, EXPIRED_MESSAGE } from './trials.js';
import { isSystemAdminEmail } from './systemAdmins.js';

/**
 * Read the access token from the Authorization: Bearer <token> header.
 */
function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Require a signed-in user. Sets req.user = { id, email, full_name, is_system_admin, ... }
 */
export async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'You need to sign in to continue' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Your session has expired, please sign in again' });
    }

    const { data: profile } = await supabase
      .from('app_users')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profile?.status === 'disabled') {
      return res.status(403).json({ error: 'This account has been disabled' });
    }

    // System admin rights: the flag in the database OR the email being listed in
    // SYSTEM_ADMIN_EMAILS. The second path is the break-glass route for creating the
    // very first account, and for getting access back if the flag is removed by mistake.
    const byEnv = isSystemAdminEmail(data.user.email);
    const isSystemAdmin = !!profile?.is_system_admin || byEnv;

    // If the right comes from the environment variable but the database has not
    // recorded it yet, sync the flag back so the user listing pages show the correct
    // state.
    if (byEnv && profile && !profile.is_system_admin) {
      supabase.from('app_users').update({ is_system_admin: true }).eq('id', data.user.id)
        .then(() => {}, (err) => console.error('could not sync the admin flag:', err.message));
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
    res.status(500).json({ error: 'Authentication failed: ' + err.message });
  }
}

/**
 * Allow system admins (super admins) only.
 */
export function requireSystemAdmin(req, res, next) {
  if (!req.user?.is_system_admin) {
    return res.status(403).json({ error: 'Only system admins can access this area' });
  }
  next();
}

/**
 * Find the organization_id in the params / body / query / headers.
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
 * Require membership of the organization. Sets req.org and req.membership.
 * System admins always pass through (role = 'system').
 */
export async function requireOrgMember(req, res, next) {
  try {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'Missing organization id (organization_id)' });

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('*, plan:plans(*)')
      .eq('id', orgId)
      .maybeSingle();

    if (orgErr) throw orgErr;
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    if (req.user.is_system_admin) {
      req.org = org;
      req.membership = { role: 'admin', status: 'active', system: true };
      req.trial = trialStatus(org);
      return next();
    }

    if (org.status === 'suspended') {
      return res.status(403).json({ error: 'This organization is suspended. Please contact your system administrator.' });
    }

    const { data: membership } = await supabase
      .from('organization_members')
      .select('*')
      .eq('organization_id', orgId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!membership || membership.status !== 'active') {
      return res.status(403).json({ error: 'You are not a member of this organization' });
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
 * Block the main actions once the trial has expired.
 *
 * This deliberately does NOT block inside requireOrgMember: admins still need to
 * reach the billing and settings pages in order to upgrade. Only the actions that
 * consume resources are blocked: uploading documents and querying the chatbot.
 */
export function blockIfTrialExpired(req, res, next) {
  if (req.membership?.system) return next();      // system admins always pass
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
 * Require an organization admin (runs after requireOrgMember).
 */
export function requireOrgAdmin(req, res, next) {
  if (req.membership?.role !== 'admin') {
    return res.status(403).json({ error: 'Only organization admins can do this' });
  }
  next();
}
