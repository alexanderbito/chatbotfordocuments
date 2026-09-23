import { supabase } from './supabaseClient.js';

/**
 * Write an entry to system_logs so the system-admin console can read it.
 * Never throws: a failed log write must not take down the request it describes.
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
    console.error('[logger] could not write log entry:', err.message);
  }
  const line = `[${level.toUpperCase()}][${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
