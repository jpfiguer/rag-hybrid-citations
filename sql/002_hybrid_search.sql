-- ---------------------------------------------------------------------------
-- hybrid_search — dense + BM25 fused with Reciprocal Rank Fusion.
--
-- Three decisions that came out of production failures, not the initial design.
-- They're explained in docs/DECISIONS.md; here's the summary of each.
-- ---------------------------------------------------------------------------

-- Idempotent drop by NAME, not by signature.
--
-- Why: while iterating on the function the parameter list changes, and
-- `drop function ... (uuid, text, vector, int, int, uuid[])` fails when the live
-- one has a different signature. So the migration can't be re-applied against an
-- environment that ended up half-migrated — which is exactly when you need it
-- most. This drops every existing overload without knowing them.
do $$
declare r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'hybrid_search'
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

create function public.hybrid_search(
  p_collection_id   uuid,
  p_query_text      text,
  p_query_embedding vector(1536),
  p_match_count     int default 20,
  p_rrf_k           int default 60,
  p_section_ids     uuid[] default null
)
returns table (
  chunk_id       uuid,
  document_id    uuid,
  document_title text,
  author         text,
  page_start     int,
  page_end       int,
  section_path   text,
  content        text,
  section_id     uuid,
  rrf_score      float
)
language plpgsql

-- VOLATILE, not STABLE.
--
-- Why: Postgres forbids SET LOCAL inside STABLE or IMMUTABLE functions, and it's
-- needed here to tune the HNSW scan per query. Marking it STABLE "because it
-- only reads" is the intuitive call, and the result is a runtime error.
volatile
security invoker
set search_path = public
as $func$
begin
  -- The post-hoc filter against HNSW.
  --
  -- Why: HNSW walks the graph and only THEN is `where collection_id = X`
  -- applied. If the query vector's nearest neighbours belong to another
  -- collection, the filter discards all of them and the search returns zero
  -- results even though the collection does hold relevant material. The symptom
  -- is baffling: it works with one collection loaded and fails once you add a
  -- second, larger one.
  --
  -- `iterative_scan = strict_order` makes HNSW keep searching beyond ef_search
  -- when the filter discards candidates.
  -- Ref: https://github.com/pgvector/pgvector#iterative-index-scans
  set local hnsw.iterative_scan = 'strict_order';
  set local hnsw.max_scan_tuples = 20000;

  return query
  with dense as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from public.chunks c
    where c.collection_id = p_collection_id
      and (p_section_ids is null or c.section_id = any(p_section_ids))
    order by c.embedding <=> p_query_embedding
    limit p_match_count
  ),
  sparse as (
    select c.id,
      row_number() over (
        order by ts_rank_cd(c.content_tsv, plainto_tsquery('spanish', p_query_text)) desc
      ) as rnk
    from public.chunks c
    where c.collection_id = p_collection_id
      and (p_section_ids is null or c.section_id = any(p_section_ids))
      and c.content_tsv @@ plainto_tsquery('spanish', p_query_text)
    limit p_match_count
  ),

  -- Reciprocal Rank Fusion: each side contributes 1/(k + rank).
  --
  -- The point of RRF is that it fuses by RANK rather than by score, so there's
  -- no need to normalize cosine distance against ts_rank_cd — two scales with no
  -- relationship — and no arbitrary weight to pick between them. k=60 is the
  -- value from the original paper and flattens the difference between the top
  -- few positions.
  --
  -- The `::float` is not cosmetic. `sum(1.0 / int)` returns `numeric` in
  -- PL/pgSQL, and the return type declares `float` (double precision). Without
  -- the cast, PostgREST rejects the call with
  --   "Returned type numeric does not match expected type double precision".
  -- The previous version of this function was `language sql` and Postgres cast
  -- implicitly, so the error only showed up once it moved to plpgsql to be able
  -- to use SET LOCAL: a bug caused by fixing another bug.
  fused as (
    select id, sum(score)::float as rrf_score from (
      select id, (1.0 / (p_rrf_k + rnk))::float as score from dense
      union all
      select id, (1.0 / (p_rrf_k + rnk))::float as score from sparse
    ) s
    group by id
    order by rrf_score desc
    limit p_match_count
  )
  select
    c.id, c.document_id, d.title, d.author,
    c.page_start, c.page_end, c.section_path, c.content, c.section_id,
    f.rrf_score
  from fused f
  join public.chunks c    on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.rrf_score desc;
end;
$func$;
