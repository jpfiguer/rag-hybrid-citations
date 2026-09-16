/**
 * A retrieved chunk, as returned by `hybrid_search`.
 *
 * The provenance fields — `document_title`, `author`, `page_start`, `page_end`,
 * `section_path` — travel all the way to the prompt. They are not decorative
 * metadata: they are what makes a citation checkable.
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
  /** Reciprocal Rank Fusion score. Higher is better. */
  rrf_score: number;
};

/**
 * The minimal client this package needs. `@supabase/supabase-js` satisfies it,
 * but it is declared this way on purpose: anything able to call the Postgres
 * function will do, and the package is not married to a specific SDK.
 */
export type RpcClient = {
  rpc(
    fn: string,
    params: Record<string, unknown>
  ): Promise<{ data: unknown; error: { message: string } | null }>;
};
