-- =====================================================================
-- MIGRATION V3 — OCR cho PDF scan (dùng Gemini)
-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- An toàn khi chạy lại nhiều lần.
-- Yêu cầu: đã chạy migration_v2_auth.sql trước đó.
-- =====================================================================

-- 1. Hạn mức số trang OCR mỗi tháng theo gói cước
alter table plans add column if not exists max_ocr_pages_per_month int not null default 50;

update plans set max_ocr_pages_per_month = 50    where code = 'free'     and max_ocr_pages_per_month = 50;
update plans set max_ocr_pages_per_month = 2000  where code = 'pro';
update plans set max_ocr_pages_per_month = 20000 where code = 'business';

-- 2. Thông tin OCR trên từng tài liệu
--    extraction_method: text (đọc text thật) | ocr (nhận dạng ảnh) | mixed
alter table documents add column if not exists extraction_method text default 'text';
alter table documents add column if not exists ocr_pages int default 0;
alter table documents add column if not exists page_count int default 0;

-- Trạng thái documents.status nay có thêm giá trị 'ocr_processing'
-- (cột là text không có ràng buộc check nên không cần đổi gì thêm)

create index if not exists documents_status_idx on documents (status);

-- 3. Đếm số trang OCR đã dùng trong tháng của một tổ chức
create or replace function org_ocr_pages_this_month(match_org_id uuid)
returns bigint
language sql stable
as $$
  select coalesce(sum(ocr_pages), 0)::bigint
  from documents
  where organization_id = match_org_id
    and created_at >= date_trunc('month', now());
$$;

-- 4. Thống kê OCR toàn hệ thống cho console admin hệ thống
create or replace function admin_ocr_summary()
returns table (
  total_ocr_documents bigint,
  total_ocr_pages bigint,
  ocr_pages_this_month bigint
)
language sql stable
as $$
  select
    count(*) filter (where extraction_method = 'ocr')::bigint,
    coalesce(sum(ocr_pages), 0)::bigint,
    coalesce(sum(ocr_pages) filter (where created_at >= date_trunc('month', now())), 0)::bigint
  from documents;
$$;
