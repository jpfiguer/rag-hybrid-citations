/**
 * Un chunk recuperado, tal como lo devuelve `hybrid_search`.
 *
 * Los campos de procedencia —`document_title`, `author`, `page_start`,
 * `page_end`, `section_path`— viajan hasta el prompt. No son metadata
 * decorativa: son lo que permite que la cita sea comprobable.
 */
export type RetrievedChunk = {
  chunk_id: string;
  document_id: string;
  document_title: string;
  author: string | null;
  page_start: number | null;
  page_end: number | null;
  section_path: string | null;
  content: string;
  section_id: string | null;
  /** Puntaje de Reciprocal Rank Fusion. Mayor es mejor. */
  rrf_score: number;
};

/**
 * Cliente mínimo que este paquete necesita. Lo cumple `@supabase/supabase-js`,
 * pero está declarado así a propósito: cualquier cosa capaz de llamar a la
 * función de Postgres sirve, y el paquete no se casa con un SDK.
 */
export type RpcClient = {
  rpc(
    fn: string,
    params: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }>;
};
