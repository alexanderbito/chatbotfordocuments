import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Trích xuất text thô từ buffer file.
 * Trả về { text, pages } — pages chỉ có giá trị với PDF (0 với định dạng khác).
 *
 * PDF dạng scan/ảnh sẽ cho text rỗng ở đây; phía gọi dùng needsOcr() trong
 * src/ocr.js để quyết định có chuyển sang nhận dạng ký tự hay không.
 */
export async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const data = await pdfParse(buffer);
    return { text: data.text || '', pages: data.numpages || 0 };
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: value || '', pages: 0 };
  }

  if (mimeType === 'text/plain') {
    return { text: buffer.toString('utf-8'), pages: 0 };
  }

  throw new Error(`Định dạng file chưa hỗ trợ: ${mimeType}`);
}
