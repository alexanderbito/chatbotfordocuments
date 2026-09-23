import { PDFDocument } from 'pdf-lib';
import 'dotenv/config';

/**
 * OCR for scanned/image-only PDFs using Gemini.
 *
 * Why Gemini: it accepts a PDF file directly, so we do not need a native library
 * (poppler/pdftoppm) to render pages into images — which keeps the Render deploy simple.
 *
 * Handling overload (the 503 "model is overloaded" error is very common at peak hours):
 *  - Exponential backoff with jitter, exactly as Google recommends.
 *  - Try several models in turn: when the primary model is overloaded, a lighter one is usually free.
 *  - Split the PDF into small batches and let the caller checkpoint each batch, so a retry
 *    only has to redo what is still missing.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * The models to try, in order. The first is the primary; the rest are fallbacks used
 * when the primary reports an overload. Configured via GEMINI_OCR_MODELS (comma-separated).
 */
const MODELS = (process.env.GEMINI_OCR_MODELS ||
  [process.env.GEMINI_OCR_MODEL || 'gemini-3.5-flash', 'gemini-3.5-flash-lite'].join(','))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const PAGES_PER_BATCH = Number(process.env.OCR_PAGES_PER_BATCH || 5);
const MAX_OUTPUT_TOKENS = Number(process.env.OCR_MAX_OUTPUT_TOKENS || 32768);
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120000);

/** How many retry rounds each batch gets (one round tries every model in the list). */
const MAX_ROUNDS = Number(process.env.OCR_RETRY_ROUNDS || 5);
const BASE_DELAY_MS = Number(process.env.OCR_RETRY_BASE_MS || 1000);
const MAX_DELAY_MS = Number(process.env.OCR_RETRY_MAX_MS || 60000);

/** Maximum pages per document (a hard cap so we never get a surprise bill). */
export const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 30);

export function isOcrEnabled() {
  return !!process.env.GEMINI_API_KEY;
}

export function ocrModels() {
  return [...MODELS];
}

const PROMPT = `You are an OCR tool. Extract ALL of the text contained in this document.

RULES YOU MUST FOLLOW:
- Transcribe verbatim, preserving exact spelling, accents and diacritics. Do not translate, paraphrase or summarise.
- Keep the natural reading order: headings, paragraphs and lists in the order they appear on the page.
- Tables: reproduce them as Markdown tables.
- Skip decorative elements (logos, ornaments, repeated page numbers in footers).
- If a region is blurred or unreadable, write [unreadable] at that exact position.
- Start every page with a line in exactly this format: --- Page {number} ---
- Return the text content only. Do not add any preamble or notes of your own.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter: 1s, 2s, 4s, 8s… capped at 60s, varying by ±30%. */
function backoffDelay(round) {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, round), MAX_DELAY_MS);
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

/**
 * Decide whether a PDF needs OCR.
 * A PDF with real text yields plenty of characters; a scan yields almost none.
 */
export function needsOcr(text, pageCount) {
  const clean = String(text || '').replace(/\s+/g, '');
  if (!pageCount || pageCount < 1) return clean.length < 100;
  // Below ~60 real characters per page it is almost certainly a scan.
  return clean.length / pageCount < 60;
}

/** Transient errors — worth retrying rather than reporting as a failure. */
export function isTransient(err) {
  if (!err) return false;
  if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504) return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  // fetch network errors (ECONNRESET, socket hang up…)
  if (err instanceof TypeError && /fetch|network|socket/i.test(err.message)) return true;
  return false;
}

/** Split a PDF into small batches of pages. */
async function splitPdf(buffer, pagesPerBatch) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  const batches = [];

  for (let start = 0; start < total; start += pagesPerBatch) {
    const end = Math.min(start + pagesPerBatch, total);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: end - start }, (_, i) => start + i));
    pages.forEach((p) => out.addPage(p));
    batches.push({
      buffer: Buffer.from(await out.save()),
      fromPage: start + 1,
      toPage: end,
    });
  }
  return { batches, totalPages: total };
}

/** Make a single Gemini call for one batch of pages, using a specific model. */
async function callGemini(pdfBuffer, fromPage, model) {
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': process.env.GEMINI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'application/pdf', data: pdfBuffer.toString('base64') } },
            { text: `${PROMPT}\n\nThis batch starts at page ${fromPage} of the original document.` },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    let msg = `Gemini returned error ${res.status}`;
    try {
      const j = JSON.parse(bodyText);
      if (j?.error?.message) msg = j.error.message;
    } catch { /* keep the default message */ }
    const err = new Error(msg);
    err.status = res.status;
    err.model = model;
    // Some responses carry Retry-After (in seconds) — honour it when present
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) err.retryAfterMs = ra * 1000;
    throw err;
  }

  const data = JSON.parse(bodyText);
  const candidate = data?.candidates?.[0];

  if (!candidate) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new Error(blocked ? `Gemini refused to process the document (${blocked})` : 'Gemini returned no content');
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('');
  return { text, truncated: candidate.finishReason === 'MAX_TOKENS', model };
}

/**
 * Process one batch of pages: each round tries the models in turn, then waits and retries.
 * Unrecoverable errors (bad API key, blocked document…) are thrown immediately.
 */
async function callWithRetry(pdfBuffer, fromPage, onNotice) {
  let lastErr;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    for (const model of MODELS) {
      try {
        return await callGemini(pdfBuffer, fromPage, model);
      } catch (err) {
        if (!isTransient(err)) throw err;
        lastErr = err;
        if (onNotice) onNotice({ model, round, message: err.message });
      }
    }

    if (round < MAX_ROUNDS - 1) {
      await sleep(lastErr?.retryAfterMs || backoffDelay(round));
    }
  }

  const err = new Error(
    `Gemini is overloaded; tried ${MAX_ROUNDS} rounds across ${MODELS.length} models. Details: ${lastErr?.message || 'unknown'}`
  );
  err.status = lastErr?.status;
  err.transient = true;
  throw err;
}

/**
 * Run OCR over an entire PDF file.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {number} opts.maxPages      page limit
 * @param {Map}    opts.cached        Map('from-to' -> text) of batches recognised on a previous run
 * @param {Function} opts.onBatch     called after each batch finishes, so the caller can checkpoint it
 * @param {Function} opts.onNotice    called when an attempt fails (for logging)
 *
 * Returns { text, pages, truncated, fromCache }
 */
export async function ocrPdf(buffer, { maxPages = OCR_MAX_PAGES, cached = new Map(), onBatch, onNotice } = {}) {
  if (!isOcrEnabled()) {
    throw new Error('GEMINI_API_KEY is not configured, so scanned PDFs cannot be recognised');
  }

  const { batches, totalPages } = await splitPdf(buffer, PAGES_PER_BATCH);

  if (totalPages > maxPages) {
    throw new Error(
      `This document has ${totalPages} pages, over the ${maxPages}-page-per-file limit for recognition. ` +
      `Please split the document into smaller files and upload it again.`
    );
  }

  const parts = [];
  let truncated = false;
  let fromCache = 0;

  for (const batch of batches) {
    const key = `${batch.fromPage}-${batch.toPage}`;

    // This batch was already recognised on an earlier run — reuse it instead of calling Gemini again.
    if (cached.has(key)) {
      parts.push(cached.get(key));
      fromCache++;
      continue;
    }

    const out = await callWithRetry(batch.buffer, batch.fromPage, onNotice);
    if (out.truncated) truncated = true;

    const text = (out.text || '').trim();
    if (text) parts.push(text);

    if (onBatch) {
      await onBatch({ fromPage: batch.fromPage, toPage: batch.toPage, text, model: out.model });
    }
  }

  const text = parts.join('\n\n');
  if (!text.trim()) {
    throw new Error('No text could be recognised in this document (the scan may be too blurry, or the pages blank)');
  }

  return { text, pages: totalPages, truncated, fromCache };
}

/** Count a PDF's pages without running OCR — used to check quotas up front. */
export async function countPdfPages(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}
