import { VoyageAIClient } from 'voyageai';
import 'dotenv/config';

// baseUrl cho phép trỏ qua proxy nội bộ hoặc gateway riêng nếu cần;
// bỏ trống thì dùng thẳng api.voyageai.com.
const voyage = new VoyageAIClient({
  apiKey: process.env.VOYAGE_API_KEY,
  ...(process.env.VOYAGE_BASE_URL ? { baseUrl: process.env.VOYAGE_BASE_URL } : {}),
});

// voyage-4-lite: rẻ nhất dòng voyage-4, dùng chung "không gian embedding"
// với voyage-4/voyage-4-large nên sau này nâng cấp model không cần re-embed lại toàn bộ.
const MODEL = 'voyage-4-lite';

/**
 * Tạo embedding cho câu hỏi của người dùng.
 * input_type: "query" giúp Voyage tối ưu vector riêng cho việc tìm kiếm,
 * khác với vector của tài liệu được lưu (input_type: "document").
 */
export async function embedText(text) {
  const res = await voyage.embed({
    input: [text],
    model: MODEL,
    inputType: 'query',
  });
  return res.data[0].embedding;
}

/**
 * Tạo embedding cho nhiều đoạn tài liệu cùng lúc khi ingest.
 */
export async function embedBatch(texts) {
  const res = await voyage.embed({
    input: texts,
    model: MODEL,
    inputType: 'document',
  });
  return res.data.map((d) => d.embedding);
}
