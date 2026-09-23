import { supabase } from './supabaseClient.js';

/**
 * Work out which folders a person is allowed to read inside an organization.
 *
 * Rules:
 *  - 'public' folders  : every member of the organization can read them.
 *  - 'private' folders : only the emails listed in folder_permissions.
 *  - INHERITANCE: reading a folder requires permission on EVERY private ancestor
 *    folder on the path down to it. This is what makes it impossible to leak data
 *    by accident by creating a public subfolder inside a confidential folder.
 *  - Organization admins and system admins can read everything (they already
 *    manage the whole document set anyway).
 *  - Unfiled documents (folder_id = null) are treated as public within the
 *    organization.
 */

/**
 * @returns {Promise<{
 *   isAdmin: boolean,
 *   folders: Array,            // every folder in the organization (with visibility)
 *   accessible: Array,         // the folders this person may read
 *   allowedIds: string[],      // the ids of accessible
 *   grantedIds: Set<string>,   // private folders granted directly to this person
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
    if (!folderId) return true;                 // unfiled: public
    if (cache.has(folderId)) return cache.get(folderId);
    if (seen.has(folderId)) return false;       // guard against cyclic data
    seen.add(folderId);

    const f = byId.get(folderId);
    if (!f) return false;

    // The folder itself has to pass first, only then do we walk up to the parent
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
 * List the emails currently granted access to a folder.
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
 * Replace the whole list of emails allowed to read a private folder.
 * Only emails that are already members of the organization are accepted — this
 * avoids the case where someone mistypes an address and believes access has been
 * granted.
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
