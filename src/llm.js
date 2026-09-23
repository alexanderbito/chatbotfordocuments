import OpenAI from 'openai';
import 'dotenv/config';

// DeepSeek exposes an OpenAI-compatible API; only baseURL and apiKey differ
const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: process.env.DEEPSEEK_BASE_URL,
});

/**
 * Answer a question from the retrieved document chunks (RAG).
 * contextChunks: an array of { content, filename } from the semantic search.
 */
export async function generateAnswer(question, contextChunks) {
  const contextText = contextChunks
    .map((c, i) => `[Source ${i + 1} - ${c.filename}]\n${c.content}`)
    .join('\n\n');

  // Source documents are often written in another language than the product UI,
  // so the reply language is pinned here rather than left to the model to guess.
  const replyLanguage = process.env.BOT_REPLY_LANGUAGE || 'English';

  const systemPrompt = `You answer questions using a company's internal documents.

RULES:
- Answer only from the "Context" section below.
- If the context does not contain enough information, say plainly that you could
  not find it in the documents. Never guess and never invent details.
- Cite which source each fact came from, for example "According to [Source 1]...".
- Be concise and stay on the question.
- Always reply in ${replyLanguage}, even when the documents are written in
  another language. Translate any passage you quote, but keep names, figures,
  dates and identifiers exactly as they appear in the source.`;

  const res = await deepseek.chat.completions.create({
    model: 'deepseek-chat', // DeepSeek's default chat model, tracking their latest release
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Context:\n${contextText}\n\nQuestion: ${question}`,
      },
    ],
    temperature: 0.2,
  });

  return res.choices[0].message.content;
}
