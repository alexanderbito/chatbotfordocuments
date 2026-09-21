import { supabase } from './supabaseClient.js';
import { deleteFromR2 } from './storage.js';
import { logEvent } from './logger.js';

/**
 * Vòng đời gói dùng thử.
 *
 * Gói dùng thử cho đủ tính năng (trừ OCR) trong `plans.trial_days` ngày.
 * Hết hạn: khoá không cho dùng tiếp, rồi dọn tài liệu.
 *
 * Phạm vi dọn: tài liệu, file trên R2, các đoạn đã lập chỉ mục, bản OCR tạm,
 * và lịch sử hỏi đáp (vì câu trả lời có chứa nội dung tài liệu).
 * GIỮ LẠI: tài khoản, tổ chức, thành viên, cây thư mục — để khách quay lại
 * nâng cấp là dùng được ngay, không phải đăng ký từ đầu.
 */

/** Giờ ân hạn sau thời điểm hết hạn mới thực sự xoá. */
const GRACE_HOURS = Number(process.env.TRIAL_GRACE_HOURS || 0);

export function isTrialPlan(plan) {
  return Number(plan?.trial_days || 0) > 0;
}

/**
 * Tình trạng dùng thử của một tổ chức.
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

/** Thông báo chuẩn khi hết hạn dùng thử. */
export const EXPIRED_MESSAGE =
  'Thời gian dùng thử đã kết thúc. Vui lòng nâng cấp gói để tiếp tục sử dụng.';

/**
 * Dọn dữ liệu của MỘT tổ chức đã hết hạn dùng thử.
 * Idempotent: chạy lại trên tổ chức đã dọn sẽ không làm gì thêm.
 */
export async function purgeOrganizationData(orgId, { reason = 'hết hạn dùng thử' } = {}) {
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, trial_data_purged_at')
    .eq('id', orgId)
    .maybeSingle();
  if (!org) return { skipped: true, reason: 'không tìm thấy tổ chức' };
  if (org.trial_data_purged_at) return { skipped: true, reason: 'đã dọn trước đó' };

  const { data: docs } = await supabase
    .from('documents')
    .select('id, storage_key, filename')
    .eq('organization_id', orgId);

  // Xoá file trên R2 trước. Lỗi ở một file không được chặn cả quá trình —
  // file mồ côi trên R2 phiền nhưng không nguy hiểm, còn để lại bản ghi
  // trong CSDL thì khách vẫn hỏi được nội dung đáng lẽ đã bị xoá.
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
    message: `Đã dọn dữ liệu của "${org.name}" (${reason}): ${(docs || []).length} tài liệu`,
    detail: { documents: (docs || []).length, files_deleted: filesDeleted, file_errors: fileErrors },
  });

  return {
    skipped: false,
    documents: (docs || []).length,
    files_deleted: filesDeleted,
    file_errors: fileErrors,
  };
}

/** Dọn tất cả tổ chức đã hết hạn dùng thử. */
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
        message: `Dọn dữ liệu dùng thử thất bại: ${row.organization_name}`,
        detail: { error: err.message },
      });
    }
  }
  return { checked: (rows || []).length, results };
}

/**
 * Chạy dọn dẹp định kỳ mà không cần dịch vụ cron bên ngoài.
 *
 * Render Free ngủ sau 15 phút không có traffic nên cron nội bộ theo giờ là
 * không đáng tin. Cách này bám vào lưu lượng thật: mỗi khi có request, nếu
 * đã quá khoảng thời gian định trước thì chạy dọn một lần ở chế độ nền.
 * Vẫn nên trỏ thêm một dịch vụ cron miễn phí vào /admin/maintenance/purge-trials
 * để những tổ chức bỏ hoang cũng được dọn đúng hạn.
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
      if (r.checked) console.log(`[trials] đã kiểm tra ${r.checked} tổ chức hết hạn dùng thử`);
    })
    .catch((err) => console.error('[trials] dọn dẹp thất bại:', err.message))
    .finally(() => { sweeping = false; });
}
