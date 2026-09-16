import { formatPageRef } from "../retrieval/search";
import type { RetrievedChunk } from "../types";

/**
 * Arma el bloque CORPUS que se le entrega al modelo.
 *
 * El detalle que importa: cada fragmento declara EXPLÍCITAMENTE qué metadata
 * falta, en vez de omitir el campo.
 *
 * Cuando un campo simplemente no aparece, el modelo lo rellena. Pedirle una
 * cita en APA sobre un corpus sin año de publicación produce años inventados
 * con total aplomo —"(2019)"— porque el formato APA los espera y nada en el
 * prompt dice que ese dato no existe. Decir "AÑO=(no registrado — usá «s.f.»)"
 * cuesta doce palabras y elimina la categoría entera de alucinación.
 *
 * Es el mismo principio que un fallo ruidoso: la ausencia de un dato tiene que
 * ser visible, no silenciosa.
 */
export function buildCorpusBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const pageRef = formatPageRef(c.page_start, c.page_end);
      const meta = [
        `[${i + 1}]`,
        `DOC="${c.document_title}"`,
        `AUTOR=${
          c.author
            ? `"${c.author}"`
            : "(no registrado — inferí del título o usá el título como autor)"
        }`,
        pageRef ? `PÁGINA=${pageRef}` : null,
        "AÑO=(no registrado — usá «s.f.» en APA)",
        "EDITORIAL=(no registrada — omití en APA)",
        c.section_path ? `SECCIÓN="${c.section_path}"` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      // Las comillas angulares delimitan el texto citable. Sin un delimitador
      // claro, el modelo mezcla el contenido del fragmento con su metadata.
      return `${meta}\n«${c.content}»`;
    })
    .join("\n\n");
}
