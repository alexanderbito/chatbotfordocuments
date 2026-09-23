import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { getFolderAccess, listFolderPermissions, setFolderPermissions } from '../access.js';
import { logEvent } from '../logger.js';

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireOrgMember);

/**
 * GET /orgs/:orgId/folders
 * Organization admins see every folder along with how many people have been
 * granted access to it. Regular members see ONLY the folders they may read — a
 * private folder they have no grant for is hidden entirely, because the folder
 * name alone can be sensitive.
 */
router.get('/', async (req, res) => {
  try {
    const access = await getFolderAccess(req.org.id, req.user, req.membership);
    const visible = access.isAdmin ? access.folders : access.accessible;
    const visibleIds = new Set(visible.map((f) => f.id));

    // Count documents, but only within the folders this person can see
    const { data: docs } = await supabase
      .from('documents')
      .select('folder_id')
      .eq('organization_id', req.org.id);

    const counts = {};
    let unfiled = 0;
    for (const d of docs || []) {
      if (!d.folder_id) unfiled++;
      else if (visibleIds.has(d.folder_id)) counts[d.folder_id] = (counts[d.folder_id] || 0) + 1;
    }

    // Number of emails granted access to each private folder (only admins need this)
    let permCounts = {};
    if (access.isAdmin) {
      const privateIds = visible.filter((f) => f.visibility === 'private').map((f) => f.id);
      if (privateIds.length) {
        const { data: perms } = await supabase
          .from('folder_permissions')
          .select('folder_id')
          .in('folder_id', privateIds);
        for (const p of perms || []) permCounts[p.folder_id] = (permCounts[p.folder_id] || 0) + 1;
      }
    }

    res.json({
      folders: visible.map((f) => ({
        ...f,
        document_count: counts[f.id] || 0,
        permission_count: permCounts[f.id] || 0,
      })),
      unfiled_count: unfiled,
      can_manage: access.isAdmin,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /orgs/:orgId/folders { name, parent_id, visibility, emails[] } */
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A folder name is required' });

    const visibility = req.body?.visibility === 'private' ? 'private' : 'public';

    const { data, error } = await supabase
      .from('folders')
      .insert({
        organization_id: req.org.id,
        name,
        parent_id: req.body?.parent_id || null,
        visibility,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;

    let permissions = { saved: [], rejected: [] };
    if (visibility === 'private') {
      permissions = await setFolderPermissions(req.org.id, data.id, req.body?.emails, req.user.id);
      await logEvent({
        scope: 'auth',
        organizationId: req.org.id,
        userId: req.user.id,
        message: `Created private folder "${name}" for ${permissions.saved.length} members`,
      });
    }

    res.json({ ...data, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /orgs/:orgId/folders/:folderId { name, parent_id, visibility, emails[] } */
router.patch('/:folderId', requireOrgAdmin, async (req, res) => {
  try {
    const { data: folder } = await supabase
      .from('folders')
      .select('*')
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body?.parent_id !== undefined) patch.parent_id = req.body.parent_id || null;
    if (req.body?.visibility !== undefined) {
      patch.visibility = req.body.visibility === 'private' ? 'private' : 'public';
    }

    if (patch.parent_id === req.params.folderId) {
      return res.status(400).json({ error: 'A folder cannot be its own parent' });
    }
    // Prevent cycles: a folder must not be moved into its own subtree
    if (patch.parent_id) {
      const { data: all } = await supabase
        .from('folders')
        .select('id, parent_id')
        .eq('organization_id', req.org.id);
      const byId = new Map((all || []).map((f) => [f.id, f]));
      let cur = byId.get(patch.parent_id);
      const seen = new Set();
      while (cur) {
        if (cur.id === req.params.folderId) {
          return res.status(400).json({ error: 'A folder cannot be moved inside one of its own subfolders' });
        }
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : null;
      }
    }

    const { data, error } = await supabase
      .from('folders')
      .update(patch)
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id)
      .select()
      .single();
    if (error) throw error;

    let permissions = { saved: [], rejected: [] };
    const finalVisibility = patch.visibility ?? folder.visibility;

    if (finalVisibility === 'private') {
      if (req.body?.emails !== undefined) {
        permissions = await setFolderPermissions(req.org.id, data.id, req.body.emails, req.user.id);
      }
    } else if (folder.visibility === 'private') {
      // Switching back to public drops the old grant list so it cannot be misread
      await supabase.from('folder_permissions').delete().eq('folder_id', data.id);
    }

    if (patch.visibility && patch.visibility !== folder.visibility) {
      await logEvent({
        scope: 'auth',
        organizationId: req.org.id,
        userId: req.user.id,
        message: `Changed folder "${data.name}" to ${patch.visibility === 'private' ? 'private' : 'public'}`,
      });
    }

    res.json({ ...data, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/folders/:folderId/permissions — the emails allowed to read it */
router.get('/:folderId/permissions', requireOrgAdmin, async (req, res) => {
  try {
    const { data: folder } = await supabase
      .from('folders')
      .select('id, name, visibility')
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const [permissions, { data: members }] = await Promise.all([
      listFolderPermissions(folder.id),
      supabase
        .from('organization_members')
        .select('email, role, status')
        .eq('organization_id', req.org.id)
        .neq('status', 'disabled')
        .order('email'),
    ]);

    res.json({
      folder,
      emails: permissions.map((p) => p.email),
      members: members || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PUT /orgs/:orgId/folders/:folderId/permissions { emails: [] } */
router.put('/:folderId/permissions', requireOrgAdmin, async (req, res) => {
  try {
    const { data: folder } = await supabase
      .from('folders')
      .select('id, name, visibility')
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    if (folder.visibility !== 'private') {
      return res.status(400).json({ error: 'This folder is public, so per-member access does not apply' });
    }

    const result = await setFolderPermissions(req.org.id, folder.id, req.body?.emails, req.user.id);
    await logEvent({
      scope: 'auth',
      organizationId: req.org.id,
      userId: req.user.id,
      message: `Updated access for folder "${folder.name}": ${result.saved.length} members`,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /orgs/:orgId/folders/:folderId
 * Subfolders are deleted along with it (cascade). The documents inside are NOT
 * deleted, they are only moved to "Unfiled".
 */
router.delete('/:folderId', requireOrgAdmin, async (req, res) => {
  try {
    const { data: all } = await supabase
      .from('folders')
      .select('id, parent_id, visibility, name')
      .eq('organization_id', req.org.id);

    // Collect the whole subtree that will be deleted along with it
    const ids = [];
    const collect = (id) => {
      ids.push(id);
      for (const f of all || []) if (f.parent_id === id) collect(f.id);
    };
    collect(req.params.folderId);

    const target = (all || []).find((f) => f.id === req.params.folderId);

    // Careful: documents in a private folder become "unfiled", which means the
    // whole organization can read them. Require an explicit confirmation from
    // the admin before that happens.
    const hasPrivate = (all || []).some((f) => ids.includes(f.id) && f.visibility === 'private');
    if (hasPrivate && req.query.confirm !== 'move-to-public') {
      const { count } = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .in('folder_id', ids);
      return res.status(409).json({
        error: 'needs_confirmation',
        message:
          `This folder (or one of its subfolders) is private and holds ${count || 0} documents. ` +
          `Deleting it moves those documents to "Unfiled", where EVERY member of the organization can ask about them. ` +
          `Move them to another private folder first, or confirm to continue.`,
        document_count: count || 0,
      });
    }

    await supabase.from('documents').update({ folder_id: null }).in('folder_id', ids);
    await supabase.from('document_chunks').update({ folder_id: null }).in('folder_id', ids);

    const { error } = await supabase
      .from('folders')
      .delete()
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id);
    if (error) throw error;

    await logEvent({
      scope: 'auth',
      organizationId: req.org.id,
      userId: req.user.id,
      message: `Deleted folder "${target?.name || req.params.folderId}"`,
    });

    res.json({ message: 'Folder deleted; the documents inside were moved to Unfiled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
