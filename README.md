# rag-hybrid-citations

> Hybrid RAG retrieval on Postgres + pgvector, with verifiable citations and an
> explicit refusal path. Extracted from a production system.

A RAG pipeline with two properties that rarely come together: **hybrid search**
(dense + BM25, fused with Reciprocal Rank Fusion inside Postgres) and
**verifiable citations** — every claim carries a `[N]`, and every `[N]` points at
a specific document, page and section, so the reader can go check.

When the corpus doesn't hold the answer, the system says so instead of
improvising. That's the hard part, and it has its own section below.

This is **reference code**, not an installable library and not an app. It was
extracted from a production system and published to be read and adapted: there
is no `npm install rag-hybrid-citations`.

---

## What's here

```
sql/
  001_schema.sql        documents + chunks, pgvector, generated tsvector,
                        HNSW and GIN indexes
  002_hybrid_search.sql the search function: dense + BM25 fused with RRF,
                        including the three fixes that cost blood

src/ingest/
  ocr.ts                Mistral OCR: markdown per page, scans included
  chunker.ts            structural chunking with an offset→page map and a
                        sectionPath ("Part II > Chapter 3")
  embedder.ts           batched embeddings, 1536d via Matryoshka

src/retrieval/
  plan.ts               query planner: 1..N queries from the conversation
  search.ts             runs the hybrid search
  merge.ts              merges N result sets; adaptive limits

src/answer/
  corpus-block.ts       builds the CORPUS block, declaring absent metadata
  answer.ts             refusal threshold + citation prompt

docs/DECISIONS.md       why it's written this way: eight bugs and decisions
docs/EVALUATION.md      how the system it came from was measured in production
```

---

## The three ideas

### 1. Fusion happens in SQL

`hybrid_search` runs both rankings — cosine distance over HNSW and `ts_rank_cd`
over a GIN index — and fuses them with RRF inside Postgres.

RRF fuses by **rank**, not by score. That avoids having to normalize cosine
distance against `ts_rank_cd` — two scales with no relationship — and avoids
picking an arbitrary weight between them. The `k = 60` comes from the original
paper.

Pulling both rankings into Node to mix them there would mean moving hundreds of
rows per query only to discard almost all of them.

### 2. The user's message is not the search query

`plan.ts` translates the conversation into 1..N self-contained queries:

- A short follow-up ("give me examples") is resolved against the previous turn's
  referent, so the query stands on its own.
- A message with five sub-questions produces five parallel searches, not one
  that averages them.
- Conversational filler is stripped; proper nouns are preserved.

And one rule that looks minor and isn't: **no generic scaffolding words**
("main ideas", "summary", "concepts"). The sparse side is BM25 and treats terms
as AND, so every extra word is one more requirement. The intuition that "more
context is better" — true for the dense side — is false for the sparse one.

### 3. Refusing is a result, not an error

Hybrid search always returns something. Without a score floor, a question about
an absent topic retrieves the least-bad fragments and the model assembles an
answer citing them — with **real** citations to passages that don't apply. That
is worse than "I don't know".

`MIN_RRF_SCORE` cuts there, and `answer()` returns the refusal as a normal case
of the return type:

```ts
const result = await answer(messages, chunks);
if (result.kind === "refusal") return result.text;
for await (const delta of result.stream) { /* … */ }
```

The prompt also separates what the model **asserts about the sources** —
citation required — from what it **contributes itself** — marking required: "an
example would be…". Without that distinction you have to choose between a
useless assistant that can't give an example, and one that attributes to the
author examples the author never gave. The second hallucination is worse: it
sounds reasonable and the citation attached to it is genuine.

---

## Usage

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

`db` is anything that can call a Postgres function — the `RpcClient` type in
`src/types.ts` has a single method. `@supabase/supabase-js` satisfies it; the
package is not married to any SDK.

Requires Postgres 15+ with **pgvector >= 0.8** (the `iterative_scan` fix doesn't
exist before that) and the variables in `.env.example`.

---

## Why this repository exists

Extracted from an academic RAG system in production: students query their course
material and every answer cites the source passage. The product code —
authentication, document management, the interface — isn't here, and neither is
the corpus, which was copyrighted material.

What is here is the transferable part: the schema, the hybrid search and the
decisions behind them. Two documents carry most of the value:

- [`docs/DECISIONS.md`](docs/DECISIONS.md) — eight bugs and decisions that only
  surface once a system has been running on real data for a while.
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — how a RAG system already serving
  ~16,000 queries a week was measured: capturing production traffic as the eval
  set, classifying each replay into a reviewable diff, and why a single quality
  score is the wrong output.

## License

MIT — see [LICENSE](LICENSE).
