-- ---------------------------------------------------------------------------
-- Esquema mínimo para RAG híbrido con citas verificables.
--
-- Dos tablas: el documento y sus trozos. Todo lo demás (usuarios, permisos,
-- conversaciones) es del producto que lo use y no pertenece acá.
--
-- Postgres 15+ con pgvector >= 0.8. Probado en Supabase.
-- ---------------------------------------------------------------------------

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------------
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid not null,          -- agrupador: proyecto, curso, tenant
  title         text not null,
  author        text,                   -- puede faltar: ver nota en corpus-block.ts
  storage_path  text not null,
  status        text not null default 'pending',   -- pending | processing | ready | error
  page_count    int,
  error         text,
  created_at    timestamptz not null default now(),
  ready_at      timestamptz
);
create index documents_collection_idx on public.documents(collection_id);

-- ---------------------------------------------------------------------------
-- Chunks
--
-- `page_start` / `page_end` y `section_path` no son decoración: son lo que
-- convierte una cita en verificable. Sin ellos el usuario no puede ir al
-- documento a comprobar que la respuesta dice la verdad, que es justamente
-- lo que distingue este diseño de un RAG que simplemente "suena bien".
-- ---------------------------------------------------------------------------
create table public.chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents(id) on delete cascade,
  collection_id uuid not null,
  section_id    uuid,                   -- subdivisión opcional dentro de la colección
  chunk_index   int  not null,
  page_start    int,
  page_end      int,
  section_path  text,                   -- "Parte II > Capítulo 3"
  content       text not null,
  token_count   int,

  -- 1536 dimensiones vía Matryoshka de text-embedding-3-large.
  -- No es el tamaño nativo del modelo: es el recorte que mantiene el índice
  -- HNSW dentro de los límites de tamaño de página de Postgres sin perder
  -- calidad de recuperación de forma medible.
  embedding     vector(1536),

  -- Columna generada: el lado sparse de la búsqueda híbrida se mantiene solo.
  -- Cambiar 'spanish' por la configuración del idioma del corpus.
  content_tsv   tsvector
                generated always as (to_tsvector('spanish', content)) stored,

  created_at    timestamptz not null default now()
);

create index chunks_document_idx   on public.chunks(document_id);
create index chunks_collection_idx on public.chunks(collection_id);
create index chunks_tsv_idx        on public.chunks using gin(content_tsv);

create index chunks_embedding_idx
  on public.chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
