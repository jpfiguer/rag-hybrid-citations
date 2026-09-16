import { embedOne } from "../ingest/embedder";
import type { RetrievedChunk, RpcClient } from "../types";

/**
 * Búsqueda híbrida: embebe la consulta y delega la fusión a Postgres.
 *
 * La fusión ocurre en SQL a propósito. Traer los dos rankings al proceso de
 * Node para mezclarlos acá significaría mover cientos de filas por consulta
 * para descartar casi todas; la base ya tiene ambos índices y sabe hacerlo.
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
    // pgvector acepta el literal de array; evita que el driver lo mande como JSON.
    p_query_embedding: `[${embedding.join(",")}]`,
    p_match_count: limit,
    p_section_ids: sectionIds && sectionIds.length > 0 ? sectionIds : null,
  });

  if (error) throw new Error(`hybrid_search: ${error.message}`);
  return (data ?? []) as RetrievedChunk[];
}

/** "p. 12" o "pp. 12-15". Vacío si el documento no tenía paginación. */
export function formatPageRef(
  pageStart: number | null,
  pageEnd: number | null
): string {
  if (!pageStart) return "";
  if (!pageEnd || pageEnd === pageStart) return `p. ${pageStart}`;
  return `pp. ${pageStart}-${pageEnd}`;
}
