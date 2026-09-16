import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * Client quyền quản trị (service_role) — dùng cho mọi thao tác đọc/ghi ở backend.
 * TUYỆT ĐỐI không đưa key này ra frontend.
 */
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/**
 * Client dùng cho đăng nhập (anon key). Nếu chưa khai báo SUPABASE_ANON_KEY
 * thì tạm dùng service_role — vẫn chạy được nhưng nên khai báo anon key cho đúng chuẩn.
 */
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
