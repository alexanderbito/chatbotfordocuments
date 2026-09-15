import OpenAI from 'openai';
import 'dotenv/config';

// DeepSeek dùng API tương thích OpenAI, chỉ cần đổi baseURL + apiKey
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

/**
 * Sinh câu trả lời dựa trên các đoạn tài liệu liên quan (RAG).
 * contextChunks: mảng { content, filename } lấy từ semantic search.
 */
export async function generateAnswer(question, contextChunks) {
  const contextText = contextChunks
    .map((c, i) => `[Nguồn ${i + 1} - ${c.filename}]\n${c.content}`)
    .join('\n\n');

  const systemPrompt = `Bạn là trợ lý trả lời câu hỏi dựa trên tài liệu nội bộ của doanh nghiệp.
QUY TẮC BẮT BUỘC:
- Chỉ trả lời dựa trên nội dung trong phần "Ngữ cảnh" bên dưới.
- Nếu ngữ cảnh không đủ thông tin để trả lời, hãy nói rõ là không tìm thấy thông tin liên quan trong tài liệu, KHÔNG tự suy đoán hay bịa thông tin.
- Khi trả lời, chỉ rõ câu trả lời lấy từ nguồn nào (ví dụ: "Theo [Nguồn 1]...").
- Trả lời ngắn gọn, đúng trọng tâm, bằng tiếng Việt.`;

  const res = await deepseek.chat.completions.create({
    model: 'deepseek-chat', // model chat mặc định của DeepSeek (trỏ tới bản mới nhất)
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Ngữ cảnh:\n${contextText}\n\nCâu hỏi: ${question}`,
      },
    ],
    temperature: 0.2,
  });

  return res.choices[0].message.content;
}
