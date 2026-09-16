# Evaluating a RAG system that is already in production

Every deploy is a shot in the dark until you can answer one question in seconds:

> **Are the questions users asked five days ago still being answered as well
> today?**

Without that signal, each reactive fix can silently break something else, and
you find out when the client tells you.

This document describes the harness built to answer it, for a RAG system whose
traffic grew from ~3,000 to ~16,000 queries per weekly window over five months. It is method, not code — the implementation lives
in the private system this repository was extracted from. The parts worth
copying are the decisions.

---

## 1. The eval set is production traffic, not a fixture

The obvious way to build an eval set is to write questions. It is also the way
that drifts fastest from reality: you write the questions you imagined the system
would get, and real users ask something else.

So the baseline is captured, not authored:

```
Monday AM   capture the last 7 days of real queries as a baseline
Every PR    replay the current baseline against HEAD
Monday PM   replay against production after the week's deploys
            review anything marked REGRESSED with a domain expert
```

The capture is a sample, not a census: it pulls the first N entries from the
query log for the window — 100 by default — and dedupes them to one sample per
distinct question. A typical run yielded 78 distinct questions out of those 100
log entries. One run hit exactly 100, which is the cap telling you it bound: that
week had more distinct questions than the sample could hold.

Stating the sampling explicitly matters, because the number invites a conclusion
it doesn't support. 78 distinct questions is **not** evidence that a week's
traffic reduces to 78 things people ask. It is 78 out of a 100-entry sample. What
the baseline gives you is questions that are *real*, refreshed weekly at no
authoring cost — not a claim about how repetitive your traffic is.

It also captures the questions you would never have thought to write: the vague
ones, the half-typed ones, the ones that mix two topics.

---

## 2. A diff, not a score

A single quality number tells you something moved. It doesn't tell you what, and
it can't be reviewed. So each replay produces a **classified diff**, one of four
buckets per question:

| Bucket | Meaning |
|---|---|
| **IDENTICAL** | Same source, same routing, confidence delta ≤ 0.05 — or semantic similarity ≥ 0.85 |
| **IMPROVED** | Source upgrade (e.g. fell back to web before, now answers from the corpus) with similarity ≥ 0.60, or confidence delta > 0.15 |
| **REGRESSED** | Source downgrade with similarity < 0.60, or confidence delta < −0.15, or a replay error, or it used to answer and now refuses |
| **CHANGED** | Everything else — needs a human |

**CHANGED existing is the design decision that makes this usable.** A classifier
forced to call everything either fine or broken produces noise in both
directions. A bucket that means "this moved in a way I can't judge" keeps the
other three trustworthy, and gives the weekly review a short, honest queue.

---

## 3. Why one signal is not enough

The first version classified on pipeline metadata alone: which source the answer
came from, the confidence score, which document set was routed to.

It produced false regressions constantly.

The failure mode: a cosmetic re-label. The pipeline starts tagging an answer
`general_web` where it used to say `internal`, the **content is equivalent**, and
metadata-only classification reports a regression. Chase enough of those and the
harness stops being read — which is worse than not having it.

The fix is a dual signal: pipeline metadata **and** semantic similarity of the
answer text. Metadata says the routing changed; similarity says whether the user
would notice. Only when both agree does something get marked REGRESSED.

---

## 4. Similarity, with the limitation stated

Semantic similarity is itself a dependency, and the harness has to run in CI
where API keys and GPUs may not exist. So it auto-detects four tiers:

1. **Backend embeddings** (preferred) — the *same* embedding model the RAG uses.
   Same model matters: measuring similarity with a different model than the one
   that did retrieval introduces a second opinion you then have to reconcile.
2. **A hosted embedding API** — when a key is present.
3. **Lexical** (default) — Jaccard plus difflib with boilerplate stripped. Zero
   dependency, always available.
4. **None** — always returns 1.0. For testing the harness itself.

The lexical tier has a **known limitation, and it is written down in the tool's
own docs**: it scores around 0.3 for answers that are semantically equivalent but
phrased differently, which generates false REGRESSED marks.

That is worth stating plainly rather than hiding. A measurement tool whose
failure modes are undocumented gets trusted exactly until the first time it is
wrong, and then it gets ignored forever. Writing the limitation next to the
number is what keeps the tool in use.

---

## 5. Where it runs

Retrieval quality belongs in CI next to the unit tests, but it can't behave like
them:

- **Path-scoped.** The eval job triggers only on PRs touching retrieval,
  ranking, intent classification or the eval suite itself. A CSS change should
  not spend four minutes measuring recall.
- **Degrades to a skip, never a block.** If the endpoint or credentials aren't
  configured, the job logs a skip and passes. An eval job that fails on a fresh
  clone gets disabled within a week.
- **The expensive layer is opt-in.** LLM-as-judge metrics cost money per run, so
  they don't run on every PR — they run on a schedule and on demand. Cheap
  signal automated, expensive signal deliberate.

Alongside it: a captured baseline per week, kept forever. `prod_2026-04-23.json`
is not clutter — it is the answer to "when did this start happening?", which is
otherwise unanswerable.

---

## 6. What the numbers looked like

From the RAGAS layer of that system, judged over a captured production sample:

| Metric | Value |
|---|---|
| Faithfulness | 0.86 mean · **0.96 median** |
| Context precision | 0.997 |
| Response relevancy | 0.50 mean · 0.64 excluding clarification turns |

Two things to read there.

**The mean/median gap on faithfulness** is the interesting one. A 0.96 median
with a 0.86 mean means most answers are near-perfectly grounded and a small tail
is not — which is a completely different engineering problem from "the system is
uniformly mediocre", and a single mean would have hidden it.

**Response relevancy at 0.50 looks bad and mostly isn't.** Of 30 judged turns, 9
were cases where the system asked for a clarification instead of answering.
Judged as answers, they score near zero. Excluding them, relevancy is 0.64. The
metric was measuring a behaviour that was working as designed — which is a
reminder that a metric you haven't segmented is a metric you don't understand
yet.

---

## 7. What it costs

The harness is a few hundred lines and a scheduled job. The weekly review is
maybe twenty minutes with someone who knows the domain.

What it buys is the ability to change retrieval — swap a reranker, adjust
chunking, add an intent heuristic — and know within minutes whether real
questions got better or worse, before a user finds out.

That capability, not the metrics, is the actual deliverable. The numbers are just
how it reports.
