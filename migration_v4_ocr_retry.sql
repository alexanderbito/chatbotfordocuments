-- =====================================================================
-- MIGRATION V4 — Retrying OCR when Gemini is overloaded
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v3_ocr.sql to have been run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRECONDITION CHECK: stop early with a clear message if the files are run out of order
-- ---------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.documents') is null then
    raise exception E'Missing table "documents".\n=> You have not run supabase_schema.sql and migration_v2_auth.sql yet.';
  end if;
end
$guard$;

-- 1. Track how many OCR attempts a document has had, and when the next retry is due
alter table documents add column if not exists ocr_attempts int not null default 0;
alter table documents add column if not exists next_retry_at timestamptz;

-- 2. Temporary store for the recognition result of each batch of pages.
--    Thanks to this table, when a batch fails part-way through, the retry only redoes
--    the missing pages, never calling Gemini again for pages already recognised (saving time and cost).
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

-- 3. Clean up temporary batches older than 7 days for documents that finished or were abandoned
--    (call it manually when needed, or wire it into Supabase cron)
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
