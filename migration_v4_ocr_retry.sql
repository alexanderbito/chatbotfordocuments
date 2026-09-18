-- =====================================================================
-- MIGRATION V4 — Thử lại OCR khi Gemini quá tải
-- Chạy trong Supabase Dashboard > SQL Editor > New query > Run
-- An toàn khi chạy lại nhiều lần. Yêu cầu đã chạy migration_v3_ocr.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- KIỂM TRA ĐIỀU KIỆN: dừng sớm với thông báo rõ ràng nếu chạy sai thứ tự
-- ---------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.documents') is null then
    raise exception E'Thieu bang "documents".\n=> Ban chua chay supabase_schema.sql va migration_v2_auth.sql.';
  end if;
end
$guard$;

-- 1. Đếm số lần đã thử OCR một tài liệu và thời điểm dự kiến thử lại
alter table documents add column if not exists ocr_attempts int not null default 0;
alter table documents add column if not exists next_retry_at timestamptz;

-- 2. Lưu tạm kết quả nhận dạng của từng lô trang.
--    Nhờ bảng này, khi một lô lỗi giữa chừng thì lần thử lại chỉ làm phần còn thiếu,
--    không gọi lại Gemini cho những trang đã nhận dạng xong (tiết kiệm thời gian và chi phí).
create table if not exists document_ocr_batches (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  from_page int not null,
  to_page int not null,
  content text not null,
  model text,
  created_at timestamptz not null default now()
);

create unique index if not exists document_ocr_batches_doc_range_idx
  on document_ocr_batches (document_id, from_page, to_page);

alter table document_ocr_batches enable row level security;

-- 3. Dọn các lô tạm cũ hơn 7 ngày của tài liệu đã xong hoặc đã bỏ
--    (gọi thủ công khi cần, hoặc gắn vào cron của Supabase)
create or replace function cleanup_ocr_batches()
returns int
language sql
as $$
  with deleted as (
    delete from document_ocr_batches b
    using documents d
    where b.document_id = d.id
      and (d.status = 'ready' or b.created_at < now() - interval '7 days')
    returning b.id
  )
  select count(*)::int from deleted;
$$;
