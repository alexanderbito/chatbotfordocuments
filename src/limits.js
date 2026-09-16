import { supabase } from './supabaseClient.js';

/**
 * Tính mức sử dụng hiện tại của một tổ chức và so với hạn mức của gói cước.
 */
export async function getUsage(orgId, plan) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [docsRes, membersRes, questionsRes, chunksRes, sizeRes] = await Promise.all([
    supabase.from('documents').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('organization_members').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).neq('status', 'disabled'),
    supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).gte('created_at', startOfMonth.toISOString()),
    supabase.from('document_chunks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('documents').select('size_bytes').eq('organization_id', orgId),
  ]);

  const storageBytes = (sizeRes.data || []).reduce((sum, d) => sum + (d.size_bytes || 0), 0);

  const limits = {
    max_documents: plan?.max_documents ?? 20,
    max_members: plan?.max_members ?? 5,
    max_storage_mb: plan?.max_storage_mb ?? 100,
    max_questions_per_month: plan?.max_questions_per_month ?? 500,
  };

  return {
    documents: docsRes.count || 0,
    members: membersRes.count || 0,
    questions_this_month: questionsRes.count || 0,
    chunks: chunksRes.count || 0,
    storage_mb: Math.round((storageBytes / (1024 * 1024)) * 100) / 100,
    limits,
  };
}

/**
 * Kiểm tra trước khi thực hiện hành động tốn hạn mức.
 * Trả về { ok: true } hoặc { ok: false, error: '...' }
 */
export async function checkQuota(orgId, plan, action, extraBytes = 0) {
  const usage = await getUsage(orgId, plan);
  const L = usage.limits;

  if (action === 'upload') {
    if (usage.documents >= L.max_documents) {
      return { ok: false, error: `Đã đạt giới hạn ${L.max_documents} tài liệu của gói hiện tại. Vui lòng nâng cấp gói.` };
    }
    const newMb = usage.storage_mb + extraBytes / (1024 * 1024);
    if (newMb > L.max_storage_mb) {
      return { ok: false, error: `Vượt dung lượng lưu trữ ${L.max_storage_mb} MB của gói hiện tại. Vui lòng nâng cấp gói.` };
    }
  }

  if (action === 'invite' && usage.members >= L.max_members) {
    return { ok: false, error: `Đã đạt giới hạn ${L.max_members} thành viên của gói hiện tại. Vui lòng nâng cấp gói.` };
  }

  if (action === 'chat' && usage.questions_this_month >= L.max_questions_per_month) {
    return { ok: false, error: `Đã dùng hết ${L.max_questions_per_month} lượt hỏi trong tháng của gói hiện tại.` };
  }

  return { ok: true, usage };
}
