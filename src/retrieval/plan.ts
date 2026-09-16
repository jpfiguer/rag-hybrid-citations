import OpenAI from "openai";

const MODEL = "gpt-4o-mini";
const MAX_QUERIES = 10;

/**
 * The query planner.
 *
 * The user's message and a good search query are almost never the same thing.
 * "Explain to me in detail Ostrom's text on governing common resources" is a
 * legitimate question and a terrible query: half of it is filler that pollutes
 * the matching. And a message with five sub-questions needs five searches, not
 * one that averages them.
 *
 * NOTE ON LANGUAGE: the prompt below is in Spanish because the corpus is. See
 * the note in answer.ts — prompt language follows corpus language.
 */
const SYSTEM = `Eres un planificador de consultas para un motor de búsqueda RAG.

Recibes un fragmento reciente de conversación. Devuelve las consultas de búsqueda (1 a 10) que, ejecutadas en paralelo, recuperen los fragmentos necesarios para responder al ÚLTIMO mensaje del usuario.

Cuántas consultas generar:

1. **Follow-up corto** ("dame ejemplos", "profundiza", "y entonces"): UNA consulta que integre el concepto y la fuente del turno anterior, de modo que se entienda por sí sola sin la conversación.
2. **Pregunta única autocontenida**: UNA consulta. Elimina el relleno conversacional ("explícame", "dame", "a ver", "el texto de", "me podrías decir") y deja solo los términos sustantivos.
3. **Múltiples preguntas o sub-temas** (lista numerada, comparación entre dos fuentes, guía con varios puntos): UNA consulta POR sub-tema, corta y focalizada, de 5 a 15 palabras.
4. **Pedido de cobertura amplia** ("resume cada fuente", "todo el material"): si el input incluye el bloque de documentos disponibles, genera UNA consulta POR documento usando ÚNICAMENTE palabras del título o el autor.

Regla crítica de vocabulario — el lado sparse es BM25 y trata los términos como AND:

NO agregues palabras genéricas de andamiaje ("ideas principales", "resumen", "conceptos", "explicación", "análisis"). Aparecen en casi cualquier documento y, al sumarse como término obligatorio, hacen caer el matching en vez de mejorarlo. Si el documento se titula "Modelos de democracia" de Lijphart, la consulta es "Lijphart modelos democracia" — no "ideas principales de Lijphart sobre modelos de democracia".

Metainstrucciones — descártalas por completo:

Frases sobre CÓMO querer la respuesta ("usa este formato", "que sea extenso", "responde en bullets", "sigue esta rúbrica", "para mi prueba") NO son temas a buscar. Concéntrate solo en los conceptos sustantivos. Confundir una metainstrucción con un tema es la causa más común de que el motor no encuentre nada y responda que el material no existe.

Nombres propios en follow-ups:

Cuando el último mensaje menciona un autor o una fuente específica ("¿y Holmes?"), ese nombre DEBE aparecer literal en la consulta. No lo elimines como relleno.

Otras reglas:
- NO inventes autores, obras ni conceptos que no aparezcan en la conversación ni en la lista de documentos.
- NO respondas la pregunta. NO agregues explicaciones.
- Máximo ~20 palabras por consulta.

Devuelve SIEMPRE JSON con esta forma exacta:
{"queries": ["consulta 1", "consulta 2", ...]}

Sin texto fuera del JSON. Mínimo 1, máximo 10 consultas.`;

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export type Msg = { role: "user" | "assistant" | "system"; content: string };
export type CorpusDoc = { title: string; author: string | null };

function cleanQuery(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const trimmed = q.trim().replace(/^["'«»\s]+|["'«»\s]+$/g, "");
  // Fewer than 3 useful characters isn't a query, it's parsing noise.
  if (trimmed.replace(/[\s.,;:!¡¿?"'()\-]+/g, "").length < 3) return null;
  return trimmed.slice(0, 400);
}

/**
 * Plans 1..N queries from the most recent turns.
 *
 * `corpusDocs` is the list of documents actually available. Without that anchor
 * the planner hallucinates sources that are plausible for the domain — authors
 * that "ought to" be there — and the engine then searches for material that was
 * never loaded. It's a hallucination that happens in the planning model rather
 * than the answering one, which is why it escapes evaluations that only look at
 * the final answer.
 *
 * Never throws: on any failure it returns the user's message as the single
 * query. A broken planner should degrade search quality, not take the answer
 * down with it.
 */
export async function planQueries(
  messages: Msg[],
  corpusDocs: CorpusDoc[] = []
): Promise<string[]> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return [];

  const trimmed = lastUser.content.trim();
  const priorTurns = messages.filter((m) => m.role !== "system");

  // Shortcut: a bare term on the first turn is already the query. Asking the
  // model to "plan" over a single word adds latency and risk for nothing.
  const looksLikeBareTerm = trimmed.split(/\s+/).length <= 3 && !trimmed.includes("?");
  if (priorTurns.length <= 1 && looksLikeBareTerm) return [trimmed];

  const transcript = messages
    .slice(-8)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const docsBlock =
    corpusDocs.length > 0
      ? `\n\nDocumentos disponibles en esta colección:\n` +
        corpusDocs
          .map((d) => `- ${d.title}${d.author ? ` (${d.author})` : ""}`)
          .join("\n")
      : "";

  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Conversación:\n${transcript}${docsBlock}\n\nDevuelve el JSON:`,
        },
      ],
    });

    const raw = res.choices[0]?.message?.content;
    if (!raw) return [lastUser.content];

    const parsed = JSON.parse(raw) as { queries?: unknown };
    const arr = Array.isArray(parsed.queries) ? parsed.queries : [];
    const cleaned = arr.map(cleanQuery).filter((q): q is string => q !== null);
    if (cleaned.length === 0) return [lastUser.content];

    const unique = [...new Set(cleaned)].slice(0, MAX_QUERIES);
    return unique;
  } catch {
    return [lastUser.content];
  }
}

/**
 * Detects broad-coverage requests, which need more retrieved material so that no
 * source gets omitted. Deliberately a cheap heuristic: spending a model call to
 * decide how much to retrieve, before retrieving, doubles the turn's latency.
 */
export function wantsBroadCoverage(message: string): boolean {
  return /\b(resumen|res[uú]men|resume).{0,40}(cada|todos|todas|completo|completa|exhaustivo|extenso|de todo)\b|\bde cada (autor|fuente|texto|documento)\b|\btodo el material\b/i.test(
    message
  );
}
