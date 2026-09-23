import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

/**
 * Service-role client, used for every backend read and write.
 * This key must NEVER be exposed to the browser.
 */
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/**
 * Client used for sign-in (anon key). Falls back to the service-role key when
 * SUPABASE_ANON_KEY is missing: it works, but the anon key is the correct one.
 */
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
