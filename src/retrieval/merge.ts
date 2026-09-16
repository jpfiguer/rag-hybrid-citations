import type { RetrievedChunk } from "../types";

/**
 * Merges the results of N parallel queries into a single list.
 *
 * A chunk appearing in several queries keeps the HIGHEST rrf_score observed, not
 * the sum. Summing would reward generic chunks — the ones that match anything —
 * and those are precisely the ones that contribute least to a cited answer. With
 * the maximum, what wins is the best evidence for some specific sub-question.
 */
export function mergeResults(
  results: RetrievedChunk[][],
  limit: number
): RetrievedChunk[] {
  const byId = new Map<string, RetrievedChunk>();

  for (const arr of results) {
    for (const c of arr) {
      const prev = byId.get(c.chunk_id);
      if (!prev || c.rrf_score > prev.rrf_score) byId.set(c.chunk_id, c);
    }
  }

  return [...byId.values()]
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, limit);
}

/**
 * How many chunks to request per query, and how many to keep overall.
 *
 * With a single query it pays to pull more from it; with many, fewer per query
 * but a higher final cap. Without this adjustment, a "summarize every source"
 * over ten documents either retrieves too little from each, or hands the model a
 * corpus so large that it dilutes attention and starts omitting sources.
 */
export function planLimits(
  queryCount: number,
  broadCoverage: boolean
): { perQuery: number; final: number } {
  const perQuery =
    queryCount === 1 ? (broadCoverage ? 12 : 8) : broadCoverage ? 8 : 5;

  const final = broadCoverage
    ? Math.min(20 + queryCount * 2, 40)
    : Math.min(8 + (queryCount - 1) * 3, 20);

  return { perQuery, final };
}
