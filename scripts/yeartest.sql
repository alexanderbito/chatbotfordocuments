-- =====================================================================
-- SQL regression suite for annual billing (migration v10)
-- =====================================================================
-- These checks exist because the failures they cover are invisible in the
-- application: a payment that grants the wrong number of months, a webhook
-- that grants them twice, or a migration that quietly puts a retired price
-- back on sale all look like normal operation from the outside.
--
-- Run against a THROWAWAY database — it writes rows and re-runs migrations.
-- It does not create the tables itself, so point it at a database that has
-- already had migrations v2 through v10 applied:
--
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/yeartest.sql
--
-- Every line it prints starts with OK or HONG (failed).
-- =====================================================================
\pset format unaligned
\pset tuples_only on

-- Clear anything a previous run left behind. Keyed on the fixed ids this file
-- uses rather than on the organization name: a half-finished run leaves rows
-- whose name may have been anything, and the inserts below would then fail on
-- the primary key instead of testing what they are meant to test.
do $cleanup$
declare v_orgs uuid[] := array[
  '11111111-1111-1111-1111-111111111111',
  'cccccccc-0000-0000-0000-000000000001'
]::uuid[];
begin
  delete from payments where organization_id = any(v_orgs);
  delete from organizations where id = any(v_orgs);
end
$cleanup$;

-- ---------------------------------------------------------------------
-- 1. A yearly payment grants twelve months, from today, on an expired plan.
-- ---------------------------------------------------------------------
insert into organizations (id, name, plan_id)
values ('11111111-1111-1111-1111-111111111111', 'ZZ test yearly', (select id from plans where code='free'));

insert into payments (id, organization_id, plan_id, amount, billing_cycle)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
        (select id from plans where code='pro'), 187, 'yearly');

select case when activate_paid_plan('22222222-2222-2222-2222-222222222222')
            then 'OK   kich hoat lan dau tra ve true' else 'HONG kich hoat lan dau tra ve false' end;

select case when plan_expires_at::date = (now() + interval '12 months')::date
            then 'OK   het han sau dung 12 thang'
            else 'HONG het han ' || plan_expires_at end
from organizations where id='11111111-1111-1111-1111-111111111111';

select case when period_end - period_start between 364 and 366
            then 'OK   ky dich vu tren hoa don dai mot nam'
            else 'HONG ky dai ' || (period_end - period_start) || ' ngay' end
from payments where id='22222222-2222-2222-2222-222222222222';

-- ---------------------------------------------------------------------
-- 2. The same webhook delivered twice must not add another year.
--    Gateways retry on a flaky connection; this is the common case, not a
--    rare one.
-- ---------------------------------------------------------------------
select case when activate_paid_plan('22222222-2222-2222-2222-222222222222') = false
            then 'OK   webhook lap lai tra ve false' else 'HONG webhook lap lai van kich hoat' end;

select case when plan_expires_at::date = (now() + interval '12 months')::date
            then 'OK   webhook lap lai khong cong them nam nao'
            else 'HONG het han nhay len ' || plan_expires_at end
from organizations where id='11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------
-- 3. A monthly payment on top of a live yearly plan stacks on the end of it;
--    the customer must not lose the time already paid for.
-- ---------------------------------------------------------------------
insert into payments (id, organization_id, plan_id, amount, billing_cycle)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        (select id from plans where code='pro'), 19, 'monthly');
select activate_paid_plan('33333333-3333-3333-3333-333333333333');

select case when plan_expires_at::date = (now() + interval '13 months')::date
            then 'OK   thang mua them cong vao cuoi ky nam'
            else 'HONG het han ' || plan_expires_at end
from organizations where id='11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------
-- 4. A row written before this migration has no cycle at all, and must be
--    treated as monthly rather than as nothing.
-- ---------------------------------------------------------------------
insert into payments (id, organization_id, plan_id, amount)
values ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
        (select id from plans where code='pro'), 19);
select activate_paid_plan('44444444-4444-4444-4444-444444444444');

select case when plan_expires_at::date = (now() + interval '14 months')::date
            then 'OK   ban ghi cu mac dinh la mot thang'
            else 'HONG het han ' || plan_expires_at end
from organizations where id='11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------
-- 5. The column refuses any cycle we do not sell.
-- ---------------------------------------------------------------------
do $$
begin
  begin
    insert into payments (organization_id, amount, billing_cycle)
    values ('11111111-1111-1111-1111-111111111111', 1, 'lifetime');
    raise notice 'HONG chap nhan chu ky "lifetime"';
  exception when check_violation then
    raise notice 'OK   tu choi chu ky khong hop le';
  end;
end
$$;

-- ---------------------------------------------------------------------
-- 6. The two-argument form is gone, so nothing can name its own number of
--    months and buy a decade for one month's money.
-- ---------------------------------------------------------------------
do $$
begin
  begin
    perform activate_paid_plan('44444444-4444-4444-4444-444444444444', 120);
    raise notice 'HONG van goi duoc ban hai tham so';
  exception when undefined_function then
    raise notice 'OK   ban hai tham so da bi go bo';
  end;
end
$$;

select case when count(*) = 1 and min(pg_get_function_arguments(oid)) = 'p_payment_id uuid'
            then 'OK   chi ton tai mot ban activate_paid_plan'
            else 'HONG co ' || count(*) || ' ban: ' || string_agg(pg_get_function_arguments(oid), ' | ') end
from pg_proc where proname = 'activate_paid_plan';

-- ---------------------------------------------------------------------
-- 7. Paying reopens a suspended organization and moves it to the new plan.
-- ---------------------------------------------------------------------
update organizations set status='suspended' where id='11111111-1111-1111-1111-111111111111';
insert into payments (id, organization_id, plan_id, amount, billing_cycle)
values ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111',
        (select id from plans where code='business'), 777, 'yearly');
select activate_paid_plan('55555555-5555-5555-5555-555555555555');

select case when status='active' and billing_status='paid'
              and plan_id = (select id from plans where code='business')
            then 'OK   tra tien mo lai tai khoan bi khoa va doi sang goi moi'
            else 'HONG status=' || status || ' billing=' || billing_status end
from organizations where id='11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------
-- 8. "Mark as received" in the system-admin console.
--
--    This grants the time as part of marking the row, rather than stamping
--    paid_at on its own. An earlier version did the latter, and a pending
--    PayPal row marked received that way could never be activated again: the
--    webhook arrived, saw paid_at, and returned quietly. The customer had
--    paid and the plan had not moved, with nothing left to repair it.
-- ---------------------------------------------------------------------
insert into organizations (id, name, plan_id)
values ('cccccccc-0000-0000-0000-000000000001', 'ZZ test marked', (select id from plans where code='free'));
insert into payments (id, organization_id, plan_id, amount, billing_cycle, status, provider)
values ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001',
        (select id from plans where code='pro'), 187, 'yearly', 'pending', 'paypal');

select case when activate_paid_plan('dddddddd-0000-0000-0000-000000000001')
            then 'OK   danh dau da nhan la kich hoat luon' else 'HONG' end;
select case when plan_expires_at::date = (now() + interval '12 months')::date
            then 'OK   danh dau da nhan co cong du 12 thang'
            else 'HONG khong cong thang nao: ' || coalesce(plan_expires_at::text, 'null') end
from organizations where id='cccccccc-0000-0000-0000-000000000001';
select case when paid_at is not null and status = 'paid'
            then 'OK   co paid_at nen tai duoc hoa don' else 'HONG thieu paid_at' end
from payments where id='dddddddd-0000-0000-0000-000000000001';
select case when activate_paid_plan('dddddddd-0000-0000-0000-000000000001') = false
            then 'OK   webhook den sau khong cong them nam nua' else 'HONG' end;

-- ---------------------------------------------------------------------
-- Tidy up
-- ---------------------------------------------------------------------
delete from payments where organization_id in (
  select id from organizations where id in (
    '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001'));
delete from organizations where id in (
  '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001');
select 'het.';
