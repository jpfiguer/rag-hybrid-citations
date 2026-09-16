import OpenAI from "openai";
import { buildCorpusBlock } from "./corpus-block";
import type { Msg } from "../retrieval/plan";
import type { RetrievedChunk } from "../types";

const MODEL = "gpt-4o";
const TEMPERATURE = 0.2;

/**
 * RRF score below which we treat the corpus as having no material.
 *
 * It exists because hybrid search ALWAYS returns something: however badly they
 * match, the top k chunks come back anyway. Without a floor, a question about an
 * absent topic retrieves the least-bad fragments and the model, obediently,
 * builds an answer citing them. The result is worse than "I don't know": it's an
 * answer with real citations to passages that don't apply.
 *
 * The value is calibrated against your own corpus. 0.005 is where, in the system
 * this code came from, false positives started slipping through. Recalibrate by
 * running known-absent questions and reading the top scores they return.
 */
export const MIN_RRF_SCORE = 0.005;

export const REFUSAL =
  "No encuentro este tema en el material de esta colección. Si crees que debería estar, revisa que la fuente correspondiente esté cargada.";

/**
 * The prompt.
 *
 * The distinction holding it together: separating what the model ASSERTS about
 * the sources from what the model CONTRIBUTES itself.
 *
 * A RAG that forbids everything outside the corpus produces answers that are
 * useless as study material — it can't give an example, or an analogy, or
 * restate something in plain words. One that allows it without marking ends up
 * attributing to the author examples the author never gave, which is a harder
 * hallucination to catch than a false fact: it sounds reasonable and the
 * citation attached to it is genuine.
 *
 * The rule resolves both: facts carry a mandatory citation, illustrations carry
 * a mandatory marker, and neither can pass for the other.
 *
 * NOTE ON LANGUAGE: the prompt is in Spanish because the corpus it was written
 * for is in Spanish, and the same goes for the `plainto_tsquery('spanish', …)`
 * configuration in the SQL. Prompt language should follow corpus language —
 * translating this to English while retrieving Spanish passages costs
 * instruction-following accuracy for nothing.
 */
const SYSTEM_PROMPT = `Eres un asistente que responde ÚNICAMENTE sobre el CORPUS que aparece abajo (fragmentos recuperados del material de la colección).

## Distinción clave — hechos vs. ilustraciones

- **AFIRMACIONES sobre qué dice una fuente** (conceptos, definiciones, requisitos, posturas, datos): DEBEN salir del CORPUS y llevar cita [N]. NO inventes atribuciones.
- **ILUSTRACIONES PROPIAS** (ejemplos cotidianos, analogías, reformulaciones en palabras simples, casos hipotéticos): SÍ las puedes generar, **siempre marcadas** con frases como "un ejemplo sería…", "podemos ilustrarlo con…", "dicho en palabras simples…". Nunca las atribuyas a una fuente ni al CORPUS.

## Antes de rechazar — separa CONCEPTOS de METAINSTRUCCIONES

El mensaje puede mezclar:
- **CONCEPTOS** (de qué se pregunta): son lo que evalúas contra el CORPUS.
- **METAINSTRUCCIONES** (cómo se quiere la respuesta): "usa este formato", "que sea más extenso", "responde en bullets", "máximo N palabras". NO son conceptos y NUNCA se buscan en el CORPUS, pero SÍ debes obedecerlas para dar forma a la respuesta.

**Si el mensaje contiene VARIAS preguntas**: trátalas como una sola consulta compuesta. Si AL MENOS UNA tiene material, RESPONDE; indica brevemente al final cuál no lo tiene, en vez de rechazar todo.

**Pedidos de profundización** ("desarrolla", "amplía", "explica más") son follow-ups legítimos del tema previo, NO preguntas nuevas. Reusa el CORPUS recuperado. NUNCA rechaces un "desarrolla más" sobre algo que ya respondiste.

## Cómo responder

1. **Saludos**: breve y cordial, sin citas ni rechazo.
2. **Pedidos generales** ("hazme un resumen"): resume los fragmentos con [N] en cada afirmación.
3. **Preguntas cuya respuesta está en el CORPUS**: [N] obligatoria en cada afirmación sustantiva.
4. **Preguntas sin material en el CORPUS**: dilo explícitamente. No completes con conocimiento general.

Cierra con un pie de fuentes consultadas, salvo en saludos. Párrafos cortos; viñetas para listas.`;

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export type AnswerResult =
  | { kind: "refusal"; text: string }
  | { kind: "answer"; stream: AsyncIterable<string>; cited: RetrievedChunk[] };

/**
 * Decides whether there is enough material and, if so, answers with citations.
 *
 * Returns the refusal as a normal case rather than an error: the corpus not
 * holding the answer is a legitimate outcome of the system, not a failure.
 */
export async function answer(
  messages: Msg[],
  chunks: RetrievedChunk[],
  opts: { minScore?: number; extraInstructions?: string } = {}
): Promise<AnswerResult> {
  const minScore = opts.minScore ?? MIN_RRF_SCORE;
  const usable = chunks.filter((c) => c.rrf_score >= minScore);

  if (usable.length === 0) {
    return { kind: "refusal", text: REFUSAL };
  }

  const systemMessage = {
    role: "system" as const,
    content:
      SYSTEM_PROMPT +
      (opts.extraInstructions ? `\n\n${opts.extraInstructions}` : "") +
      `\n\n=== CORPUS ===\n${buildCorpusBlock(usable)}\n=== FIN CORPUS ===`,
  };

  const res = await getClient().chat.completions.create({
    model: MODEL,
    temperature: TEMPERATURE,
    stream: true,
    messages: [systemMessage, ...messages.filter((m) => m.role !== "system")],
  });

  async function* toText() {
    for await (const part of res) {
      const delta = part.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  return { kind: "answer", stream: toText(), cited: usable };
}
