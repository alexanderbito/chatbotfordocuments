import { supabase } from './supabaseClient.js';

/**
 * Measure an organization's current usage against the limits of its plan.
 */
export async function getUsage(orgId, plan) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [docsRes, membersRes, questionsRes, chunksRes, sizeRes, ocrRes] = await Promise.all([
    supabase.from('documents').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('organization_members').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).neq('status', 'disabled'),
    supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).gte('created_at', startOfMonth.toISOString()),
    supabase.from('document_chunks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId),
    supabase.from('documents').select('size_bytes').eq('organization_id', orgId),
    supabase.from('documents').select('ocr_pages').eq('organization_id', orgId).gte('created_at', startOfMonth.toISOString()),
  ]);

  const storageBytes = (sizeRes.data || []).reduce((sum, d) => sum + (d.size_bytes || 0), 0);
  const ocrPages = (ocrRes.data || []).reduce((sum, d) => sum + (d.ocr_pages || 0), 0);

  const limits = {
    max_documents: plan?.max_documents ?? 20,
    max_members: plan?.max_members ?? 5,
    max_storage_mb: plan?.max_storage_mb ?? 100,
    max_questions_per_month: plan?.max_questions_per_month ?? 500,
    max_ocr_pages_per_month: plan?.max_ocr_pages_per_month ?? 50,
  };

  return {
    documents: docsRes.count || 0,
    members: membersRes.count || 0,
    questions_this_month: questionsRes.count || 0,
    chunks: chunksRes.count || 0,
    storage_mb: Math.round((storageBytes / (1024 * 1024)) * 100) / 100,
    ocr_pages_this_month: ocrPages,
    limits,
  };
}

/**
 * Check before performing an action that consumes quota.
 * Returns { ok: true } or { ok: false, error: '...' }
 */
export async function checkQuota(orgId, plan, action, extraBytes = 0) {
  const usage = await getUsage(orgId, plan);
  const L = usage.limits;

  if (action === 'upload') {
    if (usage.documents >= L.max_documents) {
      return { ok: false, error: `Your plan allows ${L.max_documents} documents and you have reached that limit. Upgrade to add more.` };
    }
    const newMb = usage.storage_mb + extraBytes / (1024 * 1024);
    if (newMb > L.max_storage_mb) {
      return { ok: false, error: `This would exceed the ${L.max_storage_mb} MB of storage your plan includes. Upgrade for more room.` };
    }
  }

  if (action === 'invite' && usage.members >= L.max_members) {
    return { ok: false, error: `Your plan allows ${L.max_members} members and you have reached that limit. Upgrade to invite more.` };
  }

  if (action === 'chat' && usage.questions_this_month >= L.max_questions_per_month) {
    return { ok: false, error: `You have used all ${L.max_questions_per_month} questions included in your plan this month.` };
  }

  // Here extraBytes carries the number of pages that need OCR
  if (action === 'ocr') {
    const pages = extraBytes;
    const remaining = L.max_ocr_pages_per_month - usage.ocr_pages_this_month;
    if (remaining <= 0) {
      return { ok: false, error: `You have used all ${L.max_ocr_pages_per_month} OCR pages included in your plan this month.` };
    }
    if (pages > remaining) {
      return { ok: false, error: `This document needs ${pages} OCR pages but only ${remaining} are left on your plan this month.` };
    }
  }

  return { ok: true, usage };
}
