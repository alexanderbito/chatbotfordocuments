import express from 'express';
import { supabase } from '../supabaseClient.js';
import { embedText } from '../embed.js';
import { generateAnswer } from '../llm.js';
import { notFoundMessage, forcedReplyLanguage } from '../language.js';
import { logEvent } from '../logger.js';
import { requireApiKey, meterApiCalls, apiError, scopeFolders } from '../apiKeys.js';

/**
 * The public API, version 1.
 *
 * Read-only on purpose. A key here can ask questions and see what it is allowed
 * to ask about; it cannot upload or delete anything. That means a leaked key
 * costs a customer their confidentiality within the folders the key was given —
 * bad, but bounded — rather than their documents.
 *
 * Every response is JSON, and every error carries a stable `code` so a client
 * can branch on it without reading English prose that we may later reword.
 */
const router = express.Router();

// CORS is deliberately absent. This API is for server-to-server calls, and a
// key that a browser can send is a key that is already public. Returning no
// Access-Control-Allow-Origin means a browser refuses to hand the answer to
// page script, which is the outcome we want. Customers who need a browser
// widget proxy through their own backend, where the key stays.

router.use(requireApiKey, meterApiCalls);

const MAX_QUESTION = 2000;

/**
 * POST /v1/chat
 * { question: string, folder_ids?: string[] }
 * -> { answer, sources: [{ document_id, filename }], usage }
 */
router.post('/chat', async (req, res) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    if (!question) {
      return apiError(res, 400, 'missing_question', 'Send a "question" field with your request.');
    }
    if (question.length > MAX_QUESTION) {
      return apiError(res, 400, 'question_too_long',
        `A question may be at most ${MAX_QUESTION} characters; this one is ${question.length}.`);
    }

    // What the key is allowed to read, before the caller narrows anything.
    const { data: folders } = await supabase
      .from('folders').select('id').eq('organization_id', req.org.id);
    const orgFolderIds = (folders || []).map((f) => f.id);
    let { ids: allowedIds, includeUnfiled } = scopeFolders(orgFolderIds, req.apiScope);

    // A caller may narrow further, never widen. Anything they ask for that is
    // outside the key's scope is refused rather than quietly dropped: silently
    // answering from a smaller set than asked for produces an answer the caller
    // believes covers ground it never saw.
    const requested = Array.isArray(req.body?.folder_ids) ? req.body.folder_ids.filter(Boolean).map(String) : null;
    if (requested && requested.length) {
      const allowedSet = new Set(allowedIds.map(String));
      const denied = requested.filter((id) => !allowedSet.has(id));
      if (denied.length) {
        return apiError(res, 403, 'folder_not_allowed',
          'This API key does not have access to one of the folders you asked for.', { denied });
      }
      allowedIds = requested;
      includeUnfiled = false;
    }

    if (!allowedIds.length && !includeUnfiled) {
      return apiError(res, 403, 'no_folders_in_scope',
        'This API key is scoped to folders that no longer exist. Update the key in Plan & billing → API.');
    }

    const queryEmbedding = await embedText(question);

    // The same search the interface uses. Filtering by organization_id is what
    // separates one customer from another; allowed_folder_ids is what keeps a
    // scoped key inside its folders.
    const { data: matches, error } = await supabase.rpc('match_document_chunks_acl', {
      query_embedding: queryEmbedding,
      match_org_id: req.org.id,
      match_count: 5,
      allowed_folder_ids: allowedIds,
      include_unfiled: includeUnfiled,
    });
    if (error) throw error;

    if (!matches || matches.length === 0) {
      return res.json({
        answer: notFoundMessage(question, forcedReplyLanguage()),
        sources: [],
        usage: usageBlock(req),
      });
    }

    const docIds = [...new Set(matches.map((m) => m.document_id))];
    const { data: docs } = await supabase.from('documents').select('id, filename').in('id', docIds);
    const docMap = Object.fromEntries((docs || []).map((d) => [d.id, d.filename]));

    const contextChunks = matches.map((m) => ({
      content: m.content,
      filename: docMap[m.document_id] || 'Unknown',
    }));

    const answer = await generateAnswer(question, contextChunks);

    // Sources as objects, not bare filenames: a client that wants to link back
    // to the document needs its id, and two folders may hold files of the same
    // name.
    const seen = new Set();
    const sources = [];
    for (const m of matches) {
      if (seen.has(m.document_id)) continue;
      seen.add(m.document_id);
      sources.push({ document_id: m.document_id, filename: docMap[m.document_id] || 'Unknown' });
    }

    res.json({ answer, sources, usage: usageBlock(req) });
  } catch (err) {
    await logEvent({
      level: 'error', scope: 'api', organizationId: req.org?.id,
      message: 'API chat request failed', detail: { error: err.message },
    });
    // The client is told the request failed, not how. The detail is in the log.
    apiError(res, 500, 'internal_error', 'The request could not be completed. Please try again.');
  }
});

/**
 * GET /v1/folders — the folders this key may ask about.
 * Lets a developer discover the ids to pass as folder_ids without guessing.
 */
router.get('/folders', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('folders')
      .select('id, name, parent_id, visibility, created_at')
      .eq('organization_id', req.org.id)
      .order('name');
    if (error) throw error;

    const { ids } = scopeFolders((data || []).map((f) => f.id), req.apiScope);
    const visible = new Set(ids.map(String));
    res.json({
      folders: (data || []).filter((f) => visible.has(String(f.id))),
      scoped: !!req.apiScope.folderIds,
      usage: usageBlock(req),
    });
  } catch (err) {
    apiError(res, 500, 'internal_error', 'The request could not be completed. Please try again.');
  }
});

/**
 * GET /v1/documents?folder_id=&limit=&offset=
 * Metadata only — never the file itself and never its text. A key that could
 * download the documents would make the read-only scope above pointless.
 */
router.get('/documents', async (req, res) => {
  try {
    const { data: folders } = await supabase
      .from('folders').select('id').eq('organization_id', req.org.id);
    const { ids: allowedIds, includeUnfiled } = scopeFolders((folders || []).map((f) => f.id), req.apiScope);

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);

    let query = supabase
      .from('documents')
      .select('id, filename, folder_id, status, size_bytes, created_at', { count: 'exact' })
      .eq('organization_id', req.org.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const wanted = String(req.query.folder_id || '').trim();
    if (wanted) {
      if (!allowedIds.map(String).includes(wanted)) {
        return apiError(res, 403, 'folder_not_allowed', 'This API key does not have access to that folder.');
      }
      query = query.eq('folder_id', wanted);
    } else if (allowedIds.length) {
      // Two conditions in one filter: inside an allowed folder, OR unfiled when
      // the key is not scoped. Written as a single `or` because chaining two
      // filters would AND them and return nothing.
      query = includeUnfiled
        ? query.or(`folder_id.in.(${allowedIds.join(',')}),folder_id.is.null`)
        : query.in('folder_id', allowedIds);
    } else if (includeUnfiled) {
      query = query.is('folder_id', null);
    } else {
      return res.json({ documents: [], total: 0, usage: usageBlock(req) });
    }

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ documents: data || [], total: count || 0, limit, offset, usage: usageBlock(req) });
  } catch (err) {
    apiError(res, 500, 'internal_error', 'The request could not be completed. Please try again.');
  }
});

/**
 * GET /v1/me — what this key is and what it may do.
 * The first call anyone makes when a key does not behave as they expected.
 */
router.get('/me', (req, res) => {
  res.json({
    organization: { id: req.org.id, name: req.org.name },
    key: {
      id: req.apiKey.id,
      name: req.apiKey.name,
      prefix: req.apiKey.key_prefix,
      created_at: req.apiKey.created_at,
      expires_at: req.apiKey.expires_at,
      scoped_to_folders: req.apiScope.folderIds,
    },
    plan: { name: req.org.plan.name, api_calls_per_month: req.org.plan.max_api_calls_per_month },
    usage: usageBlock(req),
  });
});

function usageBlock(req) {
  const { used, limit } = req.apiQuota;
  return {
    calls_this_month: used,
    calls_included: limit,
    // used is the count BEFORE this call, so the remaining figure accounts for
    // the one in progress and matches the X-RateLimit-Remaining header.
    calls_remaining: limit > 0 ? Math.max(0, limit - used - 1) : 0,
  };
}

// Anything else under /v1 is a JSON 404, not the HTML 404 page: a client
// parsing the body would otherwise fail on the HTML rather than on the status.
router.use((req, res) => {
  apiError(res, 404, 'unknown_endpoint',
    `${req.method} ${req.originalUrl} is not an endpoint. See https://botclarify.com/api.html`);
});

export default router;
