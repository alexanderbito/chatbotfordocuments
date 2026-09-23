-- =====================================================================
-- MIGRATION V7 — 3-day trial; the trial plan has no OCR
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v6_payments.sql to have been run.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.plans') is null then
    raise exception E'Missing table "plans".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='plans' and column_name='price_usd') then
    raise exception E'Missing column "plans.price_usd".\n=> You have not run migration_v6_payments.sql yet.';
  end if;
end
$guard$;

-- 1. Number of trial days the plan grants (0 = not a trial plan)
alter table plans add column if not exists trial_days int not null default 0;

-- 2. Whether the plan is allowed to use scanned-PDF recognition
alter table plans add column if not exists ocr_enabled boolean not null default true;

-- 3. The trial plan: 3 days, NO OCR
update plans
set trial_days = 3,
    ocr_enabled = false,
    max_ocr_pages_per_month = 0,
    name = '3-day free trial',
    description = 'Every feature for 3 days. Scanned-PDF OCR is not included. After 3 days documents are deleted unless you upgrade.'
where code = 'free';

-- Paid plans keep OCR enabled
update plans set ocr_enabled = true, trial_days = 0 where code <> 'free';

-- 3b. English plan name and description (shown when the user selects English).
--     If these are left empty, the UI falls back to the default name and description.
alter table plans add column if not exists name_en text;
alter table plans add column if not exists description_en text;

update plans set
  name_en = 'Free trial',
  description_en = 'Every feature for 3 days, except scanned-PDF OCR. Documents are deleted after 3 days unless you upgrade.'
where code = 'free' and name_en is null;

update plans set
  name_en = 'Professional',
  description_en = 'For small and medium businesses'
where code = 'pro' and name_en is null;

update plans set
  name_en = 'Business',
  description_en = 'Generous limits and priority support'
where code = 'business' and name_en is null;

-- 4. Mark organizations whose data was purged after their trial expired
alter table organizations add column if not exists trial_data_purged_at timestamptz;
alter table organizations add column if not exists trial_started_at timestamptz;

-- Existing organizations still on trial with no expiry date get 3 days from now
update organizations o
set plan_expires_at = now() + interval '3 days',
    trial_started_at = coalesce(trial_started_at, now())
from plans p
where o.plan_id = p.id
  and p.code = 'free'
  and o.billing_status = 'trial'
  and o.plan_expires_at is null;

create index if not exists organizations_trial_expiry_idx
  on organizations (billing_status, plan_expires_at)
  where billing_status = 'trial';

-- 5. List the organizations whose trial has expired and whose data needs purging.
--    This only returns the list; deleting the files on R2 has to be done by the app,
--    so the real deletion lives in src/trials.js rather than in SQL.
create or replace function list_expired_trials(grace_hours int default 0)
returns table (
  organization_id uuid,
  organization_name text,
  expired_at timestamptz,
  document_count bigint
)
language sql stable
as $$
  select o.id, o.name, o.plan_expires_at,
         (select count(*) from documents d where d.organization_id = o.id)
  from organizations o
  join plans p on p.id = o.plan_id
  where p.trial_days > 0
    and o.billing_status = 'trial'
    and o.plan_expires_at is not null
    and o.plan_expires_at < now() - (grace_hours || ' hours')::interval
    and o.trial_data_purged_at is null
  order by o.plan_expires_at;
$$;

-- =====================================================================
-- NOTE: the trial plan is now limited to 3 days. Organizations already on this plan
-- without an expiry date get 3 days counted from the moment the migration runs; their
-- data is not deleted straight away.
-- =====================================================================
