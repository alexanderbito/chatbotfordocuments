-- =====================================================================
-- v8 — Move the plan catalogue to English
--
-- Why this exists: the product now ships in English only, but plans.name and
-- plans.description still hold whatever text was inserted when the database
-- was first seeded. Editing the earlier migration files does not change rows
-- that already exist, and v7's seeding is guarded by "where name_en is null",
-- so re-running it changes nothing either. The plan name is read straight from
-- the database and rendered on the pricing page, the sign-up page and the
-- "Current plan" card, which is why a stale row shows through there.
--
-- What it does: promotes the English text v7 wrote into name_en/description_en
-- so it becomes the one and only name. Rows where name_en was never filled in
-- are left untouched and reported at the end, so a plan you named yourself is
-- never silently overwritten.
--
-- Run it in the Supabase SQL Editor after v7. Safe to run more than once.
-- =====================================================================

do $guard$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'plans' and column_name = 'name_en') then
    raise exception
      'Run migration_v7_trial.sql first: the plans.name_en column does not exist yet. If you are unsure which migration the database is at, run kiem_tra_migration.sql.';
  end if;
end
$guard$;

-- 1. Promote the English text to the primary name and description.
update plans
set name        = name_en,
    description = coalesce(description_en, description)
where name_en is not null
  and name_en <> ''
  and (name is distinct from name_en
       or description is distinct from coalesce(description_en, description));

-- 2. Report what was, and was not, converted.
do $report$
declare
  leftover text;
begin
  select string_agg(code, ', ' order by sort_order)
    into leftover
    from plans
   where name_en is null or name_en = '';

  if leftover is null then
    raise notice 'All plans now use their English name and description.';
  else
    raise notice 'These plans have no English name and were left as they are: %. Edit them on the Plans page of the system admin console.', leftover;
  end if;
end
$report$;

-- 3. name_en and description_en are no longer read by the application. They are
--    kept rather than dropped so this migration can be checked afterwards and,
--    if something looks wrong, the previous values are still available. Once
--    you are satisfied, they can be removed with:
--
--    alter table plans drop column if exists name_en;
--    alter table plans drop column if exists description_en;
