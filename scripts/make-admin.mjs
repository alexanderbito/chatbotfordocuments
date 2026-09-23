#!/usr/bin/env node
/**
 * Grant / revoke system administrator rights from the command line.
 *
 * Use this when the web interface is unreachable, or to create the very first
 * administrator account without opening the Supabase SQL Editor.
 *
 *   npm run make-admin -- admin@company.com            # grant
 *   npm run make-admin -- admin@company.com --revoke   # revoke
 *   npm run make-admin -- --list                       # show who currently has it
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const list = args.includes('--list');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function showList() {
  const { data, error } = await supabase
    .from('app_users')
    .select('email, full_name, status, last_login_at')
    .eq('is_system_admin', true)
    .order('email');
  if (error) throw error;

  const envList = String(process.env.SYSTEM_ADMIN_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (!data?.length) console.log('(no system administrator accounts in the database yet)');
  else {
    console.log('Current system administrators:');
    for (const u of data) {
      const tag = envList.includes(u.email.toLowerCase()) ? ' [from environment variable]' : '';
      const last = u.last_login_at ? new Date(u.last_login_at).toLocaleString('en-US') : 'never signed in';
      console.log(`  • ${u.email}${tag} — ${u.status} — ${last}`);
    }
  }
  if (envList.length) console.log(`\nSYSTEM_ADMIN_EMAILS = ${envList.join(', ')}`);
}

async function setFlag() {
  const { data: user, error } = await supabase
    .from('app_users')
    .select('id, email, is_system_admin')
    .ilike('email', email)
    .maybeSingle();
  if (error) throw error;

  if (!user) {
    console.error(`❌ No account found for ${email}`);
    console.error('   Register that account on /register.html first, then run this command again.');
    process.exit(1);
  }

  if (!revoke && user.is_system_admin) {
    console.log(`✓ ${email} is already a system administrator; nothing to do.`);
    return;
  }

  if (revoke) {
    const { count } = await supabase
      .from('app_users').select('id', { count: 'exact', head: true })
      .eq('is_system_admin', true);
    if ((count || 0) <= 1) {
      console.error('❌ This is the only system administrator; revoking it would leave nobody able to manage the system.');
      process.exit(1);
    }
  }

  const { error: upErr } = await supabase
    .from('app_users').update({ is_system_admin: !revoke }).eq('id', user.id);
  if (upErr) throw upErr;

  console.log(revoke ? `✓ Revoked system administrator rights from ${email}`
                     : `✓ Granted system administrator rights to ${email}`);
  if (!revoke) console.log('  Sign out and sign back in to reach /sysadmin.html');
}

try {
  if (list || !email) {
    await showList();
    if (!email && !list) {
      console.log('\nUsage:');
      console.log('  npm run make-admin -- admin@company.com');
      console.log('  npm run make-admin -- admin@company.com --revoke');
      console.log('  npm run make-admin -- --list');
    }
  } else {
    await setFlag();
  }
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
