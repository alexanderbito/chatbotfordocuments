#!/usr/bin/env node
/**
 * Cấp / gỡ quyền quản trị hệ thống từ dòng lệnh.
 *
 * Dùng khi không vào được giao diện, hoặc để lập tài khoản quản trị đầu tiên
 * mà không muốn mở Supabase SQL Editor.
 *
 *   npm run make-admin -- email@congty.vn            # cấp quyền
 *   npm run make-admin -- email@congty.vn --revoke   # gỡ quyền
 *   npm run make-admin -- --list                     # xem ai đang có quyền
 *
 * Cần các biến SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY trong .env.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const list = args.includes('--list');
const email = args.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env');
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

  if (!data?.length) console.log('(chưa có tài khoản quản trị hệ thống nào trong CSDL)');
  else {
    console.log('Quản trị hệ thống hiện có:');
    for (const u of data) {
      const tag = envList.includes(u.email.toLowerCase()) ? ' [từ biến môi trường]' : '';
      const last = u.last_login_at ? new Date(u.last_login_at).toLocaleString('vi-VN') : 'chưa đăng nhập';
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
    console.error(`❌ Không tìm thấy tài khoản ${email}`);
    console.error('   Hãy đăng ký tài khoản đó trên /register.html trước, rồi chạy lại lệnh này.');
    process.exit(1);
  }

  if (!revoke && user.is_system_admin) {
    console.log(`✓ ${email} vốn đã là quản trị hệ thống, không cần làm gì.`);
    return;
  }

  if (revoke) {
    const { count } = await supabase
      .from('app_users').select('id', { count: 'exact', head: true })
      .eq('is_system_admin', true);
    if ((count || 0) <= 1) {
      console.error('❌ Đây là quản trị hệ thống duy nhất, gỡ quyền sẽ không còn ai quản lý được.');
      process.exit(1);
    }
  }

  const { error: upErr } = await supabase
    .from('app_users').update({ is_system_admin: !revoke }).eq('id', user.id);
  if (upErr) throw upErr;

  console.log(revoke ? `✓ Đã gỡ quyền quản trị hệ thống của ${email}`
                     : `✓ Đã cấp quyền quản trị hệ thống cho ${email}`);
  if (!revoke) console.log('  Đăng xuất rồi đăng nhập lại để vào /sysadmin.html');
}

try {
  if (list || !email) {
    await showList();
    if (!email && !list) {
      console.log('\nCách dùng:');
      console.log('  npm run make-admin -- email@congty.vn');
      console.log('  npm run make-admin -- email@congty.vn --revoke');
      console.log('  npm run make-admin -- --list');
    }
  } else {
    await setFlag();
  }
} catch (err) {
  console.error('❌ Lỗi:', err.message);
  process.exit(1);
}
