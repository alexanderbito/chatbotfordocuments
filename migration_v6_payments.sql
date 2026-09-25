-- =====================================================================
-- MIGRATION V6 — Multi-currency pricing and payment-gateway checkout
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v5_folder_acl.sql to have been run.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.plans') is null then
    raise exception E'Missing table "plans".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
  if to_regclass('public.payments') is null then
    raise exception E'Missing table "payments".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
end
$guard$;

-- 1. USD pricing for customers outside Vietnam
--    price_vnd stays as it is for domestic customers.
alter table plans add column if not exists price_usd numeric(10,2) not null default 0;

-- Suggested starting USD prices (a system admin can change them in /sysadmin.html)
update plans set price_usd = 0  where code = 'free'     and price_usd = 0;
update plans set price_usd = 19 where code = 'pro'      and price_usd = 0;
update plans set price_usd = 79 where code = 'business' and price_usd = 0;

-- 2. Each organization remembers its chosen billing country (VN uses VietQR, everyone else PayPal)
alter table organizations add column if not exists billing_country text default 'VN';

-- 3. Additional columns on the payments table
alter table payments add column if not exists provider text not null default 'manual';   -- payos | paypal | manual
alter table payments add column if not exists currency text not null default 'VND';      -- VND | USD
alter table payments add column if not exists amount numeric(14,2) not null default 0;   -- amount in the currency named above
alter table payments add column if not exists order_code bigint;                          -- payOS order code (an integer)
alter table payments add column if not exists provider_ref text;                          -- order/transaction id on the gateway side
alter table payments add column if not exists checkout_url text;
alter table payments add column if not exists paid_at timestamptz;
alter table payments add column if not exists raw jsonb;

-- Legacy rows: amount_vnd is the amount
update payments set amount = amount_vnd where amount = 0 and amount_vnd > 0;

-- 4. DUPLICATE PROTECTION — the most important part of this file.
--    A payment gateway may call the webhook several times for the same transaction
--    (retries after network errors). The two constraints below guarantee that each
--    transaction has exactly one row, so one payment can never extend a plan twice.
create unique index if not exists payments_order_code_idx
  on payments (order_code) where order_code is not null;
create unique index if not exists payments_provider_ref_idx
  on payments (provider, provider_ref) where provider_ref is not null;

create index if not exists payments_status_idx on payments (status, created_at desc);

-- 5. Activate the plan after a successful payment — done inside ONE database transaction
--    so we never record the money but forget to upgrade the plan (or the other way round).
--    Returns true if this call actually activated the plan, false if it was already active.
--    NOTE: migration v10 replaces this with a one-argument version that reads the
--    number of months off the payment row. If v10 has already run, this file
--    must NOT recreate the two-argument form: Postgres would then hold both, and
--    a call naming only p_payment_id matches each of them equally well, so every
--    activation would fail with "function activate_paid_plan is not unique".
--    The guard below makes v6 safe to re-run at any point in the sequence.
do $v6fn$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payments' and column_name = 'billing_cycle'
  ) then
    raise notice 'migration v10 already applied — keeping its activate_paid_plan(uuid) and skipping the older two-argument version.';
    return;
  end if;

  execute $v6body$
create or replace function activate_paid_plan(
  p_payment_id uuid,
  p_months int default 1
)
returns boolean
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_current_expiry timestamptz;
  v_base timestamptz;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception 'Payment transaction % not found', p_payment_id;
  end if;

  -- Already recorded, so stop here rather than adding more time a second time.
  -- Only paid_at is checked: that column is written solely inside this function, which
  -- makes it the one trustworthy marker. Bringing status into the check would let a
  -- wrong status update elsewhere extend a plan twice for a single payment.
  if v_payment.paid_at is not null then
    return false;
  end if;

  select plan_expires_at into v_current_expiry
  from organizations where id = v_payment.organization_id;

  -- If the plan is still valid, stack the new period on top; if it expired, count from today
  v_base := greatest(coalesce(v_current_expiry, now()), now());

  update organizations
  set plan_id         = coalesce(v_payment.plan_id, plan_id),
      billing_status  = 'paid',
      plan_expires_at = v_base + (p_months || ' months')::interval,
      status          = case when status = 'suspended' then 'active' else status end
  where id = v_payment.organization_id;

  update payments
  set status  = 'paid',
      paid_at = now(),
      period_start = coalesce(period_start, v_base::date),
      period_end   = coalesce(period_end, (v_base + (p_months || ' months')::interval)::date)
  where id = p_payment_id;

  return true;
end;
$$;
  $v6body$;
end
$v6fn$;

-- 6. Clean up checkout sessions that have been abandoned for more than 24 hours
create or replace function cleanup_stale_payments()
returns int
language sql
as $$
  with updated as (
    update payments
    set status = 'expired'
    where status = 'pending'
      and created_at < now() - interval '24 hours'
    returning id
  )
  select count(*)::int from updated;
$$;
