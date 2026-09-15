/**
 * Chia văn bản thành các đoạn nhỏ (chunk) theo số ký tự, có overlap
 * để tránh cắt đứt ý nghĩa giữa hai chunk liền nhau.
 * ~1000 ký tự xấp xỉ 250-300 token tiếng Việt.
 */
export function chunkText(text, chunkSize = 1000, overlap = 150) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(start + chunkSize, cleaned.length);
    chunks.push(cleaned.slice(start, end));
    if (end === cleaned.length) break;
    start = end - overlap;
  }

  return chunks.filter((c) => c.length > 20); // bỏ chunk quá ngắn/rỗng
}
