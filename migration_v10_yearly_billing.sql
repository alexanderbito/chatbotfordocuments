-- =====================================================================
-- MIGRATION V10 — Annual billing (12 months paid up front, 18% off)
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v9_invoices.sql.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.plans') is null then
    raise exception E'Missing table "plans".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
  if to_regclass('public.payments') is null then
    raise exception E'Missing table "payments".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_name = 'plans' and column_name = 'price_usd') then
    raise exception E'Missing column plans.price_usd.\n=> You have not run migration_v6_payments.sql yet.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------
-- 1. The yearly price is stored, not derived.
--
--    The discount could have been a percentage in the code, but then every
--    change to it would need a deploy, and — worse — the price a customer was
--    shown would be recomputed on every page load. A stored price is a fact:
--    it is what the customer sees, what the checkout charges and what the
--    invoice says, and a system admin can change it in /sysadmin.html.
--
--    0 means "this plan is not sold yearly" — that is how the free trial and
--    any future month-only plan opt out.
-- ---------------------------------------------------------------------
-- The seeding runs only on the pass that actually adds the column.
--
-- "where price_usd_yearly = 0" looked like the safe guard and was not: 0 is
-- also how a system admin says "sell this plan monthly only", so re-running the
-- file would have quietly put those plans back on sale yearly. Tying the seed
-- to the column's creation means it happens exactly once, whatever an admin
-- does to the prices afterwards.
do $seed$
declare v_fresh boolean;
begin
  v_fresh := not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'plans' and column_name = 'price_usd_yearly'
  );

  alter table plans add column if not exists price_usd_yearly numeric(10,2) not null default 0;

  if v_fresh then
    -- 18% off twelve months, rounded to whole dollars.
    update plans set price_usd_yearly = round(price_usd * 12 * 0.82) where price_usd > 0;
    raise notice 'Seeded yearly prices at 18%% off.';
  else
    raise notice 'plans.price_usd_yearly already existed — prices left exactly as they are.';
  end if;
end
$seed$;

comment on column plans.price_usd_yearly is
  'Price for 12 months paid up front, in USD. 0 = this plan is monthly only.';

-- ---------------------------------------------------------------------
-- 2. Every payment records which cycle was bought.
--
--    This is what decides how much time the payment buys. Keeping it on the
--    payment rather than on the organization means the history stays truthful:
--    an organization that paid monthly last year and yearly this year has two
--    rows that each still say what was actually sold.
-- ---------------------------------------------------------------------
alter table payments add column if not exists billing_cycle text not null default 'monthly';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_billing_cycle_check') then
    alter table payments add constraint payments_billing_cycle_check
      check (billing_cycle in ('monthly', 'yearly'));
  end if;
end
$$;

comment on column payments.billing_cycle is
  'monthly = 1 month, yearly = 12 months. Decides the period the payment buys.';

-- ---------------------------------------------------------------------
-- 3. The number of months now comes from the payment row, not from the caller.
--
--    Before, activate_paid_plan took p_months from whoever called it. Nothing
--    in the database checked it against the amount that was actually charged,
--    so a bug (or a crafted call) could have bought ten years for the price of
--    one month. Reading the cycle off the payment row closes that: the row was
--    written at checkout, in the same transaction that fixed the price.
--
--    The old two-argument version is dropped rather than left in place, so no
--    caller can keep using it by accident.
-- ---------------------------------------------------------------------
drop function if exists activate_paid_plan(uuid, int);
drop function if exists activate_paid_plan(uuid);

create function activate_paid_plan(p_payment_id uuid)
returns boolean
language plpgsql
as $$
declare
  v_payment        payments%rowtype;
  v_current_expiry timestamptz;
  v_base           timestamptz;
  v_months         int;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment transaction % not found', p_payment_id;
  end if;

  -- Already recorded, so stop here rather than adding more time a second time.
  -- Only paid_at is checked: that column is written solely inside this function,
  -- which makes it the one trustworthy marker. Bringing status into the check
  -- would let a wrong status update elsewhere extend a plan twice.
  if v_payment.paid_at is not null then
    return false;
  end if;

  v_months := case when v_payment.billing_cycle = 'yearly' then 12 else 1 end;

  select plan_expires_at into v_current_expiry
  from organizations where id = v_payment.organization_id;

  -- If the plan is still valid, stack the new period on top; if it expired,
  -- count from today. A customer who switches from monthly to yearly therefore
  -- keeps the days they already paid for.
  v_base := greatest(coalesce(v_current_expiry, now()), now());

  update organizations
  set plan_id         = coalesce(v_payment.plan_id, plan_id),
      billing_status  = 'paid',
      plan_expires_at = v_base + (v_months || ' months')::interval,
      status          = case when status = 'suspended' then 'active' else status end
  where id = v_payment.organization_id;

  update payments
  set status       = 'paid',
      paid_at      = now(),
      period_start = coalesce(period_start, v_base::date),
      period_end   = coalesce(period_end, (v_base + (v_months || ' months')::interval)::date)
  where id = p_payment_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. What the prices ended up as
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  raise notice '--- Plan prices after migration v10 ---';
  for r in
    select name,
           price_usd,
           price_usd_yearly,
           case when price_usd > 0 and price_usd_yearly > 0
                then round((1 - price_usd_yearly / (price_usd * 12)) * 100)
                else null end as saving_pct
    from plans order by sort_order
  loop
    if r.price_usd_yearly > 0 then
      raise notice '% : $%/month, $%/year (% percent off)',
        rpad(r.name, 14), r.price_usd, r.price_usd_yearly, r.saving_pct;
    else
      raise notice '% : $%/month, no yearly price', rpad(r.name, 14), r.price_usd;
    end if;
  end loop;
end
$$;
