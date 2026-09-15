import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Trích xuất text thô từ buffer file, dựa theo mimetype.
 * Lưu ý: bản demo này CHƯA xử lý PDF dạng scan/ảnh (cần OCR riêng,
 * ví dụ Tesseract hoặc dịch vụ OCR ngoài - không bật ở bản free/demo).
 */
export async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  if (mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }

  throw new Error(`Định dạng file chưa hỗ trợ: ${mimeType}`);
}
