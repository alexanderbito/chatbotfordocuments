-- MIGRATION: move embeddings from 1536 dimensions (OpenAI) to 1024 dimensions (Voyage voyage-4-lite)
-- Run this entire file in the Supabase SQL Editor > New query > Run

-- 1. Wipe the existing documents and chunks
--    (the embedding provider changed, so the old vectors are unusable — everything must be re-uploaded and re-indexed)
truncate table document_chunks;
delete from documents;

-- 2. Change the embedding column to 1024 dimensions
--    (this works only because step 1 above left the table empty)
alter table document_chunks
  alter column embedding type vector(1024);

-- 3. Drop and recreate the index so it matches the new dimension
drop index if exists document_chunks_embedding_idx;
create index document_chunks_embedding_idx
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. Update the semantic search function for the new dimension
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
