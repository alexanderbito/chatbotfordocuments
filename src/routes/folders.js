import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { getFolderAccess, listFolderPermissions, setFolderPermissions } from '../access.js';
import { logEvent } from '../logger.js';

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireOrgMember);

/**
 * GET /orgs/:orgId/folders
 * Admin tổ chức thấy toàn bộ thư mục kèm số người được cấp quyền.
 * Thành viên thường CHỈ thấy thư mục mình được đọc — thư mục riêng tư không
 * có quyền sẽ bị ẩn hoàn toàn, vì bản thân tên thư mục cũng có thể nhạy cảm.
 */
router.get('/', async (req, res) => {
  try {
    const access = await getFolderAccess(req.org.id, req.user, req.membership);
    const visible = access.isAdmin ? access.folders : access.accessible;
    const visibleIds = new Set(visible.map((f) => f.id));

    // Đếm tài liệu, chỉ trong phạm vi thư mục người này được thấy
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

    // Số email được cấp quyền cho từng thư mục riêng tư (chỉ admin cần biết)
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
    if (!name) return res.status(400).json({ error: 'Thiếu tên thư mục' });

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
        message: `Tạo thư mục riêng tư "${name}" cho ${permissions.saved.length} thành viên`,
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
    if (!folder) return res.status(404).json({ error: 'Không tìm thấy thư mục' });

    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body?.parent_id !== undefined) patch.parent_id = req.body.parent_id || null;
    if (req.body?.visibility !== undefined) {
      patch.visibility = req.body.visibility === 'private' ? 'private' : 'public';
    }

    if (patch.parent_id === req.params.folderId) {
      return res.status(400).json({ error: 'Không thể đặt thư mục làm cha của chính nó' });
    }
    // Chặn tạo vòng lặp: không cho chuyển một thư mục vào chính nhánh con của nó
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
          return res.status(400).json({ error: 'Không thể chuyển thư mục vào bên trong thư mục con của chính nó' });
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
      // Chuyển về công khai thì bỏ hết danh sách quyền cũ cho khỏi hiểu nhầm
      await supabase.from('folder_permissions').delete().eq('folder_id', data.id);
    }

    if (patch.visibility && patch.visibility !== folder.visibility) {
      await logEvent({
        scope: 'auth',
        organizationId: req.org.id,
        userId: req.user.id,
        message: `Đổi thư mục "${data.name}" sang ${patch.visibility === 'private' ? 'riêng tư' : 'công khai'}`,
      });
    }

    res.json({ ...data, permissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/folders/:folderId/permissions — danh sách email được đọc */
router.get('/:folderId/permissions', requireOrgAdmin, async (req, res) => {
  try {
    const { data: folder } = await supabase
      .from('folders')
      .select('id, name, visibility')
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!folder) return res.status(404).json({ error: 'Không tìm thấy thư mục' });

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
    if (!folder) return res.status(404).json({ error: 'Không tìm thấy thư mục' });
    if (folder.visibility !== 'private') {
      return res.status(400).json({ error: 'Thư mục đang ở chế độ công khai nên không cần cấp quyền riêng' });
    }

    const result = await setFolderPermissions(req.org.id, folder.id, req.body?.emails, req.user.id);
    await logEvent({
      scope: 'auth',
      organizationId: req.org.id,
      userId: req.user.id,
      message: `Cập nhật quyền thư mục "${folder.name}": ${result.saved.length} thành viên`,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /orgs/:orgId/folders/:folderId
 * Thư mục con bị xoá theo (cascade). Tài liệu bên trong KHÔNG bị xoá,
 * chỉ chuyển về mục "Chưa phân loại".
 */
router.delete('/:folderId', requireOrgAdmin, async (req, res) => {
  try {
    const { data: all } = await supabase
      .from('folders')
      .select('id, parent_id, visibility, name')
      .eq('organization_id', req.org.id);

    // Gom toàn bộ nhánh con sẽ bị xoá theo
    const ids = [];
    const collect = (id) => {
      ids.push(id);
      for (const f of all || []) if (f.parent_id === id) collect(f.id);
    };
    collect(req.params.folderId);

    const target = (all || []).find((f) => f.id === req.params.folderId);

    // Cảnh báo: tài liệu trong thư mục riêng tư sẽ thành "chưa phân loại",
    // nghĩa là cả tổ chức đọc được. Buộc admin xác nhận rõ ràng.
    const hasPrivate = (all || []).some((f) => ids.includes(f.id) && f.visibility === 'private');
    if (hasPrivate && req.query.confirm !== 'move-to-public') {
      const { count } = await supabase
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .in('folder_id', ids);
      return res.status(409).json({
        error: 'needs_confirmation',
        message:
          `Thư mục này (hoặc thư mục con) đang ở chế độ riêng tư và chứa ${count || 0} tài liệu. ` +
          `Nếu xoá, các tài liệu đó sẽ chuyển về mục "Chưa phân loại" và MỌI thành viên trong tổ chức sẽ hỏi được. ` +
          `Hãy chuyển tài liệu sang thư mục riêng tư khác trước, hoặc xác nhận để tiếp tục.`,
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
      message: `Xoá thư mục "${target?.name || req.params.folderId}"`,
    });

    res.json({ message: 'Đã xoá thư mục, tài liệu bên trong chuyển về mục Chưa phân loại' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
