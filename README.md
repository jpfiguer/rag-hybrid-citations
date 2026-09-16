# rag-hybrid-citations

> Hybrid RAG retrieval on Postgres + pgvector, with verifiable citations and an
> explicit refusal path. Extracted from a production system.

Pipeline de RAG con dos propiedades que no suelen venir juntas: **búsqueda
híbrida** (densa + BM25, fusionadas con Reciprocal Rank Fusion en Postgres) y
**citas comprobables** — cada afirmación lleva `[N]` y cada `[N]` apunta a un
documento, una página y una sección concretas, para que quien lee pueda ir a
verificar.

Cuando el corpus no contiene la respuesta, el sistema lo dice en vez de
improvisar. Esa es la parte difícil, y tiene su propia sección abajo.

Es **código de referencia**, no una librería instalable ni una app. Está
extraído de un sistema en producción y publicado para que se pueda leer y
adaptar: no hay `npm install rag-hybrid-citations`.

---

## Lo que hay acá

```
sql/
  001_schema.sql        documents + chunks, pgvector, tsvector generada,
                        índices HNSW y GIN
  002_hybrid_search.sql la función de búsqueda: denso + BM25 fusionados
                        con RRF, con los tres fixes que costaron sangre

src/ingest/
  ocr.ts                Mistral OCR: markdown por página, escaneos incluidos
  chunker.ts            chunking estructural con mapa offset→página y
                        sectionPath ("Parte II > Capítulo 3")
  embedder.ts           embeddings por lotes, 1536d vía Matryoshka

src/retrieval/
  plan.ts               planificador: 1..N consultas desde la conversación
  search.ts             ejecuta la búsqueda híbrida
  merge.ts              fusiona N resultados; límites adaptativos

src/answer/
  corpus-block.ts       arma el bloque CORPUS declarando la metadata ausente
  answer.ts             umbral de rechazo + prompt de citas

docs/DECISIONS.md       por qué está escrito así: ocho bugs y decisiones
```

---

## Las tres ideas

### 1. La fusión ocurre en SQL

`hybrid_search` corre los dos rankings —distancia coseno sobre HNSW y
`ts_rank_cd` sobre un índice GIN— y los fusiona con RRF dentro de Postgres.

RRF fusiona por **posición**, no por puntaje. Eso evita tener que normalizar la
distancia coseno contra `ts_rank_cd`, que son dos escalas sin relación, y evita
elegir un peso arbitrario entre ambas. El `k = 60` viene del paper original.

Traer los dos rankings a Node para mezclarlos ahí significaría mover cientos de
filas por consulta para descartar casi todas.

### 2. La consulta del usuario no es la consulta de búsqueda

`plan.ts` traduce la conversación a 1..N consultas autocontenidas:

- Un follow-up corto ("dame ejemplos") se resuelve con el referente del turno
  anterior, para que la consulta se entienda sola.
- Un mensaje con cinco sub-preguntas produce cinco búsquedas en paralelo, no
  una que las promedie.
- El relleno conversacional se elimina; los nombres propios se preservan.

Y una regla que parece menor y no lo es: **prohibido agregar palabras genéricas**
("ideas principales", "resumen", "conceptos"). El lado sparse es BM25 y trata
los términos como AND, así que cada palabra de más es un requisito de más. La
intuición de "más contexto es mejor", cierta para el lado denso, es falsa para
el sparse.

### 3. Rechazar es un resultado, no un error

La búsqueda híbrida siempre devuelve algo. Sin un piso de puntaje, una pregunta
sobre un tema ausente recupera los fragmentos menos malos y el modelo arma una
respuesta citándolos — con citas **reales** a pasajes que no vienen al caso.
Eso es peor que un "no sé".

`MIN_RRF_SCORE` corta ahí, y `answer()` devuelve el rechazo como un caso normal
del tipo de retorno:

```ts
const result = await answer(messages, chunks);
if (result.kind === "refusal") return result.text;
for await (const delta of result.stream) { /* … */ }
```

El prompt, además, separa lo que el modelo **afirma sobre las fuentes** —cita
obligatoria— de lo que **aporta de su lado** —marca obligatoria: "un ejemplo
sería…"—. Sin esa distinción hay que elegir entre un asistente inservible, que
no puede dar un ejemplo, y uno que le atribuye al autor ejemplos que el autor
nunca dio. La segunda alucinación es peor: suena razonable y la cita que la
acompaña es auténtica.

---

## Uso

```ts
import { planQueries, wantsBroadCoverage } from "./src/retrieval/plan";
import { retrieve } from "./src/retrieval/search";
import { mergeResults, planLimits } from "./src/retrieval/merge";
import { answer } from "./src/answer/answer";

const queries = await planQueries(messages, corpusDocs);
const { perQuery, final } = planLimits(
  queries.length,
  wantsBroadCoverage(lastUserMessage)
);

const results = await Promise.all(
  queries.map((q) => retrieve(db, collectionId, q, { limit: perQuery }))
);

const result = await answer(messages, mergeResults(results, final));
```

`db` es cualquier cosa que sepa llamar a una función de Postgres — el tipo
`RpcClient` de `src/types.ts` tiene un solo método. `@supabase/supabase-js` lo
cumple; el paquete no se casa con ningún SDK.

Requiere Postgres 15+ con **pgvector >= 0.8** (el fix de `iterative_scan` no
existe antes) y las variables de `.env.example`.

---

## Por qué existe este repositorio

Extraído de un sistema de RAG académico en producción: estudiantes consultan el
material de su curso y cada respuesta cita el pasaje textual. El código de
producto —autenticación, gestión de documentos, interfaz— no está acá, ni el
corpus, que era material con derechos de autor.

Lo que sí está es la parte transferible: el esquema, la búsqueda híbrida y las
decisiones que la sostienen. [`docs/DECISIONS.md`](docs/DECISIONS.md) es
probablemente la parte más útil — son ocho bugs y decisiones que solo aparecen
cuando el sistema lleva tiempo corriendo con datos reales.

## Licencia

MIT — ver [LICENSE](LICENSE).
