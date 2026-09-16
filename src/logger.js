import { supabase } from './supabaseClient.js';

/**
 * Ghi nhật ký vào bảng system_logs để console admin hệ thống đọc được.
 * Không bao giờ ném lỗi ra ngoài — ghi log hỏng không được làm hỏng request chính.
 */
export async function logEvent({ level = 'info', scope = 'system', organizationId = null, userId = null, message, detail = null }) {
  try {
    await supabase.from('system_logs').insert({
      level,
      scope,
      organization_id: organizationId,
      user_id: userId,
      message: String(message).slice(0, 2000),
      detail,
    });
  } catch (err) {
    console.error('[logger] không ghi được nhật ký:', err.message);
  }
  const line = `[${level.toUpperCase()}][${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
