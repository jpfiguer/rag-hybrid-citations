-- ---------------------------------------------------------------------------
-- hybrid_search — denso + BM25 fusionados con Reciprocal Rank Fusion.
--
-- Tres decisiones que salieron de fallas en producción, no del diseño inicial.
-- Están explicadas en docs/DECISIONS.md; acá va el resumen de cada una.
-- ---------------------------------------------------------------------------

-- Drop idempotente por NOMBRE, no por signature.
--
-- Por qué: al iterar sobre la función cambia la lista de parámetros, y
-- `drop function ... (uuid, text, vector, int, int, uuid[])` falla cuando la
-- que está viva tiene otra firma. Entonces la migración no se puede re-aplicar
-- sobre un entorno que quedó a medias, que es exactamente cuando más se
-- necesita. Esto borra todas las sobrecargas existentes sin conocerlas.
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

-- VOLATILE, no STABLE.
--
-- Por qué: Postgres prohíbe SET LOCAL dentro de funciones STABLE o IMMUTABLE,
-- y acá hace falta para ajustar el escaneo de HNSW por consulta. Marcarla
-- STABLE "porque solo lee" es la intuición correcta y el resultado es un
-- error en tiempo de ejecución.
volatile
security invoker
set search_path = public
as $func$
begin
  -- El filtro post-hoc contra HNSW.
  --
  -- Por qué: HNSW recorre el grafo y DESPUÉS se aplica `where collection_id = X`.
  -- Si los vecinos más cercanos del vector de consulta pertenecen a otra
  -- colección, el filtro los descarta todos y la búsqueda devuelve cero
  -- resultados aunque la colección sí tenga material relevante. El síntoma es
  -- desconcertante: funciona con una colección cargada y falla al agregar una
  -- segunda, más grande.
  --
  -- `iterative_scan = strict_order` hace que HNSW siga buscando más allá de
  -- ef_search cuando el filtro descarta candidatos.
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

  -- Reciprocal Rank Fusion: cada lado aporta 1/(k + posición).
  --
  -- La gracia de RRF es que fusiona por POSICIÓN y no por puntaje, así que no
  -- hay que normalizar la distancia coseno contra ts_rank_cd —dos escalas que
  -- no son comparables— ni elegir un peso arbitrario entre ambas. k=60 es el
  -- valor del paper original y aplana la diferencia entre los primeros puestos.
  --
  -- El `::float` no es cosmético. `sum(1.0 / int)` devuelve `numeric` en
  -- PL/pgSQL, y el tipo de retorno declara `float` (double precision). Sin el
  -- cast, PostgREST rechaza la llamada con
  --   "Returned type numeric does not match expected type double precision".
  -- La versión anterior de esta función era `language sql` y Postgres hacía el
  -- cast implícito, así que el error apareció recién al pasarla a plpgsql para
  -- poder usar SET LOCAL: un bug causado por arreglar otro bug.
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
