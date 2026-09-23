-- =====================================================================
-- MIGRATION V3 — OCR for scanned PDFs (uses Gemini)
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once.
-- Requires: migration_v2_auth.sql must already have been run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRECONDITION CHECK: stop early with a clear message if the files are run out of order
-- ---------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.plans') is null then
    raise exception E'Missing table "plans".\n=> You have not run migration_v2_auth.sql yet. Run that file first, then come back to this one.\n=> If you are certain you already ran it: check that the SQL Editor is open on the same Supabase project that Render is using.';
  end if;
  if to_regclass('public.documents') is null then
    raise exception E'Missing table "documents".\n=> You have not run supabase_schema.sql yet. Run that file first.';
  end if;
end
$guard$;

-- 1. Monthly OCR page allowance per plan
alter table plans add column if not exists max_ocr_pages_per_month int not null default 50;

update plans set max_ocr_pages_per_month = 50    where code = 'free'     and max_ocr_pages_per_month = 50;
update plans set max_ocr_pages_per_month = 2000  where code = 'pro';
update plans set max_ocr_pages_per_month = 20000 where code = 'business';

-- 2. Per-document OCR information
--    extraction_method: text (real embedded text) | ocr (recognised from images) | mixed
alter table documents add column if not exists extraction_method text default 'text';
alter table documents add column if not exists ocr_pages int default 0;
alter table documents add column if not exists page_count int default 0;

-- documents.status now has one more possible value, 'ocr_processing'
-- (the column is plain text with no check constraint, so nothing else has to change)

create index if not exists documents_status_idx on documents (status);

-- 3. Count the OCR pages an organization has used during the current month
create or replace function org_ocr_pages_this_month(match_org_id uuid)
returns bigint
language sql stable
as $$
  select coalesce(sum(ocr_pages), 0)::bigint
  from documents
  where organization_id = match_org_id
    and created_at >= date_trunc('month', now());
$$;

-- 4. System-wide OCR statistics for the system admin console
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
