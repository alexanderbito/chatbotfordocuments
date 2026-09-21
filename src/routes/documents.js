import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { uploadToR2, deleteFromR2, getDownloadUrl } from '../storage.js';
import { extractText } from '../textExtract.js';
import { chunkText } from '../chunk.js';
import { embedBatch } from '../embed.js';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin, blockIfTrialExpired } from '../auth.js';
import { checkQuota } from '../limits.js';
import { logEvent } from '../logger.js';
import { decodeFilename, toStorageSafeName } from '../utils/filename.js';
import { needsOcr, ocrPdf, isOcrEnabled, countPdfPages, isTransient, OCR_MAX_PAGES } from '../ocr.js';
import { enqueue, QueueFullError } from '../queue.js';

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
      .select('id, filename, status, folder_id, size_bytes, mime_type, chunk_count, error_message, created_at, uploaded_by, extraction_method, ocr_pages, page_count, ocr_attempts, next_retry_at')
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
router.post('/', requireOrgAdmin, blockIfTrialExpired, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Chưa chọn file' });

    const quota = await checkQuota(req.org.id, req.org.plan, 'upload', file.size);
    if (!quota.ok) return res.status(402).json({ error: quota.error });

    // Tên hiển thị giữ nguyên tiếng Việt có dấu; key trên R2 dùng bản không dấu cho an toàn.
    const filename = decodeFilename(file.originalname);
    const folderId = req.body?.folder_id || null;
    const key = `${req.org.id}/${uuidv4()}-${toStorageSafeName(filename)}`;
    const { storage_key, storage_url } = await uploadToR2(key, file.buffer, file.mimetype);

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .insert({
        organization_id: req.org.id,
        folder_id: folderId,
        filename,
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

    // Xử lý nền qua hàng đợi: extract -> (OCR nếu là bản scan) -> chunk -> embed
    try {
      enqueue(`doc:${doc.id}`, () => processDocument(doc, file.buffer, file.mimetype, req.org.plan)).catch((err) =>
        logEvent({ level: 'error', scope: 'upload', organizationId: req.org.id, message: `Lỗi xử lý tài liệu ${doc.filename}`, detail: { error: err.message } })
      );
    } catch (err) {
      if (err instanceof QueueFullError) {
        await supabase.from('documents').update({ status: 'failed', error_message: err.message }).eq('id', doc.id);
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }

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
    if (req.body?.filename) patch.filename = String(req.body.filename).normalize('NFC').trim();

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
router.post('/:docId/reindex', requireOrgAdmin, blockIfTrialExpired, async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('documents')
      .select('*')
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Không tìm thấy tài liệu' });

    const { downloadFromR2 } = await import('../storage.js');
    await supabase.from('documents').update({ status: 'processing', error_message: null, ocr_pages: 0, ocr_attempts: 0, next_retry_at: null }).eq('id', doc.id);
    await supabase.from('document_chunks').delete().eq('document_id', doc.id);

    enqueue(`reindex:${doc.id}`, async () => {
      const buffer = await downloadFromR2(doc.storage_key);
      return processDocument(doc, buffer, doc.mime_type, req.org.plan);
    }).catch((err) =>
      logEvent({ level: 'error', scope: 'upload', organizationId: req.org.id, message: `Xử lý lại thất bại: ${doc.filename}`, detail: { error: err.message } })
    );

    res.json({ message: 'Đang xử lý lại tài liệu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Pipeline xử lý tài liệu
// ---------------------------------------------------------------------
async function markFailed(docId, message) {
  await supabase
    .from('documents')
    .update({ status: 'failed', error_message: String(message).slice(0, 500) })
    .eq('id', docId);
}

async function processDocument(doc, buffer, mimeType, plan) {
  let extractionMethod = 'text';
  let ocrPages = 0;
  let pageCount = 0;

  try {
    // 1. Thử đọc text thật trước — nhanh và không tốn phí.
    let { text, pages } = await extractText(buffer, mimeType);
    pageCount = pages;

    // 2. PDF không có text thật => là bản scan, chuyển sang nhận dạng ký tự.
    if (mimeType === 'application/pdf' && needsOcr(text, pages)) {
      // Gói dùng thử không có OCR — báo rõ để khách biết đường nâng cấp,
      // và quan trọng là KHÔNG gọi Gemini nên không phát sinh chi phí.
      if (plan && plan.ocr_enabled === false) {
        await markFailed(
          doc.id,
          `Gói "${plan.name}" không hỗ trợ nhận dạng PDF scan. Vui lòng nâng cấp gói, hoặc tải lên PDF có chữ thật, DOCX hay TXT.`
        );
        await logEvent({
          scope: 'upload',
          organizationId: doc.organization_id,
          message: `Chặn OCR vì gói không hỗ trợ: ${doc.filename}`,
        });
        return;
      }

      if (!isOcrEnabled()) {
        await markFailed(doc.id, 'Đây là PDF dạng scan/ảnh. Hệ thống chưa bật nhận dạng ký tự (thiếu GEMINI_API_KEY).');
        return;
      }

      const ocrPageCount = pages || (await countPdfPages(buffer));

      if (ocrPageCount > OCR_MAX_PAGES) {
        await markFailed(doc.id, `Tài liệu scan có ${ocrPageCount} trang, vượt giới hạn ${OCR_MAX_PAGES} trang mỗi file. Vui lòng tách nhỏ rồi tải lại.`);
        return;
      }

      const quota = await checkQuota(doc.organization_id, plan, 'ocr', ocrPageCount);
      if (!quota.ok) {
        await markFailed(doc.id, quota.error);
        await logEvent({ level: 'warn', scope: 'upload', organizationId: doc.organization_id, message: `Chặn OCR do hết hạn mức: ${doc.filename}`, detail: { pages: ocrPageCount } });
        return;
      }

      await supabase.from('documents').update({ status: 'ocr_processing', next_retry_at: null }).eq('id', doc.id);
      await logEvent({ scope: 'upload', organizationId: doc.organization_id, message: `Bắt đầu nhận dạng ${ocrPageCount} trang: ${doc.filename}` });

      // Lấy các lô đã nhận dạng xong ở lần chạy trước để không gọi lại Gemini
      const cached = await loadCachedBatches(doc.id);

      const result = await ocrPdf(buffer, {
        maxPages: OCR_MAX_PAGES,
        cached,
        onBatch: (b) => saveBatch(doc.id, b),
        onNotice: (n) =>
          logEvent({
            level: 'warn',
            scope: 'upload',
            organizationId: doc.organization_id,
            message: `Gemini ${n.model} chưa nhận được (vòng ${n.round + 1}): ${doc.filename}`,
            detail: { error: n.message },
          }),
      });

      text = result.text;
      ocrPages = result.pages;
      pageCount = result.pages;
      extractionMethod = 'ocr';

      if (result.fromCache) {
        await logEvent({ scope: 'upload', organizationId: doc.organization_id, message: `Dùng lại ${result.fromCache} lô đã nhận dạng trước đó: ${doc.filename}` });
      }
      if (result.truncated) {
        await logEvent({ level: 'warn', scope: 'upload', organizationId: doc.organization_id, message: `Kết quả nhận dạng có thể bị cắt do tài liệu quá dài: ${doc.filename}` });
      }
    }

    // 3. Chia đoạn
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await markFailed(
        doc.id,
        extractionMethod === 'ocr'
          ? 'Nhận dạng xong nhưng không thu được nội dung dùng được (ảnh có thể quá mờ).'
          : 'Không trích xuất được nội dung từ tài liệu.'
      );
      return;
    }

    if (extractionMethod !== 'ocr') {
      await supabase.from('documents').update({ status: 'processing' }).eq('id', doc.id);
    }

    // 4. Tạo embedding theo lô
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
      .update({
        status: 'ready',
        chunk_count: chunks.length,
        extraction_method: extractionMethod,
        ocr_pages: ocrPages,
        page_count: pageCount,
        error_message: null,
        next_retry_at: null,
      })
      .eq('id', doc.id);

    // Xong rồi thì không cần giữ bản nhận dạng tạm nữa
    if (extractionMethod === 'ocr') {
      await supabase.from('document_ocr_batches').delete().eq('document_id', doc.id);
    }

    await logEvent({
      scope: 'upload',
      organizationId: doc.organization_id,
      message: `Đã index xong ${doc.filename} (${chunks.length} đoạn${extractionMethod === 'ocr' ? `, nhận dạng ${ocrPages} trang` : ''})`,
    });
  } catch (err) {
    // Lỗi tạm thời (Gemini quá tải, mạng chập chờn) thì tự hẹn giờ thử lại,
    // không bắt admin phải ngồi bấm "Xử lý lại".
    if ((err.transient || isTransient(err)) && plan !== undefined) {
      const scheduled = await scheduleRetry(doc, mimeType, plan, err);
      if (scheduled) return;
    }

    await markFailed(doc.id, err.message);
    await logEvent({
      level: 'error',
      scope: 'upload',
      organizationId: doc.organization_id,
      message: `Xử lý tài liệu thất bại: ${doc.filename}`,
      detail: { error: err.message, method: extractionMethod },
    });
  }
}

// ---------------------------------------------------------------------
// Lưu tạm kết quả nhận dạng theo lô
// ---------------------------------------------------------------------
async function loadCachedBatches(docId) {
  const map = new Map();
  try {
    const { data } = await supabase
      .from('document_ocr_batches')
      .select('from_page, to_page, content')
      .eq('document_id', docId);
    for (const b of data || []) map.set(`${b.from_page}-${b.to_page}`, b.content);
  } catch (err) {
    console.error('Không đọc được lô OCR đã lưu:', err.message);
  }
  return map;
}

async function saveBatch(docId, batch) {
  try {
    await supabase.from('document_ocr_batches').upsert(
      {
        document_id: docId,
        from_page: batch.fromPage,
        to_page: batch.toPage,
        content: batch.text,
        model: batch.model,
      },
      { onConflict: 'document_id,from_page,to_page' }
    );
  } catch (err) {
    // Không lưu được thì lần sau phải nhận dạng lại lô đó, nhưng không làm hỏng luồng chính
    console.error('Không lưu được lô OCR:', err.message);
  }
}

// ---------------------------------------------------------------------
// Tự hẹn giờ thử lại khi gặp lỗi tạm thời
// ---------------------------------------------------------------------
const MAX_DOC_RETRIES = Number(process.env.OCR_DOC_RETRIES || 3);
// Giãn cách ngắn vì Render Free ngủ sau 15 phút không có traffic
const RETRY_DELAYS_MS = [2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000];

async function scheduleRetry(doc, mimeType, plan, err) {
  const { data: current } = await supabase
    .from('documents')
    .select('ocr_attempts')
    .eq('id', doc.id)
    .maybeSingle();

  const attempts = (current?.ocr_attempts || 0) + 1;

  if (attempts > MAX_DOC_RETRIES) {
    await supabase.from('documents').update({ ocr_attempts: attempts }).eq('id', doc.id);
    await markFailed(
      doc.id,
      `Gemini quá tải kéo dài, đã tự thử lại ${MAX_DOC_RETRIES} lần không thành công. ` +
      `Bấm "Xử lý lại" để chạy tiếp — những trang đã nhận dạng xong sẽ không phải làm lại.`
    );
    await logEvent({
      level: 'error',
      scope: 'upload',
      organizationId: doc.organization_id,
      message: `Hết lượt tự thử lại OCR: ${doc.filename}`,
      detail: { attempts, error: err.message },
    });
    return true;
  }

  const delay = RETRY_DELAYS_MS[attempts - 1] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const nextAt = new Date(Date.now() + delay);
  const minutes = Math.round(delay / 60000);

  await supabase
    .from('documents')
    .update({
      status: 'ocr_retry',
      ocr_attempts: attempts,
      next_retry_at: nextAt.toISOString(),
      error_message: `Gemini đang quá tải. Sẽ tự thử lại sau ${minutes} phút (lần ${attempts}/${MAX_DOC_RETRIES}).`,
    })
    .eq('id', doc.id);

  await logEvent({
    level: 'warn',
    scope: 'upload',
    organizationId: doc.organization_id,
    message: `Hẹn thử lại OCR sau ${minutes} phút: ${doc.filename}`,
    detail: { attempts, error: err.message },
  });

  setTimeout(() => {
    enqueue(`retry:${doc.id}`, async () => {
      // Tài liệu có thể đã bị xoá hoặc đã xử lý xong trong lúc chờ
      const { data: still } = await supabase
        .from('documents')
        .select('id, status, organization_id, folder_id, filename, storage_key, mime_type')
        .eq('id', doc.id)
        .maybeSingle();
      if (!still || still.status !== 'ocr_retry') return;

      const buffer = await downloadFromR2(still.storage_key);
      return processDocument(still, buffer, mimeType, plan);
    }).catch((e) => console.error('Thử lại OCR thất bại:', e.message));
  }, delay).unref?.();

  return true;
}

export default router;
