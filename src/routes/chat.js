import express from 'express';
import { embedText } from '../embed.js';
import { generateAnswer } from '../llm.js';
import { supabase } from '../supabaseClient.js';
import { requireAuth, requireOrgMember, requireOrgAdmin } from '../auth.js';
import { checkQuota } from '../limits.js';
import { logEvent } from '../logger.js';
import { getFolderAccess } from '../access.js';

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireOrgMember);

/**
 * POST /orgs/:orgId/chat  { question, folder_ids? }
 * Mọi thành viên (admin và user) đều dùng được.
 */
router.post('/', async (req, res) => {
  const startedAt = Date.now();
  try {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Chưa nhập câu hỏi' });

    const quota = await checkQuota(req.org.id, req.org.plan, 'chat');
    if (!quota.ok) return res.status(402).json({ error: quota.error });

    // 1. Tính danh sách thư mục người hỏi ĐƯỢC PHÉP đọc.
    //    Thư mục riêng tư mà họ không được cấp quyền sẽ không nằm trong danh sách,
    //    nên chatbot không thể lấy nội dung bên trong để trả lời.
    const access = await getFolderAccess(req.org.id, req.user, req.membership);
    let allowedIds = access.allowedIds;

    // Nếu người dùng tự chọn phạm vi thư mục thì giao với danh sách được phép
    const requested = Array.isArray(req.body?.folder_ids) ? req.body.folder_ids.filter(Boolean) : null;
    let includeUnfiled = true;
    if (requested && requested.length) {
      const allowedSet = new Set(allowedIds);
      const denied = requested.filter((id) => !allowedSet.has(id));
      if (denied.length) {
        return res.status(403).json({ error: 'Bạn không có quyền hỏi trong thư mục đã chọn' });
      }
      allowedIds = requested;
      includeUnfiled = false;
    }

    // 2. Embedding câu hỏi
    const queryEmbedding = await embedText(question);

    // 3. Tìm kiếm ngữ nghĩa — lọc theo organization_id để cách ly giữa các tổ chức,
    //    và lọc theo allowed_folder_ids để cách ly trong nội bộ tổ chức.
    const { data: matches, error } = await supabase.rpc('match_document_chunks_acl', {
      query_embedding: queryEmbedding,
      match_org_id: req.org.id,
      match_count: 5,
      allowed_folder_ids: allowedIds,
      include_unfiled: includeUnfiled,
    });
    if (error) throw error;

    if (!matches || matches.length === 0) {
      const answer = 'Không tìm thấy thông tin liên quan trong những tài liệu bạn được phép truy cập.';
      await saveMessage(req, question, answer, [], 0, Date.now() - startedAt);
      return res.json({ answer, sources: [] });
    }

    // 4. Lấy tên file để hiển thị nguồn
    const docIds = [...new Set(matches.map((m) => m.document_id))];
    const { data: docs } = await supabase.from('documents').select('id, filename').in('id', docIds);
    const docMap = Object.fromEntries((docs || []).map((d) => [d.id, d.filename]));

    const contextChunks = matches.map((m) => ({
      content: m.content,
      filename: docMap[m.document_id] || 'Không rõ',
    }));

    // 5. Sinh câu trả lời
    const answer = await generateAnswer(question, contextChunks);
    const sources = [...new Set(contextChunks.map((c) => c.filename))];

    await saveMessage(req, question, answer, sources, matches.length, Date.now() - startedAt);

    res.json({ answer, sources });
  } catch (err) {
    await logEvent({
      level: 'error',
      scope: 'chat',
      organizationId: req.org?.id,
      userId: req.user?.id,
      message: 'Lỗi khi trả lời câu hỏi',
      detail: { error: err.message },
    });
    res.status(500).json({ error: err.message });
  }
});

/** GET /orgs/:orgId/chat/mine — lịch sử hỏi đáp của chính người dùng */
router.get('/mine', async (req, res) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, question, answer, sources, created_at')
    .eq('organization_id', req.org.id)
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).reverse());
});

/** GET /orgs/:orgId/chat/history?page=&q= — toàn bộ lịch sử (chỉ admin tổ chức) */
router.get('/history', requireOrgAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const size = Math.min(100, parseInt(req.query.size || '25', 10));
    const from = (page - 1) * size;

    let query = supabase
      .from('chat_messages')
      .select('id, question, answer, sources, user_email, latency_ms, matched_chunks, created_at', { count: 'exact' })
      .eq('organization_id', req.org.id)
      .order('created_at', { ascending: false })
      .range(from, from + size - 1);

    if (req.query.q) query = query.ilike('question', `%${req.query.q}%`);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ items: data || [], total: count || 0, page, size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function saveMessage(req, question, answer, sources, matched, latency) {
  try {
    await supabase.from('chat_messages').insert({
      organization_id: req.org.id,
      user_id: req.user.id,
      user_email: req.user.email,
      question,
      answer,
      sources,
      matched_chunks: matched,
      latency_ms: latency,
    });
  } catch (err) {
    console.error('Không lưu được lịch sử chat:', err.message);
  }
}

export default router;
