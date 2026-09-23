import OpenAI from 'openai';
import 'dotenv/config';
import { detectLanguage, forcedReplyLanguage } from './language.js';

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

  // Which language to answer in. BOT_REPLY_LANGUAGE pins one; left at "auto"
  // the answer mirrors the question. The retrieved documents share this prompt
  // and are often written in a different language, which pulls the model
  // towards them, so the instruction is stated explicitly rather than implied.
  const forced = forcedReplyLanguage();
  const detected = forced ? null : detectLanguage(question);

  const languageRule = forced
    ? `- Always reply in ${forced}, whatever language the question or the documents
  are written in.`
    : detected
      ? `- The question is written in ${detected.name}. Reply in ${detected.name},
  whatever language the documents are written in.`
      : `- Reply in the same language the question is written in, whatever language
  the documents are written in. If the question mixes languages, use the one
  most of it is written in.`;

  const systemPrompt = `You answer questions using a company's internal documents.

RULES:
- Answer only from the "Context" section below.
- If the context does not contain enough information, say plainly that you could
  not find it in the documents. Never guess and never invent details.
- Cite which source each fact came from, for example "According to [Source 1]...".
- Be concise and stay on the question.
${languageRule}
- Translate any passage you quote into that language, but keep names, figures,
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
