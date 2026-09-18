-- =====================================================================
-- MIGRATION V5 — Thư mục công khai / riêng tư và phân quyền theo email
-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- An toàn khi chạy lại nhiều lần. Yêu cầu đã chạy migration_v4_ocr_retry.sql.
-- =====================================================================

-- 1. Chế độ hiển thị của thư mục
--    public  : mọi thành viên trong tổ chức đều hỏi được tài liệu bên trong
--    private : chỉ những email được cấp quyền (và admin tổ chức) mới đọc được
alter table folders add column if not exists visibility text not null default 'public';

alter table folders drop constraint if exists folders_visibility_check;
alter table folders add constraint folders_visibility_check
  check (visibility in ('public', 'private'));

create index if not exists folders_visibility_idx on folders (organization_id, visibility);

-- 2. Danh sách email được đọc từng thư mục riêng tư
create table if not exists folder_permissions (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references folders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  granted_by uuid,
  created_at timestamptz not null default now()
);

-- Email luôn lưu dạng chữ thường để so khớp không phân biệt hoa thường
create unique index if not exists folder_permissions_unique_idx
  on folder_permissions (folder_id, email);
create index if not exists folder_permissions_email_idx
  on folder_permissions (organization_id, email);

alter table folder_permissions enable row level security;

-- 3. Hàm tìm kiếm ngữ nghĩa CÓ KIỂM TRA QUYỀN.
--    Khác với match_document_chunks_scoped ở chỗ: phía backend truyền vào
--    danh sách thư mục mà người hỏi ĐƯỢC PHÉP đọc. Cách này "fail closed" —
--    nếu tính quyền sai sót thì người dùng không thấy gì, thay vì thấy nhầm
--    tài liệu mật.
create or replace function match_document_chunks_acl(
  query_embedding vector(1024),
  match_org_id uuid,
  match_count int default 5,
  allowed_folder_ids uuid[] default '{}',
  include_unfiled boolean default true
)
returns table (id uuid, document_id uuid, folder_id uuid, content text, similarity float)
language sql stable
as $$
  select dc.id, dc.document_id, dc.folder_id, dc.content,
         1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.organization_id = match_org_id
    and (
      (dc.folder_id is null and include_unfiled)
      or dc.folder_id = any(allowed_folder_ids)
    )
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- 4. Dọn quyền của những email đã bị gỡ khỏi tổ chức
create or replace function cleanup_orphan_folder_permissions()
returns int
language sql
as $$
  with deleted as (
    delete from folder_permissions fp
    where not exists (
      select 1 from organization_members m
      where m.organization_id = fp.organization_id
        and lower(m.email) = fp.email
    )
    returning fp.id
  )
  select count(*)::int from deleted;
$$;

-- =====================================================================
-- LƯU Ý: các thư mục đang có đều mặc định là 'public', nghĩa là hành vi
-- hiện tại không đổi cho tới khi admin chủ động đặt một thư mục thành riêng tư.
-- =====================================================================
