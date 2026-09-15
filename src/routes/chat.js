import express from 'express';
import { embedText } from '../embed.js';
import { generateAnswer } from '../llm.js';
import { supabase } from '../supabaseClient.js';

const router = express.Router();

// POST /chat  { organization_id, question }
router.post('/', async (req, res) => {
  try {
    const { organization_id, question } = req.body;

    if (!organization_id || !question) {
      return res.status(400).json({ error: 'Thiếu organization_id hoặc question' });
    }

    // 1. Tạo embedding cho câu hỏi
    const queryEmbedding = await embedText(question);

    // 2. Semantic search — LUÔN lọc theo organization_id để cách ly tenant
    const { data: matches, error } = await supabase.rpc('match_document_chunks', {
      query_embedding: queryEmbedding,
      match_org_id: organization_id,
      match_count: 5,
    });

    if (error) throw error;

    if (!matches || matches.length === 0) {
      return res.json({
        answer:
          'Không tìm thấy tài liệu nào liên quan trong dữ liệu của doanh nghiệp bạn.',
        sources: [],
      });
    }

    // 3. Lấy tên file cho từng chunk để hiển thị nguồn
    const docIds = [...new Set(matches.map((m) => m.document_id))];
    const { data: docs } = await supabase
      .from('documents')
      .select('id, filename')
      .in('id', docIds);

    const docMap = Object.fromEntries(docs.map((d) => [d.id, d.filename]));
    const contextChunks = matches.map((m) => ({
      content: m.content,
      filename: docMap[m.document_id] || 'Không rõ',
    }));

    // 4. Gọi DeepSeek sinh câu trả lời dựa trên context
    const answer = await generateAnswer(question, contextChunks);

    res.json({
      answer,
      sources: [...new Set(contextChunks.map((c) => c.filename))],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
