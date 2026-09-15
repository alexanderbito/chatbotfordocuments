import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Dùng SERVICE_ROLE_KEY vì backend cần quyền ghi đầy đủ (bypass RLS).
// TUYỆT ĐỐI không đưa key này ra frontend.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
