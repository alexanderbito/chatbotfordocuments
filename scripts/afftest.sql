-- =====================================================================
-- SQL regression suite for the affiliate programme and subscriptions (v13)
-- =====================================================================
-- These checks cover the statements that move money. The application cannot
-- demonstrate any of them: it always holds the service-role key, so it always
-- succeeds, and a commission paid twice looks exactly like one paid once until
-- somebody adds up the payouts.
--
-- Run against a THROWAWAY database with migrations v2 to v13 applied:
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/afftest.sql
--
-- Every line it prints starts with OK or HONG (failed).
-- =====================================================================
\pset format unaligned
\pset tuples_only on
\set ON_ERROR_STOP on

-- Clean slate
delete from commissions where organization_id in (select id from organizations where name like 'ZZ aff%');
delete from referrals where organization_id in (select id from organizations where name like 'ZZ aff%');
delete from payments where organization_id in (select id from organizations where name like 'ZZ aff%');
delete from organization_members where organization_id in (select id from organizations where name like 'ZZ aff%');
delete from organizations where name like 'ZZ aff%';
delete from affiliate_payouts where affiliate_id in (select id from affiliates where code like 'zztest%');
delete from affiliates where code like 'zztest%';
delete from auth.users where id in ('11111111-aaaa-0000-0000-000000000001','11111111-aaaa-0000-0000-000000000002');

insert into auth.users (id) values
 ('11111111-aaaa-0000-0000-000000000001'),  -- the affiliate
 ('11111111-aaaa-0000-0000-000000000002');  -- somebody else
insert into affiliates (id, user_id, code) values
 ('22222222-aaaa-0000-0000-000000000001','11111111-aaaa-0000-0000-000000000001','zztest-alex');

insert into organizations (id, name, owner_id, plan_id) values
 ('33333333-aaaa-0000-0000-000000000001','ZZ aff referred','11111111-aaaa-0000-0000-000000000002',(select id from plans where code='pro')),
 ('33333333-aaaa-0000-0000-000000000002','ZZ aff own','11111111-aaaa-0000-0000-000000000001',(select id from plans where code='pro')),
 ('33333333-aaaa-0000-0000-000000000003','ZZ aff noref','11111111-aaaa-0000-0000-000000000002',(select id from plans where code='pro')),
 -- The affiliate's OWN company. Taking part requires being a paying customer,
 -- so without this nobody in this file earns anything.
 ('33333333-aaaa-0000-0000-000000000009','ZZ aff home','11111111-aaaa-0000-0000-000000000001',(select id from plans where code='pro'));
update organizations
   set billing_status = 'paid', plan_expires_at = now() + interval '30 days'
 where id = '33333333-aaaa-0000-0000-000000000009';
insert into organization_members (organization_id, user_id, role)
values ('33333333-aaaa-0000-0000-000000000009','11111111-aaaa-0000-0000-000000000001','admin');

insert into referrals (organization_id, affiliate_id) values
 ('33333333-aaaa-0000-0000-000000000001','22222222-aaaa-0000-0000-000000000001'),
 ('33333333-aaaa-0000-0000-000000000002','22222222-aaaa-0000-0000-000000000001');

-- 1. Monthly payment -> 20%
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-000000000001','33333333-aaaa-0000-0000-000000000001',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-000000000001') is not null
            then 'OK   ghi nhan hoa hong cho thanh toan thang' else 'HONG' end;
select case when rate = 0.20 and amount = 3.80
            then 'OK   thang an 20% cua $19 = $3.80'
            else 'HONG rate=' || rate || ' amount=' || amount end
from commissions where payment_id = '44444444-aaaa-0000-0000-000000000001';

-- 2. Yearly payment -> 30%
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-000000000002','33333333-aaaa-0000-0000-000000000001',187,'USD','yearly','paid',now());
select record_commission('44444444-aaaa-0000-0000-000000000002');
select case when rate = 0.30 and amount = 56.10
            then 'OK   nam an 30% cua $187 = $56.10'
            else 'HONG rate=' || rate || ' amount=' || amount end
from commissions where payment_id = '44444444-aaaa-0000-0000-000000000002';

-- 3. The same webhook twice must not pay twice.
select case when record_commission('44444444-aaaa-0000-0000-000000000001') is null
            then 'OK   goi lai khong sinh hoa hong thu hai' else 'HONG' end;
select case when count(*) = 2 then 'OK   van chi co 2 dong hoa hong' else 'HONG co ' || count(*) end
from commissions where affiliate_id = '22222222-aaaa-0000-0000-000000000001';

-- 4. An affiliate never earns from an organization they own.
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-000000000003','33333333-aaaa-0000-0000-000000000002',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-000000000003') is null
            then 'OK   khong an hoa hong tu to chuc minh so huu' else 'HONG' end;

-- ... nor one they administer.
update organizations set owner_id = '11111111-aaaa-0000-0000-000000000002'
 where id = '33333333-aaaa-0000-0000-000000000002';
insert into organization_members (organization_id, user_id, role)
values ('33333333-aaaa-0000-0000-000000000002','11111111-aaaa-0000-0000-000000000001','admin');
delete from payments where id = '44444444-aaaa-0000-0000-000000000003';
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-000000000003','33333333-aaaa-0000-0000-000000000002',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-000000000003') is null
            then 'OK   khong an hoa hong tu to chuc minh quan tri' else 'HONG' end;

-- 5. No referral, no commission.
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-000000000004','33333333-aaaa-0000-0000-000000000003',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-000000000004') is null
            then 'OK   khong co nguoi gioi thieu thi khong co hoa hong' else 'HONG' end;

-- 6. An unpaid payment earns nothing.
insert into payments (id, organization_id, amount, currency, billing_cycle, status)
values ('44444444-aaaa-0000-0000-000000000005','33333333-aaaa-0000-0000-000000000001',19,'USD','monthly','pending');
select case when record_commission('44444444-aaaa-0000-0000-000000000005') is null
            then 'OK   chua nhan tien thi chua co hoa hong' else 'HONG' end;

-- 7. A suspended affiliate stops earning.
update affiliates set status = 'suspended' where id = '22222222-aaaa-0000-0000-000000000001';
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-000000000006','33333333-aaaa-0000-0000-000000000001',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-000000000006') is null
            then 'OK   affiliate bi dinh chi khong an hoa hong nua' else 'HONG' end;
update affiliates set status = 'active' where id = '22222222-aaaa-0000-0000-000000000001';

-- 8. The hold period: nothing is payable on the day it is earned.
select case when available_amount = 0 and pending_amount = 59.90
            then 'OK   moi kiem duoc thi chua rut duoc, dang cho: $59.90'
            else 'HONG cho=' || pending_amount || ' rut duoc=' || available_amount end
from affiliate_balance('22222222-aaaa-0000-0000-000000000001');

select case when referred_count = 2 and paying_count = 1
            then 'OK   dem dung so nguoi gioi thieu va so nguoi da tra tien'
            else 'HONG gioi thieu=' || referred_count || ' da tra=' || paying_count end
from affiliate_balance('22222222-aaaa-0000-0000-000000000001');

do $$ begin
  begin
    perform pay_affiliate('22222222-aaaa-0000-0000-000000000001','paypal','x',null,null);
    raise notice 'HONG chi tra duoc khi chua het thoi gian giu';
  exception when others then raise notice 'OK   tu choi chi tra khi chua het thoi gian giu';
  end;
end $$;

-- 9. Past the hold, it becomes payable and a payout takes all of it, once.
update commissions set available_at = now() - interval '1 day'
 where affiliate_id = '22222222-aaaa-0000-0000-000000000001';
select case when available_amount = 59.90 then 'OK   het thoi gian giu thi rut duoc $59.90'
            else 'HONG rut duoc ' || available_amount end
from affiliate_balance('22222222-aaaa-0000-0000-000000000001');

select case when out_amount = 59.90 and out_commission_count = 2
            then 'OK   chi tra gop dung 2 dong, tong $59.90'
            else 'HONG tong=' || out_amount || ' so dong=' || out_commission_count end
from pay_affiliate('22222222-aaaa-0000-0000-000000000001','paypal','TX-1','first payout',null);

select case when available_amount = 0 and paid_amount = 59.90
            then 'OK   chi tra xong thi so du ve 0 va chuyen sang da tra'
            else 'HONG rut duoc=' || available_amount || ' da tra=' || paid_amount end
from affiliate_balance('22222222-aaaa-0000-0000-000000000001');

select case when count(*) = 2 and count(distinct payout_id) = 1
            then 'OK   moi hoa hong gan vao dung mot dot chi tra' else 'HONG' end
from commissions where affiliate_id = '22222222-aaaa-0000-0000-000000000001' and status = 'paid';

do $$ begin
  begin
    perform pay_affiliate('22222222-aaaa-0000-0000-000000000001','paypal','TX-2',null,null);
    raise notice 'HONG chi tra duoc lan thu hai khi khong con gi';
  exception when others then raise notice 'OK   khong chi tra lan hai khi so du bang 0';
  end;
end $$;

-- 10. The code alphabet is enforced.
do $$ begin
  begin
    insert into affiliates (user_id, code) values ('11111111-aaaa-0000-0000-000000000002','Bad Code!');
    raise notice 'HONG nhan ma gioi thieu co ky tu la';
  exception when check_violation then raise notice 'OK   chan ma gioi thieu co ky tu la';
  end;
  begin
    insert into affiliates (user_id, code) values ('11111111-aaaa-0000-0000-000000000002','zztest-alex');
    raise notice 'HONG nhan hai affiliate cung ma';
  exception when unique_violation then raise notice 'OK   chan hai affiliate trung ma';
  end;
end $$;

-- 11. An organization is introduced once and never reassigned.
insert into affiliates (id, user_id, code) values
 ('22222222-aaaa-0000-0000-000000000002','11111111-aaaa-0000-0000-000000000002','zztest-sam');
do $$ begin
  begin
    insert into referrals (organization_id, affiliate_id)
    values ('33333333-aaaa-0000-0000-000000000001','22222222-aaaa-0000-0000-000000000002');
    raise notice 'HONG mot to chuc bi gan cho hai nguoi gioi thieu';
  exception when unique_violation then raise notice 'OK   mot to chuc chi thuoc ve mot nguoi gioi thieu';
  end;
end $$;

-- 12. Only the server reaches these tables.
do $$
declare r record; v_bad text := '';
begin
  for r in
    select c.relname, c.relrowsecurity as rls,
           (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as pol
    from pg_class c
    where c.relname in ('affiliates','referrals','commissions','affiliate_payouts','subscriptions')
      and c.relnamespace = 'public'::regnamespace
  loop
    if not r.rls or r.pol > 0 then v_bad := v_bad || format('%s(rls=%s,pol=%s) ', r.relname, r.rls, r.pol); end if;
  end loop;
  if v_bad = '' then raise notice 'OK   ca 5 bang bat RLS va khong co policy nao';
  else raise notice 'HONG %', v_bad; end if;
end $$;

-- Grant the anon role everything it could possibly have, then show it still
-- sees nothing. Without the grant the test would pass because of a missing
-- privilege rather than because RLS works.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
grant usage on schema public to anon;
grant select, insert, update, delete on affiliates, referrals, commissions, affiliate_payouts, subscriptions to anon;

begin;
set local role anon;
select case when count(*) = 0 then 'OK   anon doc duoc 0 dong hoa hong du da cap quyen' else 'HONG doc duoc ' || count(*) end from commissions;
select case when count(*) = 0 then 'OK   anon doc duoc 0 dong affiliate' else 'HONG' end from affiliates;
select case when count(*) = 0 then 'OK   anon doc duoc 0 dong subscription' else 'HONG' end from subscriptions;
commit;

-- 12b. An affiliate whose own subscription has lapsed stops earning.
--
--      The programme is for customers. Somebody who cancels their own plan and
--      keeps sending referrals is not one, and the check has to live in the
--      function rather than only in the page that shows the link.
update organizations set billing_status = 'trial'
 where id = '33333333-aaaa-0000-0000-000000000009';
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-00000000000b','33333333-aaaa-0000-0000-000000000001',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-00000000000b') is null
            then 'OK   goi cua chinh affiliate het han thi khong an hoa hong moi' else 'HONG' end;

-- An expired paid plan counts as lapsed too, not only a cancelled one.
update organizations set billing_status = 'paid', plan_expires_at = now() - interval '1 day'
 where id = '33333333-aaaa-0000-0000-000000000009';
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-00000000000c','33333333-aaaa-0000-0000-000000000001',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-00000000000c') is null
            then 'OK   goi da qua han cung khong an hoa hong moi' else 'HONG' end;

-- ...and paying again restores it, without touching what was already earned.
update organizations set billing_status = 'paid', plan_expires_at = now() + interval '30 days'
 where id = '33333333-aaaa-0000-0000-000000000009';
insert into payments (id, organization_id, amount, currency, billing_cycle, status, paid_at)
values ('44444444-aaaa-0000-0000-00000000000d','33333333-aaaa-0000-0000-000000000001',19,'USD','monthly','paid',now());
select case when record_commission('44444444-aaaa-0000-0000-00000000000d') is not null
            then 'OK   tra tien lai thi an hoa hong tro lai' else 'HONG' end;

-- 13. One live subscription per organization at a time.
insert into subscriptions (organization_id, provider_ref, status)
values ('33333333-aaaa-0000-0000-000000000001','I-SUB1','active');
do $$ begin
  begin
    insert into subscriptions (organization_id, provider_ref, status)
    values ('33333333-aaaa-0000-0000-000000000001','I-SUB2','pending');
    raise notice 'HONG mot to chuc co hai subscription dang chay';
  exception when unique_violation then raise notice 'OK   moi to chuc chi mot subscription dang chay';
  end;
end $$;
update subscriptions set status = 'cancelled' where provider_ref = 'I-SUB1';
insert into subscriptions (organization_id, provider_ref, status)
values ('33333333-aaaa-0000-0000-000000000001','I-SUB2','pending');
select case when count(*) = 1 then 'OK   huy roi thi dang ky lai duoc' else 'HONG' end
from subscriptions where organization_id = '33333333-aaaa-0000-0000-000000000001' and status = 'pending';

select 'het.';
