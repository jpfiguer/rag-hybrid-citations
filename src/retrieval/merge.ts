import type { RetrievedChunk } from "../types";

/**
 * Fusiona los resultados de N consultas paralelas en una sola lista.
 *
 * Un chunk que aparece en varias consultas conserva el MAYOR rrf_score
 * observado, no la suma. Sumar premiaría a los chunks genéricos —los que
 * matchean con cualquier cosa— y son justamente los que menos aportan a una
 * respuesta con citas. Con el máximo, lo que gana es la mejor evidencia para
 * alguna sub-pregunta concreta.
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
 * Cuántos chunks pedir por consulta y cuántos conservar al final.
 *
 * Con una sola consulta conviene traer más de cada una; con muchas, menos por
 * consulta pero un tope final más alto. Sin este ajuste, un "resume cada
 * fuente" sobre diez documentos o bien recupera poco de cada uno, o bien le
 * entrega al modelo un corpus tan grande que diluye la atención y empieza a
 * omitir autores.
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
