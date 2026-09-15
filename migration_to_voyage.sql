-- MIGRATION: chuyển embedding từ 1536 chiều (OpenAI) sang 1024 chiều (Voyage voyage-4-lite)
-- Chạy toàn bộ file này trong Supabase SQL Editor > New query > Run

-- 1. Xoá sạch dữ liệu tài liệu + chunk cũ
--    (vì đã đổi provider embedding, dữ liệu cũ không dùng lại được — cần upload + index lại)
truncate table document_chunks;
delete from documents;

-- 2. Đổi cột embedding sang 1024 chiều
--    (chạy được vì bảng đã trống sau bước 1 ở trên)
alter table document_chunks
  alter column embedding type vector(1024);

-- 3. Xoá và tạo lại index cho đúng chiều mới
drop index if exists document_chunks_embedding_idx;
create index document_chunks_embedding_idx
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. Cập nhật lại hàm tìm kiếm ngữ nghĩa theo chiều mới
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
