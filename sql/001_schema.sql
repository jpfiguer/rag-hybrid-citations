-- ---------------------------------------------------------------------------
-- Minimal schema for hybrid RAG with verifiable citations.
--
-- Two tables: the document and its chunks. Everything else — users,
-- permissions, conversations — belongs to whatever product uses this and has no
-- place here.
--
-- Postgres 15+ with pgvector >= 0.8. Tested on Supabase.
-- ---------------------------------------------------------------------------

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid not null,          -- grouping: project, course, tenant
  title         text not null,
  author        text,                   -- may be missing: see note in corpus-block.ts
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
-- `page_start` / `page_end` and `section_path` are not decoration: they are what
-- makes a citation verifiable. Without them the user can't go to the document
-- and check that the answer is telling the truth, which is exactly what
-- separates this design from a RAG that merely sounds convincing.
-- ---------------------------------------------------------------------------
create table public.chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents(id) on delete cascade,
  collection_id uuid not null,
  section_id    uuid,                   -- optional subdivision within the collection
  chunk_index   int  not null,
  page_start    int,
  page_end      int,
  section_path  text,                   -- "Part II > Chapter 3"
  content       text not null,
  token_count   int,

  -- 1536 dimensions via text-embedding-3-large's Matryoshka property.
  -- This is not the model's native size: it's the truncation that keeps the
  -- HNSW index within Postgres page-size limits without any measurable loss in
  -- retrieval quality.
  embedding     vector(1536),

  -- Generated column: the sparse side of hybrid search maintains itself.
  -- Change 'spanish' to match the corpus language configuration.
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
