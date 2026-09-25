-- =====================================================================
-- SQL regression suite for the contact inbox (migration v11)
-- =====================================================================
-- The control that matters here is negative: nobody holding the public anon
-- key may read a single message. That is invisible from the application, which
-- always uses the service-role key and therefore always succeeds, so it has to
-- be checked against the database directly.
--
-- Run against a THROWAWAY database that has had migrations v2 to v11 applied:
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/contacttest.sql
--
-- Every line it prints starts with OK or HONG (failed).
-- =====================================================================
\pset format unaligned
\pset tuples_only on

delete from contact_messages where email like '%@zz-test.invalid';

-- ---------------------------------------------------------------------
-- 1. A message is stored, unread.
-- ---------------------------------------------------------------------
insert into contact_messages (name, email, company, message, ip)
values ('Jane Smith', 'jane@zz-test.invalid', 'Acme', 'We would like a demo.', '203.0.113.9');

select case when status = 'new' and read_at is null
            then 'OK   tin moi mac dinh la chua doc'
            else 'HONG status=' || status end
from contact_messages where email = 'jane@zz-test.invalid';

-- ---------------------------------------------------------------------
-- 2. The length caps live in the column, not only in the route.
--    A route can be bypassed by a later refactor; a constraint cannot.
-- ---------------------------------------------------------------------
do $$
begin
  begin
    insert into contact_messages (name, email, message)
    values ('X', 'long@zz-test.invalid', repeat('x', 5001));
    raise notice 'HONG nhan tin nhan dai 5001 ky tu';
  exception when check_violation then raise notice 'OK   chan tin nhan qua dai';
  end;
  begin
    insert into contact_messages (name, email, message) values ('', 'empty@zz-test.invalid', 'hi');
    raise notice 'HONG nhan ten rong';
  exception when check_violation then raise notice 'OK   chan ten rong';
  end;
  begin
    insert into contact_messages (name, email, message, status)
    values ('X', 'bad@zz-test.invalid', 'hi', 'whatever');
    raise notice 'HONG nhan trang thai la';
  exception when check_violation then raise notice 'OK   chan trang thai khong hop le';
  end;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Row-level security: on, with no policy at all.
--    Anything else and the public anon key reads every message we receive.
-- ---------------------------------------------------------------------
do $$
declare v_rls boolean; v_pol int;
begin
  select relrowsecurity into v_rls from pg_class
   where relname = 'contact_messages' and relnamespace = 'public'::regnamespace;
  select count(*)::int into v_pol from pg_policies
   where schemaname = 'public' and tablename = 'contact_messages';
  if v_rls and v_pol = 0 then raise notice 'OK   RLS bat va khong co policy nao';
  else raise notice 'HONG rls=% policy=%', v_rls, v_pol;
  end if;
end
$$;

-- The real proof: grant the anon role every privilege it could possibly have,
-- then check it still sees nothing. SET LOCAL only takes effect inside a
-- transaction — outside one it is silently ignored and the query runs as the
-- owner, which is how an earlier version of this check passed for the wrong
-- reason.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon;
grant select, insert, update, delete on contact_messages to anon;

begin;
set local role anon;
select case when count(*) = 0
            then 'OK   anon doc duoc 0 dong du da cap quyen SELECT'
            else 'HONG anon doc duoc ' || count(*) || ' dong' end
from contact_messages;
do $$
begin
  begin
    insert into contact_messages (name, email, message) values ('Bot','bot@zz-test.invalid','spam');
    raise notice 'HONG anon ghi duoc vao bang';
  exception when insufficient_privilege then raise notice 'OK   anon khong ghi duoc';
  end;
  begin
    delete from contact_messages;
    raise notice 'OK   anon xoa duoc 0 dong (RLS chan)';
  exception when insufficient_privilege then raise notice 'OK   anon khong xoa duoc';
  end;
end
$$;
commit;

select case when count(*) >= 1 then 'OK   phia may chu (service role) van doc duoc' else 'HONG' end
from contact_messages where email like '%@zz-test.invalid';

-- ---------------------------------------------------------------------
-- 4. Housekeeping. Two different retentions on purpose: the address is only
--    needed to stop a flood, so it goes while the message stays; messages
--    marked as spam are deleted outright.
-- ---------------------------------------------------------------------
insert into contact_messages (name, email, message, ip, created_at)
values ('Old', 'old@zz-test.invalid', 'keep this', '198.51.100.4', now() - interval '40 days');
insert into contact_messages (name, email, message, status, created_at)
values ('Junk', 'junk@zz-test.invalid', 'buy pills', 'spam', now() - interval '40 days');
insert into contact_messages (name, email, message, status, created_at)
values ('Fresh junk', 'j2@zz-test.invalid', 'buy pills', 'spam', now() - interval '2 days');

select case when ips_cleared >= 1 and spam_deleted >= 1
            then 'OK   don dep xoa dia chi cu va spam cu'
            else 'HONG ips=' || ips_cleared || ' spam=' || spam_deleted end
from cleanup_contact_messages();

select case when ip is null and user_agent is null and message = 'keep this'
            then 'OK   xoa dia chi nhung giu nguyen tin nhan'
            else 'HONG ip=' || coalesce(ip, 'null') end
from contact_messages where email = 'old@zz-test.invalid';

select case when count(*) = 1 then 'OK   spam moi van con, chua den han xoa' else 'HONG con ' || count(*) end
from contact_messages where status = 'spam' and email like '%@zz-test.invalid';

select case when ip = '203.0.113.9' then 'OK   dia chi cua tin nhan moi chua bi xoa' else 'HONG' end
from contact_messages where email = 'jane@zz-test.invalid';

delete from contact_messages where email like '%@zz-test.invalid';
select 'het.';
