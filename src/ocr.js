import { PDFDocument } from 'pdf-lib';
import 'dotenv/config';

/**
 * OCR cho PDF dạng scan/ảnh bằng Gemini.
 *
 * Vì sao chọn Gemini: nó nhận thẳng file PDF nên không cần thư viện native
 * (poppler/pdftoppm) để render trang thành ảnh — giữ được deploy Render đơn giản.
 *
 * Cách làm: tách PDF thành từng lô nhỏ vài trang (pdf-lib, thuần JS) rồi gửi
 * tuần tự. Lô nhỏ tránh hai vấn đề: request quá lớn và câu trả lời bị cắt do
 * giới hạn token đầu ra.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = process.env.GEMINI_OCR_MODEL || 'gemini-3.5-flash';
const PAGES_PER_BATCH = Number(process.env.OCR_PAGES_PER_BATCH || 5);
const MAX_OUTPUT_TOKENS = Number(process.env.OCR_MAX_OUTPUT_TOKENS || 32768);
const REQUEST_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 120000);

/** Số trang tối đa cho một tài liệu (chặn cứng để không bị hoá đơn bất ngờ). */
export const OCR_MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 30);

export function isOcrEnabled() {
  return !!process.env.GEMINI_API_KEY;
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

/** Tách PDF thành các lô trang nhỏ, trả về mảng Buffer. */
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

/** Gọi Gemini một lần cho một lô trang. */
async function callGemini(pdfBuffer, fromPage) {
  const res = await fetch(`${API_BASE}/${MODEL}:generateContent`, {
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
      generationConfig: {
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    let msg = `Gemini trả về lỗi ${res.status}`;
    try {
      const j = JSON.parse(bodyText);
      if (j?.error?.message) msg = `Gemini: ${j.error.message}`;
    } catch { /* giữ thông báo mặc định */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const data = JSON.parse(bodyText);
  const candidate = data?.candidates?.[0];

  if (!candidate) {
    const blocked = data?.promptFeedback?.blockReason;
    throw new Error(blocked ? `Gemini từ chối xử lý tài liệu (${blocked})` : 'Gemini không trả về nội dung');
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('');
  return { text, truncated: candidate.finishReason === 'MAX_TOKENS' };
}

/** Gọi lại khi gặp lỗi tạm thời (429 quá tải, 5xx). */
async function callWithRetry(pdfBuffer, fromPage, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callGemini(pdfBuffer, fromPage);
    } catch (err) {
      lastErr = err;
      const retriable = err.status === 429 || (err.status >= 500 && err.status < 600) || err.name === 'TimeoutError';
      if (!retriable || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

/**
 * OCR toàn bộ file PDF.
 * Trả về { text, pages, truncated } — pages là số trang đã thực sự OCR.
 */
export async function ocrPdf(buffer, { maxPages = OCR_MAX_PAGES } = {}) {
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

  for (const batch of batches) {
    const out = await callWithRetry(batch.buffer, batch.fromPage);
    if (out.truncated) truncated = true;
    if (out.text.trim()) parts.push(out.text.trim());
  }

  const text = parts.join('\n\n');
  if (!text.trim()) {
    throw new Error('Không nhận dạng được chữ nào trong tài liệu (có thể ảnh quá mờ hoặc trang trắng)');
  }

  return { text, pages: totalPages, truncated };
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
