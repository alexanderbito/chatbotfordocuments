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

/** GET /orgs/:orgId/documents?folder_id=&q= — list documents (organization admin only) */
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

    // Attach the uploader's name
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
    if (!file) return res.status(400).json({ error: 'No file selected' });

    const quota = await checkQuota(req.org.id, req.org.plan, 'upload', file.size);
    if (!quota.ok) return res.status(402).json({ error: quota.error });

    // The display name keeps its original accented characters; the R2 key uses an ASCII-safe version.
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

    // Background processing through the queue: extract -> (OCR if it is a scan) -> chunk -> embed
    try {
      enqueue(`doc:${doc.id}`, () => processDocument(doc, file.buffer, file.mimetype, req.org.plan)).catch((err) =>
        logEvent({ level: 'error', scope: 'upload', organizationId: req.org.id, message: `Failed to process document ${doc.filename}`, detail: { error: err.message } })
      );
    } catch (err) {
      if (err instanceof QueueFullError) {
        await supabase.from('documents').update({ status: 'failed', error_message: err.message }).eq('id', doc.id);
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }

    res.json({ message: 'File received, processing now', document: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** PATCH /orgs/:orgId/documents/:docId { folder_id, filename } — move / rename */
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

/** GET /orgs/:orgId/documents/:docId/download — signed download link, expires after 5 minutes */
router.get('/:docId/download', requireOrgAdmin, async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('documents')
      .select('storage_key, filename')
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

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
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await supabase.from('document_chunks').delete().eq('document_id', doc.id);
    await supabase.from('documents').delete().eq('id', doc.id);
    try {
      await deleteFromR2(doc.storage_key);
    } catch (e) {
      await logEvent({ level: 'warn', scope: 'upload', organizationId: req.org.id, message: `Could not delete the file from R2: ${doc.storage_key}`, detail: { error: e.message } });
    }

    await logEvent({ scope: 'upload', organizationId: req.org.id, userId: req.user.id, message: `Deleted document ${doc.filename}` });
    res.json({ message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /orgs/:orgId/documents/:docId/reindex — reprocess a document that failed */
router.post('/:docId/reindex', requireOrgAdmin, blockIfTrialExpired, async (req, res) => {
  try {
    const { data: doc } = await supabase
      .from('documents')
      .select('*')
      .eq('id', req.params.docId)
      .eq('organization_id', req.org.id)
      .maybeSingle();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const { downloadFromR2 } = await import('../storage.js');
    await supabase.from('documents').update({ status: 'processing', error_message: null, ocr_pages: 0, ocr_attempts: 0, next_retry_at: null }).eq('id', doc.id);
    await supabase.from('document_chunks').delete().eq('document_id', doc.id);

    enqueue(`reindex:${doc.id}`, async () => {
      const buffer = await downloadFromR2(doc.storage_key);
      return processDocument(doc, buffer, doc.mime_type, req.org.plan);
    }).catch((err) =>
      logEvent({ level: 'error', scope: 'upload', organizationId: req.org.id, message: `Reprocessing failed: ${doc.filename}`, detail: { error: err.message } })
    );

    res.json({ message: 'Reprocessing the document' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Document processing pipeline
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
    // 1. Try reading real text first — fast and free.
    let { text, pages } = await extractText(buffer, mimeType);
    pageCount = pages;

    // 2. A PDF with no real text is a scan, so fall back to character recognition.
    if (mimeType === 'application/pdf' && needsOcr(text, pages)) {
      // The trial plan has no OCR — say so clearly so the customer knows to upgrade,
      // and, importantly, do NOT call Gemini, so no cost is incurred.
      if (plan && plan.ocr_enabled === false) {
        await markFailed(
          doc.id,
          `The "${plan.name}" plan does not support recognition of scanned PDFs. Upgrade your plan, or upload a text-based PDF, DOCX or TXT file.`
        );
        await logEvent({
          scope: 'upload',
          organizationId: doc.organization_id,
          message: `OCR blocked, the plan does not include it: ${doc.filename}`,
        });
        return;
      }

      if (!isOcrEnabled()) {
        await markFailed(doc.id, 'This is a scanned/image PDF. Character recognition is not enabled on this system (GEMINI_API_KEY is missing).');
        return;
      }

      const ocrPageCount = pages || (await countPdfPages(buffer));

      if (ocrPageCount > OCR_MAX_PAGES) {
        await markFailed(doc.id, `This scanned document has ${ocrPageCount} pages, over the ${OCR_MAX_PAGES}-page-per-file limit. Split it into smaller files and upload it again.`);
        return;
      }

      const quota = await checkQuota(doc.organization_id, plan, 'ocr', ocrPageCount);
      if (!quota.ok) {
        await markFailed(doc.id, quota.error);
        await logEvent({ level: 'warn', scope: 'upload', organizationId: doc.organization_id, message: `OCR blocked, quota exhausted: ${doc.filename}`, detail: { pages: ocrPageCount } });
        return;
      }

      await supabase.from('documents').update({ status: 'ocr_processing', next_retry_at: null }).eq('id', doc.id);
      await logEvent({ scope: 'upload', organizationId: doc.organization_id, message: `Starting recognition of ${ocrPageCount} pages: ${doc.filename}` });

      // Load batches already recognised on a previous run so we do not call Gemini again
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
            message: `Gemini ${n.model} did not respond (round ${n.round + 1}): ${doc.filename}`,
            detail: { error: n.message },
          }),
      });

      text = result.text;
      ocrPages = result.pages;
      pageCount = result.pages;
      extractionMethod = 'ocr';

      if (result.fromCache) {
        await logEvent({ scope: 'upload', organizationId: doc.organization_id, message: `Reused ${result.fromCache} batches recognised earlier: ${doc.filename}` });
      }
      if (result.truncated) {
        await logEvent({ level: 'warn', scope: 'upload', organizationId: doc.organization_id, message: `Recognition output may be truncated because the document is too long: ${doc.filename}` });
      }
    }

    // 3. Split into chunks
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await markFailed(
        doc.id,
        extractionMethod === 'ocr'
          ? 'Recognition finished but produced no usable content (the scan may be too blurry).'
          : 'No content could be extracted from this document.'
      );
      return;
    }

    if (extractionMethod !== 'ocr') {
      await supabase.from('documents').update({ status: 'processing' }).eq('id', doc.id);
    }

    // 4. Generate embeddings batch by batch
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

    // Once we are done, the intermediate recognition results are no longer needed
    if (extractionMethod === 'ocr') {
      await supabase.from('document_ocr_batches').delete().eq('document_id', doc.id);
    }

    await logEvent({
      scope: 'upload',
      organizationId: doc.organization_id,
      message: `Finished indexing ${doc.filename} (${chunks.length} chunks${extractionMethod === 'ocr' ? `, ${ocrPages} pages recognised` : ''})`,
    });
  } catch (err) {
    // For transient errors (Gemini overloaded, flaky network) schedule a retry automatically
    // instead of making the admin sit and click "Reprocess".
    if ((err.transient || isTransient(err)) && plan !== undefined) {
      const scheduled = await scheduleRetry(doc, mimeType, plan, err);
      if (scheduled) return;
    }

    await markFailed(doc.id, err.message);
    await logEvent({
      level: 'error',
      scope: 'upload',
      organizationId: doc.organization_id,
      message: `Document processing failed: ${doc.filename}`,
      detail: { error: err.message, method: extractionMethod },
    });
  }
}

// ---------------------------------------------------------------------
// Checkpointing recognition results batch by batch
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
    console.error('Could not read the saved OCR batches:', err.message);
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
    // If the save fails, that batch has to be recognised again next time, but the main flow is unaffected
    console.error('Could not save the OCR batch:', err.message);
  }
}

// ---------------------------------------------------------------------
// Automatic retry scheduling for transient errors
// ---------------------------------------------------------------------
const MAX_DOC_RETRIES = Number(process.env.OCR_DOC_RETRIES || 3);
// Short intervals, because Render Free sleeps after 15 minutes without traffic
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
      `Gemini has been overloaded for a while; ${MAX_DOC_RETRIES} automatic retries all failed. ` +
      `Click "Reprocess" to continue — pages that were already recognised will not be redone.`
    );
    await logEvent({
      level: 'error',
      scope: 'upload',
      organizationId: doc.organization_id,
      message: `Out of automatic OCR retries: ${doc.filename}`,
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
      error_message: `Gemini is overloaded. Retrying automatically in ${minutes} minutes (attempt ${attempts} of ${MAX_DOC_RETRIES}).`,
    })
    .eq('id', doc.id);

  await logEvent({
    level: 'warn',
    scope: 'upload',
    organizationId: doc.organization_id,
    message: `OCR retry scheduled in ${minutes} minutes: ${doc.filename}`,
    detail: { attempts, error: err.message },
  });

  setTimeout(() => {
    enqueue(`retry:${doc.id}`, async () => {
      // The document may have been deleted or finished processing while we waited
      const { data: still } = await supabase
        .from('documents')
        .select('id, status, organization_id, folder_id, filename, storage_key, mime_type')
        .eq('id', doc.id)
        .maybeSingle();
      if (!still || still.status !== 'ocr_retry') return;

      const buffer = await downloadFromR2(still.storage_key);
      return processDocument(still, buffer, mimeType, plan);
    }).catch((e) => console.error('OCR retry failed:', e.message));
  }, delay).unref?.();

  return true;
}

export default router;
