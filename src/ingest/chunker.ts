import type { OcrPage } from "./ocr";

export type Chunk = {
  content: string;
  pageStart: number;
  pageEnd: number;
  sectionPath: string | null;
  tokenCountApprox: number;
};

type ChunkOpts = {
  targetChars: number;
  overlapChars: number;
  minChars: number;
};

const DEFAULT_OPTS: ChunkOpts = {
  targetChars: 2000,  // ≈ 500 tokens en ES
  overlapChars: 300,  // ≈ 75 tokens
  minChars: 200,
};

/**
 * Concatena las páginas en un string único manteniendo un mapa offset→página,
 * luego parte en chunks respetando límites de párrafo cuando es posible.
 * Detecta headers markdown para construir un sectionPath ("Libro I > Cap. 3").
 */
export function chunkPages(pages: OcrPage[], opts: Partial<ChunkOpts> = {}): Chunk[] {
  const o = { ...DEFAULT_OPTS, ...opts };

  // 1) Construir texto combinado + mapa de página
  const pageStarts: { offset: number; page: number }[] = [];
  let text = "";
  for (const p of pages) {
    pageStarts.push({ offset: text.length, page: p.pageNumber });
    text += p.markdown + "\n\n";
  }
  if (text.length === 0) return [];

  // Binary search: qué página contiene un offset dado
  const pageAt = (offset: number): number => {
    let lo = 0;
    let hi = pageStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (pageStarts[mid].offset <= offset) lo = mid;
      else hi = mid - 1;
    }
    return pageStarts[lo].page;
  };

  // 2) Precomputar posiciones de headers markdown
  const headerRegex = /^(#{1,6})\s+(.+)$/gm;
  const headers: { offset: number; level: number; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRegex.exec(text))) {
    headers.push({ offset: m.index, level: m[1].length, title: m[2].trim() });
  }
  const sectionPathAt = (offset: number): string | null => {
    const stack: string[] = [];
    for (const h of headers) {
      if (h.offset > offset) break;
      // Recortar stack al nivel del header actual
      while (stack.length >= h.level) stack.pop();
      stack.push(h.title);
    }
    return stack.length > 0 ? stack.join(" > ") : null;
  };

  // 3) Chunking con break-points preferidos
  const chunks: Chunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const windowEnd = Math.min(cursor + o.targetChars, text.length);
    let actualEnd = windowEnd;

    if (windowEnd < text.length) {
      // Preferir doble salto (párrafo)
      const paraIdx = text.lastIndexOf("\n\n", windowEnd);
      if (paraIdx > cursor + o.targetChars * 0.5) {
        actualEnd = paraIdx;
      } else {
        // Salto simple
        const lineIdx = text.lastIndexOf("\n", windowEnd);
        if (lineIdx > cursor + o.targetChars * 0.6) {
          actualEnd = lineIdx;
        } else {
          // Final de oración
          const dotIdx = text.lastIndexOf(". ", windowEnd);
          if (dotIdx > cursor + o.targetChars * 0.7) actualEnd = dotIdx + 1;
        }
      }
    }

    const content = text.slice(cursor, actualEnd).trim();
    if (content.length >= o.minChars) {
      chunks.push({
        content,
        pageStart: pageAt(cursor),
        pageEnd: pageAt(Math.max(cursor, actualEnd - 1)),
        sectionPath: sectionPathAt(cursor),
        tokenCountApprox: Math.ceil(content.length / 4),
      });
    }

    if (actualEnd >= text.length) break;
    cursor = Math.max(cursor + o.minChars, actualEnd - o.overlapChars);
  }

  return chunks;
}
