-- =====================================================================
-- SQL regression suite for the public API (migration v12)
-- =====================================================================
-- The guarantees checked here are the ones the application cannot show you,
-- because the application always holds the service-role key and therefore
-- always succeeds. What matters is what happens WITHOUT that key: nobody
-- holding the public anon key may read a key hash or another customer's call
-- history.
--
-- Run against a THROWAWAY database with migrations v2 to v12 applied:
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/apitest.sql
--
-- Every line it prints starts with OK or HONG (failed).
-- =====================================================================
\pset format unaligned
\pset tuples_only on

do $cleanup$
declare v_orgs uuid[] := array[
  'aaaaaaaa-0000-0000-0000-0000000000a1',
  'aaaaaaaa-0000-0000-0000-0000000000a2'
]::uuid[];
begin
  delete from api_usage where organization_id = any(v_orgs);
  delete from api_keys  where organization_id = any(v_orgs);
  delete from organizations where id = any(v_orgs);
end
$cleanup$;

insert into organizations (id, name, plan_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'ZZ api one', (select id from plans where code='business')),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'ZZ api two', (select id from plans where code='business'));

-- ---------------------------------------------------------------------
-- 1. The plan columns exist and mean two different things.
-- ---------------------------------------------------------------------
select case when count(*) = 2 then 'OK   plans co du hai cot api'
            else 'HONG thieu cot api tren bang plans' end
from information_schema.columns
where table_schema = 'public' and table_name = 'plans'
  and column_name in ('api_enabled', 'max_api_calls_per_month');

select case when api_enabled and max_api_calls_per_month > 0
            then 'OK   goi Business co API va co han muc'
            else 'HONG api_enabled=' || api_enabled || ' calls=' || max_api_calls_per_month end
from plans where code = 'business';

select case when not api_enabled then 'OK   goi Professional khong co API' else 'HONG' end
from plans where code = 'pro';

-- ---------------------------------------------------------------------
-- 2. Two keys can never share a hash.
-- ---------------------------------------------------------------------
insert into api_keys (organization_id, name, key_hash, key_prefix)
values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'first', repeat('a', 64), 'bck_aaaa');

do $$
begin
  begin
    insert into api_keys (organization_id, name, key_hash, key_prefix)
    values ('aaaaaaaa-0000-0000-0000-0000000000a2', 'clash', repeat('a', 64), 'bck_aaaa');
    raise notice 'HONG nhan hai khoa cung bang bam';
  exception when unique_violation then raise notice 'OK   tu choi hai khoa trung bang bam';
  end;
  begin
    insert into api_keys (organization_id, name, key_hash, key_prefix)
    values ('aaaaaaaa-0000-0000-0000-0000000000a1', '', repeat('b', 64), 'bck_bbbb');
    raise notice 'HONG nhan ten khoa rong';
  exception when check_violation then raise notice 'OK   chan ten khoa rong';
  end;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Row-level security: on, with no policy, on BOTH tables.
--    A key hash reaching the public anon key would be the worst outcome here.
-- ---------------------------------------------------------------------
do $$
declare r record; v_bad text := '';
begin
  for r in
    select c.relname,
           c.relrowsecurity as rls,
           (select count(*) from pg_policies p
             where p.schemaname = 'public' and p.tablename = c.relname) as pol
    from pg_class c
    where c.relname in ('api_keys', 'api_usage') and c.relnamespace = 'public'::regnamespace
  loop
    if not r.rls or r.pol > 0 then
      v_bad := v_bad || format('%s(rls=%s,pol=%s) ', r.relname, r.rls, r.pol);
    end if;
  end loop;
  if v_bad = '' then raise notice 'OK   ca hai bang bat RLS va khong co policy nao';
  else raise notice 'HONG %', v_bad;
  end if;
end
$$;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon;
grant select, insert, update, delete on api_keys, api_usage to anon;

begin;
set local role anon;
select case when count(*) = 0 then 'OK   anon doc duoc 0 khoa du da cap quyen SELECT'
            else 'HONG anon doc duoc ' || count(*) || ' khoa' end from api_keys;
select case when count(*) = 0 then 'OK   anon doc duoc 0 dong lich su goi'
            else 'HONG anon doc duoc ' || count(*) || ' dong' end from api_usage;
do $$
begin
  begin
    insert into api_keys (organization_id, name, key_hash, key_prefix)
    values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'bot', repeat('c', 64), 'bck_cccc');
    raise notice 'HONG anon tu tao duoc khoa';
  exception when insufficient_privilege then raise notice 'OK   anon khong tao duoc khoa';
  end;
end
$$;
commit;

-- ---------------------------------------------------------------------
-- 4. Counting a call.
-- ---------------------------------------------------------------------
select case when record_api_call('aaaaaaaa-0000-0000-0000-0000000000a1',
              (select id from api_keys where key_hash = repeat('a', 64)), 'POST /v1/chat', 200, 120) = 1
            then 'OK   ghi nhan luot goi dau tien' else 'HONG' end;

select case when api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a1') = 1
            then 'OK   dem dung so luot trong thang' else 'HONG' end;

select case when last_used_at is not null then 'OK   cap nhat lan dung cuoi cua khoa' else 'HONG' end
from api_keys where key_hash = repeat('a', 64);

-- A failed call must not be charged: debugging an integration should not spend
-- the month's allowance.
select record_api_call('aaaaaaaa-0000-0000-0000-0000000000a1', null, 'POST /v1/chat', 400, 5);
select case when api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a1') = 1
            then 'OK   loi 4xx khong bi tinh vao han muc'
            else 'HONG dem ra ' || api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a1') end;

-- One organization's usage must never show up in another's count.
select record_api_call('aaaaaaaa-0000-0000-0000-0000000000a2', null, 'GET /v1/me', 200, 8);
select case when api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a1') = 1
             and api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a2') = 1
            then 'OK   moi doanh nghiep dem rieng'
            else 'HONG a1=' || api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a1')
                 || ' a2=' || api_calls_this_month('aaaaaaaa-0000-0000-0000-0000000000a2') end;

-- ---------------------------------------------------------------------
-- 5. Revoking a key keeps its history.
--    "Which key made those forty thousand calls" is exactly the question asked
--    after a key has been revoked in a hurry.
-- ---------------------------------------------------------------------
update api_keys set revoked_at = now() where key_hash = repeat('a', 64);
select case when count(*) = 1 then 'OK   thu hoi khoa van giu lich su goi' else 'HONG' end
from api_usage
where api_key_id = (select id from api_keys where key_hash = repeat('a', 64));

-- Deleting a key later must not take its usage rows with it.
delete from api_keys where key_hash = repeat('a', 64);
select case when count(*) = 1 then 'OK   xoa khoa van giu lich su (api_key_id thanh null)' else 'HONG' end
from api_usage where organization_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and status = 200;

-- ---------------------------------------------------------------------
-- 6. Deleting an organization takes its keys and its usage with it.
-- ---------------------------------------------------------------------
insert into api_keys (organization_id, name, key_hash, key_prefix)
values ('aaaaaaaa-0000-0000-0000-0000000000a2', 'doomed', repeat('d', 64), 'bck_dddd');
delete from organizations where id = 'aaaaaaaa-0000-0000-0000-0000000000a2';
select case when count(*) = 0 then 'OK   xoa doanh nghiep thi xoa het khoa cua ho' else 'HONG' end
from api_keys where organization_id = 'aaaaaaaa-0000-0000-0000-0000000000a2';
select case when count(*) = 0 then 'OK   xoa doanh nghiep thi xoa het lich su goi' else 'HONG' end
from api_usage where organization_id = 'aaaaaaaa-0000-0000-0000-0000000000a2';

-- ---------------------------------------------------------------------
-- 7. Housekeeping keeps thirteen months.
-- ---------------------------------------------------------------------
insert into api_usage (organization_id, endpoint, status, created_at)
values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'GET /v1/me', 200, now() - interval '14 months');
insert into api_usage (organization_id, endpoint, status, created_at)
values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'GET /v1/me', 200, now() - interval '12 months');
select case when cleanup_api_usage() >= 1 then 'OK   don dep xoa dong qua 13 thang' else 'HONG' end;
select case when count(*) = 1 then 'OK   dong 12 thang truoc van con, de so sanh cung ky nam ngoai' else 'HONG con ' || count(*) end
from api_usage
where organization_id = 'aaaaaaaa-0000-0000-0000-0000000000a1'
  and created_at < now() - interval '6 months';

delete from api_usage where organization_id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
delete from api_keys  where organization_id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
delete from organizations where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
select 'het.';
