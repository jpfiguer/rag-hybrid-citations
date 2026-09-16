import { embedOne } from "../ingest/embedder";
import type { RetrievedChunk, RpcClient } from "../types";

/**
 * Hybrid search: embeds the query and delegates the fusion to Postgres.
 *
 * Fusion happens in SQL on purpose. Pulling both rankings into the Node process
 * to mix them here would mean moving hundreds of rows per query only to discard
 * almost all of them; the database already has both indexes and knows how.
 */
export async function retrieve(
  client: RpcClient,
  collectionId: string,
  query: string,
  opts: { limit?: number; sectionIds?: string[] } = {}
): Promise<RetrievedChunk[]> {
  const { limit = 8, sectionIds } = opts;

  const embedding = await embedOne(query);

  const { data, error } = await client.rpc("hybrid_search", {
    p_collection_id: collectionId,
    p_query_text: query,
    // pgvector accepts the array literal; this stops the driver sending it as JSON.
    p_query_embedding: `[${embedding.join(",")}]`,
    p_match_count: limit,
    p_section_ids: sectionIds && sectionIds.length > 0 ? sectionIds : null,
  });

  if (error) throw new Error(`hybrid_search: ${error.message}`);
  return (data ?? []) as RetrievedChunk[];
}

/** "p. 12" or "pp. 12-15". Empty when the document had no pagination. */
export function formatPageRef(
  pageStart: number | null,
  pageEnd: number | null
): string {
  if (!pageStart) return "";
  if (!pageEnd || pageEnd === pageStart) return `p. ${pageStart}`;
  return `pp. ${pageStart}-${pageEnd}`;
}
