import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

/**
 * Extract raw text from a file buffer.
 * Returns { text, pages } — pages is only meaningful for PDFs (0 for other formats).
 *
 * A scanned or image-based PDF produces empty text here; the caller uses needsOcr()
 * in src/ocr.js to decide whether to fall back to character recognition.
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

  throw new Error(`Unsupported file type: ${mimeType}`);
}
