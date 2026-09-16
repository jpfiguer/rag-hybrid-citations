import { formatPageRef } from "../retrieval/search";
import type { RetrievedChunk } from "../types";

/**
 * Builds the CORPUS block handed to the model.
 *
 * The detail that matters: every fragment EXPLICITLY declares which metadata is
 * missing, instead of omitting the field.
 *
 * When a field simply isn't there, the model fills it in. Asking for an APA
 * citation over a corpus with no publication year produces invented years,
 * stated with complete confidence — "(2019)" — because the APA format expects
 * one and nothing in the prompt says that value doesn't exist. Saying
 * "YEAR=(not recorded — use 'n.d.')" costs twelve words and eliminates the
 * entire class of hallucination.
 *
 * Same principle as failing loudly: the absence of a value has to be visible,
 * not silent.
 *
 * The labels stay in the corpus language (Spanish here) because they share the
 * prompt with it — see the note in answer.ts.
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

      // The angle quotes delimit the citable text. Without a clear delimiter the
      // model blends the fragment's content with its metadata.
      return `${meta}\n«${c.content}»`;
    })
    .join("\n\n");
}
