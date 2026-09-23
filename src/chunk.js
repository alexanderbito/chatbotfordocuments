/**
 * Split text into character-bounded chunks with an overlap, so meaning is not
 * cut in half at a chunk boundary.
 * Roughly 1,000 characters lands around 250-300 tokens.
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

  return chunks.filter((c) => c.length > 20); // drop empty and near-empty chunks
}
