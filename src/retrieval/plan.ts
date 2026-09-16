import OpenAI from "openai";

const MODEL = "gpt-4o-mini";
const MAX_QUERIES = 10;

/**
 * El planificador de consultas.
 *
 * El mensaje del usuario y una buena consulta de búsqueda casi nunca son lo
 * mismo. "Explícame a detalle el texto de Ostrom sobre gobernanza de recursos
 * comunes" es una pregunta legítima y una consulta pésima: la mitad son
 * palabras de relleno que ensucian el matching. Y un mensaje con cinco
 * sub-preguntas necesita cinco búsquedas, no una que promedie las cinco.
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
  // Menos de 3 caracteres útiles no es una consulta, es ruido de parseo.
  if (trimmed.replace(/[\s.,;:!¡¿?"'()\-]+/g, "").length < 3) return null;
  return trimmed.slice(0, 400);
}

/**
 * Planifica 1..N consultas a partir de los últimos turnos.
 *
 * `corpusDocs` es la lista de documentos realmente disponibles. Sin ese ancla
 * el planificador alucina fuentes plausibles para el dominio —autores que
 * "deberían" estar— y luego el motor busca material que nunca se cargó. Es un
 * caso de alucinación que no ocurre en el modelo que responde sino en el que
 * planifica, y por eso se escapa de las evaluaciones que solo miran la
 * respuesta final.
 *
 * Nunca lanza: ante cualquier fallo devuelve el mensaje del usuario como única
 * consulta. Un planificador caído degrada la calidad de la búsqueda; no debe
 * tumbar la respuesta.
 */
export async function planQueries(
  messages: Msg[],
  corpusDocs: CorpusDoc[] = []
): Promise<string[]> {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return [];

  const trimmed = lastUser.content.trim();
  const priorTurns = messages.filter((m) => m.role !== "system");

  // Atajo: un término suelto en el primer turno ya es la consulta. Pedirle al
  // modelo que "planifique" sobre una sola palabra agrega latencia y riesgo.
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
 * Detecta pedidos de cobertura amplia, que necesitan más material recuperado
 * para no omitir fuentes. Es una heurística barata a propósito: gastar una
 * llamada al modelo para decidir cuánto recuperar antes de recuperar duplica
 * la latencia del turno.
 */
export function wantsBroadCoverage(message: string): boolean {
  return /\b(resumen|res[uú]men|resume).{0,40}(cada|todos|todas|completo|completa|exhaustivo|extenso|de todo)\b|\bde cada (autor|fuente|texto|documento)\b|\btodo el material\b/i.test(
    message
  );
}
