import { VoyageAIClient } from 'voyageai';
import 'dotenv/config';

// baseUrl allows routing through an internal proxy or private gateway;
// left unset it talks to api.voyageai.com directly.
const voyage = new VoyageAIClient({
  apiKey: process.env.VOYAGE_API_KEY,
  ...(process.env.VOYAGE_BASE_URL ? { baseUrl: process.env.VOYAGE_BASE_URL } : {}),
});

// voyage-4-lite is the cheapest of the voyage-4 family and shares an embedding
// space with voyage-4 and voyage-4-large, so a later upgrade needs no re-embed.
const MODEL = 'voyage-4-lite';

/**
 * Embed a user's question.
 * input_type "query" tells Voyage to optimize the vector for retrieval, which
 * differs from the stored document vectors (input_type "document").
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
 * Embed a batch of document chunks during ingestion.
 */
export async function embedBatch(texts) {
  const res = await voyage.embed({
    input: texts,
    model: MODEL,
    inputType: 'document',
  });
  return res.data.map((d) => d.embedding);
}
