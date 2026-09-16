import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { uploadToR2, deleteFromR2, getDownloadUrl } from '../storage.js';
import { extractText } from '../textExtract.js';
import { chunkText } from '../chunk.js';
import { embedBatch } from '../embed.js';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { checkQuota } from '../limits.js';
import { logEvent } from '../logger.js';

const router = express.Router({ mergeParams: true });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB / file
});

router.use(requireAuth, requireOrgMember);

/** GET /orgs/:orgId/documents?folder_id=&q= — danh sách tài liệu (admin tổ chức) */
router.get('/', requireOrgAdmin, async (req, res) => {
  try {
    let query = supabase
      .from('documents')
      .select('id, filename, status, folder_id, size_bytes, mime_type, chunk_count, error_message, created_at, uploaded_by')
      .eq('organization_id', req.org.id)
      .order('created_at', { ascending: false });

    if (req.query.folder_id === 'none') query = query.is('folder_id', null);
    else if (req.query.folder_id) query = query.eq('folder_id', req.query.folder_id);
    if (req.query.q) query = query.ilike('filename', `%${req.query.q}%`);

    const { data, error } = await query;
    if (error) throw error;

    // Gắn tên người tải lên
    const userIds = [...new Set((data || []).map((d) => d.uploaded_by).filter(Boolean))];
    let userMap = {};
    if (userIds.length) {
      const { data: users } = await supabase.from('app_users').select('id, email, full_name').in('id', userIds);
      userMap = Object.fromEntries((users || []).map((u) => [u.id, u.full_name || u.email]));
    }

    res.json((data || []).map((d) => ({ ...d, uploader: userMap[d.uploaded_by] || '—' })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /orgs/:orgId/documents  (form-data: file, folder_id) */
router.post('/', requireOrgAdmin, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Chưa chọn file' });

    const quota = await checkQuota(req.org.id, req.org.plan, 'upload', file.size);
    if (!quota.ok) return res.status(402).json({ error: quota.error });

    const folderId = req.body?.folder_id || null;
    const key = `${req.org.id}/${uuidv4()}-${file.originalname}`;
    const { storage_key, storage_url } = await uploadToR2(key, file.buffer, file.mimetype);

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .insert({
        organization_id: req.org.id,
        folder_id: folderId,
        filename: file.originalname,
        storage_key,
        storage_url,
        status: 'processing',
        uploaded_by: req.user.id,
        size_bytes: file.size,
        mime_type: file.mimetype,
      })
      .select()
      .single();
    if (docErr) throw docErr;

    // Xử lý nền: extract -> chunk -> embed -> lưu
    processDocument(doc, file.buffer, file.mimetype).catch((err) =>
      logEvent({ level: 'error', scope: 'upload', organizationId: req.org.id, message: `Lỗi xử lý tài liệu ${doc.filename}`, detail: { error: err.message } })
    );

    res.json({ message: 'Đã nhận file, đang xử lý', document: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /orgs/:orgId/documents/:docId { folder_id, filename } — di chuyển / đổi tên */
router.patch('/:docId', requireOrgAdmin, async (req, res) => {
  try {
    const patch = {};
    if (req.body?.folder_id !== undefined) patch.folder_id = req.body.folder_id || null;
    if (req.body?.filename) patch.filename = String(req.body.filename).trim();

    const { data, error } = await supabase
      .from('documents')
      .update(patch)
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .select()
      .single();
    if (error) throw error;

    if (patch.folder_id !== undefined) {
      await supabase.from('document_chunks').update({ folder_id: patch.folder_id }).eq('document_id', req.params.docId);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/documents/:docId/download — link tải có chữ ký, hết hạn 5 phút */
router.get('/:docId/download', requireOrgAdmin, async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('documents')
      .select('storage_key, filename')
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Không tìm thấy tài liệu' });

    const url = await getDownloadUrl(doc.storage_key, doc.filename);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /orgs/:orgId/documents/:docId */
router.delete('/:docId', requireOrgAdmin, async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('documents')
      .select('id, storage_key, filename')
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Không tìm thấy tài liệu' });

    await supabase.from('document_chunks').delete().eq('document_id', doc.id);
    await supabase.from('documents').delete().eq('id', doc.id);
    try {
      await deleteFromR2(doc.storage_key);
    } catch (e) {
      await logEvent({ level: 'warn', scope: 'upload', organizationId: req.org.id, message: `Không xoá được file trên R2: ${doc.storage_key}`, detail: { error: e.message } });
    }

    await logEvent({ scope: 'upload', organizationId: req.org.id, userId: req.user.id, message: `Đã xoá tài liệu ${doc.filename}` });
    res.json({ message: 'Đã xoá tài liệu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /orgs/:orgId/documents/:docId/reindex — xử lý lại tài liệu lỗi */
router.post('/:docId/reindex', requireOrgAdmin, async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('documents')
      .select('*')
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Không tìm thấy tài liệu' });

    const { downloadFromR2 } = await import('../storage.js');
    await supabase.from('documents').update({ status: 'processing', error_message: null }).eq('id', doc.id);
    await supabase.from('document_chunks').delete().eq('document_id', doc.id);

    downloadFromR2(doc.storage_key)
      .then((buffer) => processDocument(doc, buffer, doc.mime_type))
      .catch((err) =>
        logEvent({ level: 'error', scope: 'upload', organizationId: req.org.id, message: `Reindex thất bại: ${doc.filename}`, detail: { error: err.message } })
      );

    res.json({ message: 'Đang xử lý lại tài liệu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Pipeline xử lý tài liệu
// ---------------------------------------------------------------------
async function processDocument(doc, buffer, mimeType) {
  try {
    const text = await extractText(buffer, mimeType);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await supabase
        .from('documents')
        .update({ status: 'failed', error_message: 'Không trích xuất được nội dung (có thể là PDF scan/ảnh, cần OCR)' })
        .eq('id', doc.id);
      await logEvent({ level: 'warn', scope: 'upload', organizationId: doc.organization_id, message: `Tài liệu rỗng sau khi trích xuất: ${doc.filename}` });
      return;
    }

    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batchChunks = chunks.slice(i, i + BATCH);
      const embeddings = await embedBatch(batchChunks);

      const rows = batchChunks.map((content, idx) => ({
        document_id: doc.id,
        organization_id: doc.organization_id,
        folder_id: doc.folder_id || null,
        content,
        embedding: embeddings[idx],
        chunk_index: i + idx,
      }));

      const { error } = await supabase.from('document_chunks').insert(rows);
      if (error) throw error;
    }

    await supabase
      .from('documents')
      .update({ status: 'ready', chunk_count: chunks.length, error_message: null })
      .eq('id', doc.id);

    await logEvent({ scope: 'upload', organizationId: doc.organization_id, message: `Đã index xong ${doc.filename} (${chunks.length} đoạn)` });
  } catch (err) {
    await supabase
      .from('documents')
      .update({ status: 'failed', error_message: String(err.message).slice(0, 500) })
      .eq('id', doc.id);
    await logEvent({ level: 'error', scope: 'upload', organizationId: doc.organization_id, message: `Xử lý tài liệu thất bại: ${doc.filename}`, detail: { error: err.message } });
  }
}

export default router;
