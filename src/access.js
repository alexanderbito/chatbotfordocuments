import { supabase } from './supabaseClient.js';

/**
 * Tính xem một người được đọc những thư mục nào trong một tổ chức.
 *
 * Quy tắc:
 *  - Thư mục 'public'  : mọi thành viên trong tổ chức đều đọc được.
 *  - Thư mục 'private' : chỉ những email có trong folder_permissions.
 *  - KẾ THỪA: muốn đọc một thư mục thì phải có quyền ở TẤT CẢ thư mục cha
 *    riêng tư nằm trên đường đi tới nó. Nhờ vậy không thể vô tình lộ dữ liệu
 *    bằng cách tạo một thư mục con để public bên trong thư mục mật.
 *  - Admin tổ chức và admin hệ thống đọc được tất cả (họ vốn đã quản lý
 *    toàn bộ tài liệu).
 *  - Tài liệu chưa phân loại (folder_id = null) coi như công khai trong tổ chức.
 */

/**
 * @returns {Promise<{
 *   isAdmin: boolean,
 *   folders: Array,            // toàn bộ thư mục của tổ chức (kèm visibility)
 *   accessible: Array,         // thư mục người này được đọc
 *   allowedIds: string[],      // id của accessible
 *   grantedIds: Set<string>,   // thư mục private được cấp quyền trực tiếp
 * }>}
 */
export async function getFolderAccess(orgId, user, membership) {
  const { data: folders, error } = await supabase
    .from('folders')
    .select('id, name, parent_id, visibility, created_at')
    .eq('organization_id', orgId)
    .order('name');
  if (error) throw error;

  const all = folders || [];
  const isAdmin = membership?.role === 'admin' || !!user?.is_system_admin;

  if (isAdmin) {
    return {
      isAdmin: true,
      folders: all,
      accessible: all,
      allowedIds: all.map((f) => f.id),
      grantedIds: new Set(all.map((f) => f.id)),
    };
  }

  const email = String(user?.email || '').toLowerCase();
  const { data: perms } = await supabase
    .from('folder_permissions')
    .select('folder_id')
    .eq('organization_id', orgId)
    .eq('email', email);

  const granted = new Set((perms || []).map((p) => p.folder_id));
  const byId = new Map(all.map((f) => [f.id, f]));

  const cache = new Map();
  const canRead = (folderId, seen = new Set()) => {
    if (!folderId) return true;                 // chưa phân loại: công khai
    if (cache.has(folderId)) return cache.get(folderId);
    if (seen.has(folderId)) return false;       // phòng dữ liệu vòng lặp
    seen.add(folderId);

    const f = byId.get(folderId);
    if (!f) return false;

    // Chính thư mục này phải qua được, rồi mới xét lên thư mục cha
    const selfOk = f.visibility !== 'private' || granted.has(f.id);
    const result = selfOk && (f.parent_id ? canRead(f.parent_id, seen) : true);

    cache.set(folderId, result);
    return result;
  };

  const accessible = all.filter((f) => canRead(f.id));

  return {
    isAdmin: false,
    folders: all,
    accessible,
    allowedIds: accessible.map((f) => f.id),
    grantedIds: granted,
  };
}

/**
 * Kiểm tra nhanh một người có được đọc một thư mục cụ thể không.
 */
export async function canReadFolder(orgId, user, membership, folderId) {
  if (!folderId) return true;
  const { allowedIds, isAdmin } = await getFolderAccess(orgId, user, membership);
  return isAdmin || allowedIds.includes(folderId);
}

/**
 * Lấy danh sách email đang được cấp quyền cho một thư mục.
 */
export async function listFolderPermissions(folderId) {
  const { data, error } = await supabase
    .from('folder_permissions')
    .select('email, created_at')
    .eq('folder_id', folderId)
    .order('email');
  if (error) throw error;
  return data || [];
}

/**
 * Đặt lại toàn bộ danh sách email được đọc một thư mục riêng tư.
 * Chỉ chấp nhận email đang là thành viên của tổ chức — tránh trường hợp
 * gõ nhầm địa chỉ rồi tưởng đã cấp quyền.
 *
 * @returns {Promise<{ saved: string[], rejected: string[] }>}
 */
export async function setFolderPermissions(orgId, folderId, emails, grantedBy) {
  const wanted = [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];

  let saved = [];
  let rejected = [];

  if (wanted.length) {
    const { data: members } = await supabase
      .from('organization_members')
      .select('email')
      .eq('organization_id', orgId);

    const memberEmails = new Set((members || []).map((m) => String(m.email).toLowerCase()));
    saved = wanted.filter((e) => memberEmails.has(e));
    rejected = wanted.filter((e) => !memberEmails.has(e));
  }

  await supabase.from('folder_permissions').delete().eq('folder_id', folderId);

  if (saved.length) {
    const { error } = await supabase.from('folder_permissions').insert(
      saved.map((email) => ({
        folder_id: folderId,
        organization_id: orgId,
        email,
        granted_by: grantedBy || null,
      }))
    );
    if (error) throw error;
  }

  return { saved, rejected };
}
