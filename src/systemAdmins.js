import 'dotenv/config';

/**
 * The list of emails that always hold system admin rights, declared through an
 * environment variable.
 *
 * Why this exists: the FIRST system admin account cannot be created from the UI,
 * because there is nobody around yet to grant the rights. Until now that meant
 * opening Supabase and running SQL by hand. With this variable you just declare
 * the email on Render and sign up normally.
 *
 * Effective rights = the flag in the database OR the email being in this list. The
 * second path is the recovery route: even if the database flag is deleted by
 * mistake, having the email in the environment variable is enough to get back in.
 *
 * NOTE: on the first sign-in the database flag is turned on to keep the two in
 * sync. REMOVING AN EMAIL FROM THE ENVIRONMENT VARIABLE THEREFORE DOES NOT REVOKE
 * ACCESS — it has to be revoked explicitly with
 * `npm run make-admin -- email@company.com --revoke` or from the Users page of the
 * system admin area (and the email must be taken out of the environment variable
 * first, otherwise the revoke is blocked).
 */

function parse() {
  return String(process.env.SYSTEM_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function systemAdminEmails() {
  return parse();
}

export function isSystemAdminEmail(email) {
  if (!email) return false;
  return parse().includes(String(email).trim().toLowerCase());
}

/** Whether any system admin is declared through the environment variable. */
export function hasBootstrapAdmins() {
  return parse().length > 0;
}
