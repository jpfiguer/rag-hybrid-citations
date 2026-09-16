# Decisions and bugs paid for

None of what follows came from the initial design. It came from the system
failing in production in ways that didn't look like their cause. It's here
because the value of this repository isn't the code — that's two hundred lines —
but knowing why it's written this way.

---

## 1. HNSW returns zero results when the filter is post-hoc

**Symptom.** Search worked with one collection loaded. Adding a second, larger
one made queries against the first start returning zero chunks. No error, no
timeout: zero rows, as if the collection were empty.

**Cause.** The HNSW index walks the nearest-neighbour graph and **then** applies
`where collection_id = X`. If the query vector's nearest neighbours belong to
the other collection, the filter discards all of them and nothing is left. The
more unbalanced the collections, the more likely it gets.

It's counterintuitive because the query appears to say "search within this
collection", when it actually says "search everything and keep what belongs to
this collection".

**Fix.** `iterative_scan = strict_order`, from pgvector 0.8: HNSW keeps
searching beyond `ef_search` when the filter discards candidates.

```sql
set local hnsw.iterative_scan = 'strict_order';
set local hnsw.max_scan_tuples = 20000;
```

Ref: [pgvector — iterative index scans](https://github.com/pgvector/pgvector#iterative-index-scans)

**The lesson.** A vector index with a tenant filter is not the same as an index
per tenant. If the system is multi-collection, test it with collections of very
different sizes — with evenly sized data the bug never shows up.

---

## 2. `SET LOCAL` isn't allowed in `STABLE` functions

**Symptom.** Applying the fix above, the function stopped being creatable.

**Cause.** The function only reads, so it was marked `STABLE` — the intuitively
correct choice. But Postgres forbids `SET LOCAL` inside `STABLE` or `IMMUTABLE`
functions, and the HNSW fix needs exactly that.

**Fix.** `volatile`. It costs some planner optimization and there's no
alternative.

---

## 3. `sum(numeric)` against a `float` return type

**Symptom.** With the above fixed, the call started failing with
`Returned type numeric does not match expected type double precision in column 10`.

**Cause.** `sum(1.0 / int)` returns `numeric` in PL/pgSQL. The return type
declares `rrf_score float`. The previous version was `language sql` and Postgres
did the cast implicitly — the error only appeared after moving to `plpgsql` in
order to use `SET LOCAL`.

**Fix.** Explicit casts at both levels: `(1.0 / (k + rnk))::float` and
`sum(...)::float`.

**The lesson.** Three chained bugs, each caused by fixing the previous one.
Worth writing down together: separately, none of the three makes sense.

---

## 4. Migrations that can't be re-applied

**Symptom.** An environment got half-migrated and the next migration failed when
run again.

**Cause.** `drop function ... (uuid, text, vector, int, int, uuid[])` needs the
exact signature. While iterating on the function the signature changes, and the
new migration's `drop` can't find the old version.

**Fix.** Drop by name, walking `pg_proc`, without knowing the signatures.

**The lesson.** A migration has to survive being run twice. The moment that
matters is exactly when something has already gone wrong.

---

## 5. The refusal threshold

Hybrid search **always** returns results: however poorly they match, the top k
chunks come back anyway. Without a score floor, a question about a topic that
isn't in the corpus retrieves the least-bad fragments and the model, obediently,
builds an answer citing them.

That's worse than "I don't know", because the citations are real: they point at
passages that exist and that the user can go verify. What doesn't exist is the
relationship between those passages and the question.

`MIN_RRF_SCORE` is calibrated against your own corpus. There's no universal
value.

---

## 6. Absent metadata is declared, not omitted

Asking a model for an APA citation over a corpus with no publication year
produces invented years. Not because the model lies, but because the APA format
expects a year and nothing in the prompt says that field doesn't exist.

The solution is one line per missing field:

```
YEAR=(not recorded — use "n.d." in APA)
PUBLISHER=(not recorded — omit in APA)
```

It's the same principle as failing loudly rather than silently: the absence of a
value has to be visible.

---

## 7. The planner's hallucination

The query planner hallucinates too, and it's harder to catch.

Given a vague message about a familiar domain, it proposes queries naming
authors that "ought to" be in that corpus but were never loaded. The engine
searches for material that doesn't exist, finds nothing, and the system answers
that it has no information — when it did, under other names.

The failure happens before retrieval, so an evaluation that only looks at the
final answer records it as "the corpus didn't cover the topic".

**Fix.** Give the planner the collection's real document list as an anchor.

---

## 8. BM25 treats terms as AND

The sparse side of hybrid search penalizes long queries. Adding scaffolding
words — "main ideas", "summary", "concepts" — looks like it enriches the query
and actually breaks it: each extra term is one more requirement the document has
to satisfy.

That's why the planner's prompt explicitly forbids that vocabulary. If the
document is titled *Patterns of Democracy*, the query is
`Lijphart patterns democracy`, not `main ideas from Lijphart about patterns of
democracy`.

It's a case where the intuition "more context is better" — true for the dense
side — is exactly false for the sparse one, and hybrid search has to live with
both.
