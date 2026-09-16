import express from 'express';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireOrgMember);

/** GET /orgs/:orgId/folders — cây thư mục + số tài liệu mỗi thư mục */
router.get('/', async (req, res) => {
  try {
    const [{ data: folders, error }, { data: docs }] = await Promise.all([
      supabase
        .from('folders')
        .select('id, name, parent_id, created_at')
        .eq('organization_id', req.org.id)
        .order('name'),
      supabase.from('documents').select('folder_id').eq('organization_id', req.org.id),
    ]);
    if (error) throw error;

    const counts = {};
    let unfiled = 0;
    for (const d of docs || []) {
      if (!d.folder_id) unfiled++;
      else counts[d.folder_id] = (counts[d.folder_id] || 0) + 1;
    }

    res.json({
      folders: (folders || []).map((f) => ({ ...f, document_count: counts[f.id] || 0 })),
      unfiled_count: unfiled,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /orgs/:orgId/folders { name, parent_id } */
router.post('/', requireOrgAdmin, async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Thiếu tên thư mục' });

    const { data, error } = await supabase
      .from('folders')
      .insert({
        organization_id: req.org.id,
        name,
        parent_id: req.body?.parent_id || null,
        created_by: req.user.id,
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /orgs/:orgId/folders/:folderId { name, parent_id } */
router.patch('/:folderId', requireOrgAdmin, async (req, res) => {
  try {
    const patch = {};
    if (req.body?.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body?.parent_id !== undefined) patch.parent_id = req.body.parent_id || null;
    if (patch.parent_id === req.params.folderId) {
      return res.status(400).json({ error: 'Không thể đặt thư mục làm cha của chính nó' });
    }

    const { data, error } = await supabase
      .from('folders')
      .update(patch)
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /orgs/:orgId/folders/:folderId
 * Thư mục con bị xoá theo (cascade). Tài liệu bên trong KHÔNG bị xoá,
 * chỉ chuyển về mục "Chưa phân loại" để tránh mất dữ liệu ngoài ý muốn.
 */
router.delete('/:folderId', requireOrgAdmin, async (req, res) => {
  try {
    const { data: children } = await supabase
      .from('folders')
      .select('id')
      .eq('organization_id', req.org.id)
      .eq('parent_id', req.params.folderId);

    const ids = [req.params.folderId, ...(children || []).map((c) => c.id)];
    await supabase.from('documents').update({ folder_id: null }).in('folder_id', ids);
    await supabase.from('document_chunks').update({ folder_id: null }).in('folder_id', ids);

    const { error } = await supabase
      .from('folders')
      .delete()
      .eq('id', req.params.folderId)
      .eq('organization_id', req.org.id);
    if (error) throw error;

    res.json({ message: 'Đã xoá thư mục, tài liệu bên trong chuyển về mục Chưa phân loại' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
