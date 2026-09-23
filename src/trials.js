import { supabase } from './supabaseClient.js';
import { deleteFromR2 } from './storage.js';
import { logEvent } from './logger.js';

/**
 * Free trial lifecycle.
 *
 * A trial gives full access to every feature except OCR for `plans.trial_days`
 * days. Once it expires we first lock the organization out, then purge its
 * documents.
 *
 * What the purge covers: documents, the files stored on R2, the indexed chunks,
 * temporary OCR output, and the chat history (answers quote document content,
 * so leaving them behind would leave the content behind too).
 * What we KEEP: accounts, organizations, members and the folder tree — so a
 * customer who comes back to upgrade can start using the product straight away
 * instead of signing up all over again.
 */

/** Hours of grace after the expiry timestamp before anything is actually deleted. */
const GRACE_HOURS = Number(process.env.TRIAL_GRACE_HOURS || 0);

export function isTrialPlan(plan) {
  return Number(plan?.trial_days || 0) > 0;
}

/**
 * Trial state of a single organization.
 * @returns {{ isTrial: boolean, expired: boolean, expiresAt: string|null, msLeft: number, purged: boolean }}
 */
export function trialStatus(org) {
  const isTrial = isTrialPlan(org?.plan) && org?.billing_status === 'trial';
  if (!isTrial) {
    return { isTrial: false, expired: false, expiresAt: null, msLeft: 0, purged: false };
  }
  const expiresAt = org.plan_expires_at || null;
  const msLeft = expiresAt ? new Date(expiresAt) - Date.now() : 0;
  return {
    isTrial: true,
    expired: !!expiresAt && msLeft <= 0,
    expiresAt,
    msLeft: Math.max(0, msLeft),
    purged: !!org.trial_data_purged_at,
  };
}

/** Standard notice shown once the trial has expired. */
export const EXPIRED_MESSAGE =
  'Your free trial has ended. Upgrade your plan to keep using BotClarify.';

/**
 * Purge the data of ONE organization whose trial has expired.
 * Idempotent: running it again on an already purged organization does nothing.
 */
export async function purgeOrganizationData(orgId, { reason = 'trial expired' } = {}) {
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, trial_data_purged_at')
    .eq('id', orgId)
    .maybeSingle();
  if (!org) return { skipped: true, reason: 'organization not found' };
  if (org.trial_data_purged_at) return { skipped: true, reason: 'already purged' };

  const { data: docs } = await supabase
    .from('documents')
    .select('id, storage_key, filename')
    .eq('organization_id', orgId);

  // Delete the R2 files first. A failure on one file must not abort the whole
  // run — an orphaned file on R2 is annoying but harmless, whereas leaving the
  // database rows in place would let the customer keep asking questions about
  // content that was supposed to be gone.
  let filesDeleted = 0, fileErrors = 0;
  for (const d of docs || []) {
    try { await deleteFromR2(d.storage_key); filesDeleted++; }
    catch { fileErrors++; }
  }

  await supabase.from('document_ocr_batches').delete().in('document_id', (docs || []).map((d) => d.id));
  await supabase.from('document_chunks').delete().eq('organization_id', orgId);
  await supabase.from('documents').delete().eq('organization_id', orgId);
  await supabase.from('chat_messages').delete().eq('organization_id', orgId);

  await supabase
    .from('organizations')
    .update({ trial_data_purged_at: new Date().toISOString() })
    .eq('id', orgId);

  await logEvent({
    level: 'warn',
    scope: 'system',
    organizationId: orgId,
    message: `Purged data for "${org.name}" (${reason}): ${(docs || []).length} documents`,
    detail: { documents: (docs || []).length, files_deleted: filesDeleted, file_errors: fileErrors },
  });

  return {
    skipped: false,
    documents: (docs || []).length,
    files_deleted: filesDeleted,
    file_errors: fileErrors,
  };
}

/** Purge every organization whose trial has expired. */
export async function purgeExpiredTrials() {
  const { data: rows, error } = await supabase.rpc('list_expired_trials', { grace_hours: GRACE_HOURS });
  if (error) throw error;

  const results = [];
  for (const row of rows || []) {
    try {
      const r = await purgeOrganizationData(row.organization_id);
      results.push({ organization: row.organization_name, ...r });
    } catch (err) {
      results.push({ organization: row.organization_name, error: err.message });
      await logEvent({
        level: 'error',
        scope: 'system',
        organizationId: row.organization_id,
        message: `Trial data purge failed: ${row.organization_name}`,
        detail: { error: err.message },
      });
    }
  }
  return { checked: (rows || []).length, results };
}

/**
 * Run the periodic cleanup without depending on an external cron service.
 *
 * Render's free tier puts the instance to sleep after 15 minutes without
 * traffic, so an in-process hourly timer is not reliable. This approach rides on
 * real traffic instead: on every request, if enough time has passed since the
 * last sweep, one sweep is kicked off in the background. It is still worth
 * pointing a free cron service at /admin/maintenance/purge-trials so that
 * abandoned organizations are purged on time as well.
 */
const SWEEP_INTERVAL_MS = Number(process.env.TRIAL_SWEEP_INTERVAL_MS || 6 * 60 * 60 * 1000);
let lastSweep = 0;
let sweeping = false;

export function maybeSweep() {
  if (sweeping) return;
  if (Date.now() - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = Date.now();
  sweeping = true;

  purgeExpiredTrials()
    .then((r) => {
      if (r.checked) console.log(`[trials] checked ${r.checked} organizations with expired trials`);
    })
    .catch((err) => console.error('[trials] sweep failed:', err.message))
    .finally(() => { sweeping = false; });
}
