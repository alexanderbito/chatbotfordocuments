import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { uploadToR2 } from '../storage.js';
import { extractText } from '../textExtract.js';
import { chunkText } from '../chunk.js';
import { embedBatch } from '../embed.js';
import { supabase } from '../supabaseClient.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /upload  (form-data: file, organization_id)
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { organization_id } = req.body;
    const file = req.file;

    if (!organization_id || !file) {
      return res.status(400).json({ error: 'Thiếu organization_id hoặc file' });
    }

    // 1. Upload file gốc lên R2 (chỉ lưu URL vào DB, không lưu file trong DB)
    const key = `${organization_id}/${uuidv4()}-${file.originalname}`;
    const { storage_key, storage_url } = await uploadToR2(
      key,
      file.buffer,
      file.mimetype
    );

    // 2. Tạo record documents với status "processing"
    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .insert({
        organization_id,
        filename: file.originalname,
        storage_key,
        storage_url,
        status: 'processing',
      })
      .select()
      .single();

    if (docErr) throw docErr;

    // 3. Xử lý ngay (đồng bộ, phù hợp cho demo/tài liệu nhỏ).
    //    Ở bản production nên đẩy việc này vào queue/cron riêng.
    processDocument(doc, file.buffer, file.mimetype).catch((err) =>
      console.error('Lỗi xử lý tài liệu:', doc.id, err)
    );

    res.json({ message: 'Đã nhận file, đang xử lý', document: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

async function processDocument(doc, buffer, mimeType) {
  try {
    const text = await extractText(buffer, mimeType);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      await supabase
        .from('documents')
        .update({ status: 'failed' })
        .eq('id', doc.id);
      return;
    }

    // Gom theo lô 50 chunk/lần để tránh request embedding quá lớn
    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batchChunks = chunks.slice(i, i + BATCH);
      const embeddings = await embedBatch(batchChunks);

      const rows = batchChunks.map((content, idx) => ({
        document_id: doc.id,
        organization_id: doc.organization_id,
        content,
        embedding: embeddings[idx],
        chunk_index: i + idx,
      }));

      const { error } = await supabase.from('document_chunks').insert(rows);
      if (error) throw error;
    }

    await supabase.from('documents').update({ status: 'ready' }).eq('id', doc.id);
    console.log(`Đã index xong tài liệu ${doc.filename} (${chunks.length} chunk)`);
  } catch (err) {
    console.error('processDocument error:', err);
    await supabase.from('documents').update({ status: 'failed' }).eq('id', doc.id);
  }
}

export default router;
