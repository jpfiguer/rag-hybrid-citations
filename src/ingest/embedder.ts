import OpenAI from "openai";

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  return client;
}

const MODEL = "text-embedding-3-large";
const DIMENSIONS = 1536; // Matryoshka — keeps the pgvector HNSW index within page-size limits
const BATCH_SIZE = 96;   // below the per-request token limit

/**
 * Embeds N texts in batches and returns the vectors in the same order.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const openai = getClient();
  const result: number[][] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await openai.embeddings.create({
      model: MODEL,
      input: batch,
      dimensions: DIMENSIONS,
    });
    for (let k = 0; k < res.data.length; k++) {
      result[i + k] = res.data[k].embedding;
    }
  }

  return result;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  return v;
}
