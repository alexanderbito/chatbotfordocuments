-- Chạy toàn bộ file này trong Supabase Dashboard > SQL Editor > New query > Run

-- 1. Bật extension pgvector (đã có sẵn trên Supabase, chỉ cần bật)
create extension if not exists vector;

-- 2. Bảng doanh nghiệp thuê bao
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- 3. Bảng tài liệu (chỉ lưu đường dẫn R2, không lưu file)
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  filename text not null,
  storage_key text not null,       -- key trong bucket R2
  storage_url text not null,       -- URL public/để tải về xử lý
  status text default 'processing', -- processing | ready | failed
  created_at timestamptz default now()
);

-- 4. Bảng đoạn văn bản đã chia nhỏ + vector embedding
-- voyage-4-lite (Voyage AI) mặc định ra vector 1024 chiều
create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  chunk_index int,
  created_at timestamptz default now()
);

-- 5. Index tăng tốc semantic search (dùng cosine distance)
create index if not exists document_chunks_embedding_idx
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists document_chunks_org_idx
  on document_chunks (organization_id);

-- 6. Hàm tìm kiếm ngữ nghĩa, LUÔN lọc theo organization_id để cách ly dữ liệu
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

-- 7. (Tuỳ chọn nhưng nên bật) Row Level Security để chặn truy cập chéo tenant
alter table documents enable row level security;
alter table document_chunks enable row level security;
-- Ở giai đoạn demo, backend dùng service_role key nên tự bypass RLS.
-- Khi lên production thật, viết policy theo auth.uid() / organization_id của user đăng nhập.
