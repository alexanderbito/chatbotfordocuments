-- Run this entire file in Supabase Dashboard > SQL Editor > New query > Run

-- 1. Enable the pgvector extension (already available on Supabase, it just needs enabling)
create extension if not exists vector;

-- 2. Subscribing companies (tenants)
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- 3. Documents (only the R2 path is stored here, never the file itself)
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  filename text not null,
  storage_key text not null,       -- key inside the R2 bucket
  storage_url text not null,       -- public URL, used to download the file for processing
  status text default 'processing', -- processing | ready | failed
  created_at timestamptz default now()
);

-- 4. Chunked text passages plus their embedding vectors
-- voyage-4-lite (Voyage AI) produces 1024-dimension vectors by default
create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  chunk_index int,
  created_at timestamptz default now()
);

-- 5. Index that speeds up semantic search (uses cosine distance)
create index if not exists document_chunks_embedding_idx
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists document_chunks_org_idx
  on document_chunks (organization_id);

-- 6. Semantic search function; ALWAYS filters by organization_id to keep tenant data isolated
create or replace function match_document_chunks(
  query_embedding vector(1024),
  match_org_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language sql stable
as $$
  select
    document_chunks.id,
    document_chunks.document_id,
    document_chunks.content,
    1 - (document_chunks.embedding <=> query_embedding) as similarity
  from document_chunks
  where document_chunks.organization_id = match_org_id
  order by document_chunks.embedding <=> query_embedding
  limit match_count;
$$;

-- 7. (Optional, but worth enabling) Row Level Security to block cross-tenant access
alter table documents enable row level security;
alter table document_chunks enable row level security;
-- In the demo stage the backend uses the service_role key, so it bypasses RLS anyway.
-- For real production, write policies based on auth.uid() / the signed-in user's organization_id.
