import { PDFDocument } from 'pdf-lib';
import 'dotenv/config';

/**
 * OCR cho PDF dạng scan/ảnh bằng Gemini.
 *
 * Vì sao chọn Gemini: nó nhận thẳng file PDF nên không cần thư viện native
 * (poppler/pdftoppm) để render trang thành ảnh — giữ được deploy Render đơn giản.
 *
 * Chống quá tải (lỗi 503 "model is overloaded" rất hay gặp ở giờ cao điểm):
 *  - Backoff luỹ thừa có jitter, theo đúng khuyến nghị của Google.
 *  - Thử lần lượt nhiều model: khi model chính quá tải, model nhẹ hơn thường vẫn rảnh.
 *  - Tách PDF thành lô nhỏ và cho phép phía gọi lưu tạm từng lô, để lần thử lại
 *    chỉ làm phần còn thiếu.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Danh sách model thử lần lượt. Model đầu là chính, các model sau là dự phòng
 * khi model chính báo quá tải. Cấu hình qua GEMINI_OCR_MODELS (ngăn cách bằng dấu phẩy).
 */
const MODELS = (process.env.GEMINI_OCR_MODELS ||
  [process.env.GEMINI_OCR_MODEL || 'gemini-3.5-flash', 'gemini-3.5-flash-lite'].join(','))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

const PAGES_PER_BATCH = Number(process.env.OCR_PAGES_PER_BATCH || 5);
const MAX_OUTPUT_TOKENS = Number(process.env.OCR_MAX_OUTPUT_TOKENS || 32768);
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120000);

/** Số vòng thử lại cho mỗi lô (mỗi vòng đi qua tất cả model trong danh sách). */
const MAX_ROUNDS = Number(process.env.OCR_RETRY_ROUNDS || 5);
const BASE_DELAY_MS = Number(process.env.OCR_RETRY_BASE_MS || 1000);
const MAX_DELAY_MS = Number(process.env.OCR_RETRY_MAX_MS || 60000);

/** Số trang tối đa cho một tài liệu (chặn cứng để không bị hoá đơn bất ngờ). */
export const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 30);

export function isOcrEnabled() {
  return !!process.env.GEMINI_API_KEY;
}

export function ocrModels() {
  return [...MODELS];
}

const PROMPT = `Bạn là công cụ OCR. Hãy trích xuất TOÀN BỘ văn bản có trong tài liệu này.

QUY TẮC BẮT BUỘC:
- Chép lại nguyên văn, đúng chính tả và dấu tiếng Việt. Không dịch, không diễn giải, không tóm tắt.
- Giữ thứ tự đọc tự nhiên: tiêu đề, đoạn văn, danh sách theo đúng trình tự trên trang.
- Bảng: trình bày lại dưới dạng bảng Markdown.
- Bỏ qua các yếu tố trang trí (logo, hoa văn, số trang lặp ở chân trang).
- Nếu một vùng bị mờ hoặc không đọc được, ghi [không đọc được] tại đúng vị trí đó.
- Mỗi trang bắt đầu bằng một dòng đúng định dạng: --- Trang {số} ---
- Chỉ trả về nội dung văn bản. Không thêm lời mở đầu hay ghi chú của riêng bạn.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backoff luỹ thừa có jitter: 1s, 2s, 4s, 8s… trần 60s, dao động ±30%. */
function backoffDelay(round) {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, round), MAX_DELAY_MS);
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(500, Math.round(base + jitter));
}

/**
 * Quyết định một PDF có cần OCR hay không.
 * PDF có text thật cho ra nhiều ký tự; bản scan gần như không có gì.
 */
export function needsOcr(text, pageCount) {
  const clean = String(text || '').replace(/\s+/g, '');
  if (!pageCount || pageCount < 1) return clean.length < 100;
  // Dưới ~60 ký tự thực/trang thì gần như chắc chắn là bản scan.
  return clean.length / pageCount < 60;
}

/** Lỗi tạm thời — nên thử lại thay vì báo hỏng. */
export function isTransient(err) {
  if (!err) return false;
  if (err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503 || err.status === 504) return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  // Lỗi mạng của fetch (ECONNRESET, socket hang up…)
  if (err instanceof TypeError && /fetch|network|socket/i.test(err.message)) return true;
  return false;
}

/** Tách PDF thành các lô trang nhỏ. */
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

/** Gọi Gemini một lần cho một lô trang, với một model cụ thể. */
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
            { text: `${PROMPT}\n\nLô này bắt đầu từ trang ${fromPage} của tài liệu gốc.` },
          ],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    let msg = `Gemini trả về lỗi ${res.status}`;
    try {
      const j = JSON.parse(bodyText);
      if (j?.error?.message) msg = j.error.message;
    } catch { /* giữ thông báo mặc định */ }
    const err = new Error(msg);
    err.status = res.status;
    err.model = model;
    // Một số phản hồi có Retry-After (giây) — tôn trọng nếu có
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) err.retryAfterMs = ra * 1000;
    throw err;
  }

  const data = JSON.parse(bodyText);
  const candidate = data?.candidates?.[0];

  if (!candidate) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new Error(blocked ? `Gemini từ chối xử lý tài liệu (${blocked})` : 'Gemini không trả về nội dung');
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('');
  return { text, truncated: candidate.finishReason === 'MAX_TOKENS', model };
}

/**
 * Thử một lô trang: mỗi vòng đi qua lần lượt các model, hết vòng thì chờ rồi thử lại.
 * Lỗi không thể khắc phục (sai API key, tài liệu bị chặn…) ném ra ngay.
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
    `Gemini đang quá tải, đã thử ${MAX_ROUNDS} vòng với ${MODELS.length} model. Chi tiết: ${lastErr?.message || 'không rõ'}`
  );
  err.status = lastErr?.status;
  err.transient = true;
  throw err;
}

/**
 * OCR toàn bộ file PDF.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {number} opts.maxPages      giới hạn số trang
 * @param {Map}    opts.cached        Map('from-to' -> text) của các lô đã nhận dạng trước đó
 * @param {Function} opts.onBatch     gọi sau mỗi lô xong, để phía gọi lưu tạm
 * @param {Function} opts.onNotice    gọi khi một lần thử thất bại (để ghi nhật ký)
 *
 * Trả về { text, pages, truncated, fromCache }
 */
export async function ocrPdf(buffer, { maxPages = OCR_MAX_PAGES, cached = new Map(), onBatch, onNotice } = {}) {
  if (!isOcrEnabled()) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY nên không thể nhận dạng PDF scan');
  }

  const { batches, totalPages } = await splitPdf(buffer, PAGES_PER_BATCH);

  if (totalPages > maxPages) {
    throw new Error(
      `Tài liệu có ${totalPages} trang, vượt giới hạn ${maxPages} trang mỗi file cho việc nhận dạng. ` +
      `Vui lòng tách nhỏ tài liệu rồi tải lại.`
    );
  }

  const parts = [];
  let truncated = false;
  let fromCache = 0;

  for (const batch of batches) {
    const key = `${batch.fromPage}-${batch.toPage}`;

    // Lô này đã nhận dạng xong ở lần chạy trước — dùng lại, không gọi Gemini nữa.
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
    throw new Error('Không nhận dạng được chữ nào trong tài liệu (có thể ảnh quá mờ hoặc trang trắng)');
  }

  return { text, pages: totalPages, truncated, fromCache };
}

/** Đếm số trang của PDF mà không cần OCR — dùng để kiểm tra hạn mức trước. */
export async function countPdfPages(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return 0;
  }
}
