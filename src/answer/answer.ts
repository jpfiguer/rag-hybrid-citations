import OpenAI from "openai";
import { buildCorpusBlock } from "./corpus-block";
import type { Msg } from "../retrieval/plan";
import type { RetrievedChunk } from "../types";

const MODEL = "gpt-4o";
const TEMPERATURE = 0.2;

/**
 * Umbral de RRF por debajo del cual se considera que no hay material.
 *
 * Existe porque la búsqueda híbrida SIEMPRE devuelve algo: por mal que
 * matcheen, los k primeros chunks salen igual. Sin umbral, una pregunta sobre
 * un tema ausente recupera los fragmentos menos malos del corpus y el modelo,
 * obediente, construye una respuesta citándolos. El resultado es peor que un
 * "no sé": es una respuesta con citas reales a pasajes que no vienen al caso.
 *
 * El valor se calibra contra el corpus propio. 0.005 es el punto donde, en el
 * sistema del que sale este código, empezaban a colarse los falsos positivos.
 */
export const MIN_RRF_SCORE = 0.005;

export const REFUSAL =
  "No encuentro este tema en el material de esta colección. Si crees que debería estar, revisa que la fuente correspondiente esté cargada.";

/**
 * El prompt.
 *
 * La distinción que lo sostiene: separar lo que el modelo AFIRMA sobre las
 * fuentes de lo que el modelo APORTA de su lado.
 *
 * Un RAG que prohíbe todo lo que no esté en el corpus produce respuestas
 * inservibles como material de estudio —no puede dar un ejemplo, ni una
 * analogía, ni reformular en palabras simples—. Uno que lo permite sin marcar
 * termina atribuyéndole al autor ejemplos que el autor nunca dio, que es una
 * alucinación más difícil de detectar que un dato falso, porque el dato suena
 * razonable y la cita que lo acompaña es real.
 *
 * La regla resuelve las dos: los hechos llevan cita obligatoria, las
 * ilustraciones llevan marca obligatoria, y ninguna de las dos puede pasar por
 * la otra.
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
 * Decide si hay material suficiente y, si lo hay, responde citando.
 *
 * Devuelve el rechazo como un caso normal y no como un error: que el corpus no
 * tenga la respuesta es un desenlace legítimo del sistema, no una falla.
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
