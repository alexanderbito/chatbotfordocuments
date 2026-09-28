-- =====================================================================
-- MIGRATION V13 — Starter plan, PayPal auto-renewal, affiliate programme
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v12_api.sql.
-- =====================================================================

do $guard$
begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'plans' and column_name = 'api_enabled') then
    raise exception E'Missing column plans.api_enabled.\n=> You have not run migration_v12_api.sql yet.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------
-- 1. The Starter plan.
--
--    Seeded only if it does not exist. A re-run never edits the limits,
--    because by then an admin may have tuned them.
-- ---------------------------------------------------------------------
insert into plans (code, name, description, price_usd, price_usd_yearly,
                   max_documents, max_members, max_storage_mb,
                   max_questions_per_month, max_ocr_pages_per_month,
                   ocr_enabled, api_enabled, max_api_calls_per_month,
                   trial_days, sort_order, is_active)
values ('starter', 'Starter',
        'For a small team that wants more than the trial allows.',
        5, 49,
        100, 5, 1000,
        1500, 0,
        false, false, 0,
        0, 2, true)
on conflict (code) do nothing;

-- Professional and Business move down so Starter sits between the trial and them.
update plans set sort_order = 3 where code = 'pro'      and sort_order < 3;
update plans set sort_order = 4 where code = 'business' and sort_order < 4;

-- ---------------------------------------------------------------------
-- 2. PayPal billing plans, one per (plan, cycle).
--
--    PayPal needs its own Product and Billing Plan objects before it will
--    accept a subscription. Their ids are stored here so the sync only has to
--    run when a price changes, not on every checkout.
-- ---------------------------------------------------------------------
alter table plans add column if not exists paypal_plan_id_monthly text;
alter table plans add column if not exists paypal_plan_id_yearly  text;
-- The price each PayPal plan was created with. PayPal plans are immutable in
-- the ways that matter, so a price change means creating a new one; without
-- this we could not tell that the stored id has gone stale and customers would
-- silently be charged the old amount.
alter table plans add column if not exists paypal_synced_price_monthly numeric(10,2);
alter table plans add column if not exists paypal_synced_price_yearly  numeric(10,2);

comment on column plans.paypal_plan_id_monthly is
  'PayPal billing plan id for the monthly cycle. Recreated when the price changes.';

-- ---------------------------------------------------------------------
-- 2b. A small key/value store for things that belong to the installation
--     rather than to any customer — the PayPal Product id, for one. A table
--     rather than an environment variable, because the value is created by the
--     running system rather than configured by a person.
-- ---------------------------------------------------------------------
create table if not exists system_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

alter table system_settings enable row level security;

-- ---------------------------------------------------------------------
-- 3. Subscriptions.
--
--    One row per PayPal subscription. The organization keeps its plan_id and
--    plan_expires_at as before — a subscription is a way of paying, not a
--    second source of truth about what the customer has.
-- ---------------------------------------------------------------------
create table if not exists subscriptions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  plan_id          uuid references plans(id),
  provider         text not null default 'paypal',
  provider_ref     text not null,
  billing_cycle    text not null default 'monthly',
  amount           numeric(14,2) not null default 0,
  currency         text not null default 'USD',
  status           text not null default 'pending',
  approve_url      text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  activated_at     timestamptz,
  cancelled_at     timestamptz,
  ended_at         timestamptz,
  last_payment_at  timestamptz,
  next_billing_at  timestamptz,
  raw              jsonb
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_status_check') then
    alter table subscriptions add constraint subscriptions_status_check
      check (status in ('pending', 'active', 'suspended', 'cancelled', 'expired', 'failed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_cycle_check') then
    alter table subscriptions add constraint subscriptions_cycle_check
      check (billing_cycle in ('monthly', 'yearly'));
  end if;
end
$$;

-- The webhook finds the subscription by the id PayPal sends, so this lookup has
-- to be unique or a renewal could be applied to the wrong row.
create unique index if not exists subscriptions_provider_ref_idx
  on subscriptions (provider, provider_ref);
create index if not exists subscriptions_org_idx on subscriptions (organization_id, created_at desc);
-- At most one subscription actually charging an organization at a time.
create unique index if not exists subscriptions_one_live_per_org
  on subscriptions (organization_id) where status in ('pending', 'active', 'suspended');

alter table payments add column if not exists subscription_id uuid references subscriptions(id) on delete set null;

-- ---------------------------------------------------------------------
-- 4. Affiliates.
--
--    An affiliate is a PERSON, not an organization: the commission is paid to
--    somebody, and one person may administer several organizations. Whether
--    they are allowed to take part is decided at enrolment, again whenever the
--    page is opened, and once more inside record_commission — so a lapsed
--    subscription of their own stops new commissions rather than only hiding
--    the page.
-- ---------------------------------------------------------------------
create table if not exists affiliates (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users(id) on delete cascade,
  code          text not null unique,
  paypal_email  text,
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  note          text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'affiliates_status_check') then
    alter table affiliates add constraint affiliates_status_check
      check (status in ('active', 'suspended'));
  end if;
  -- The code goes in a URL and is read aloud over the phone. Restricting the
  -- alphabet here stops a code that needs escaping from ever being stored.
  if not exists (select 1 from pg_constraint where conname = 'affiliates_code_check') then
    alter table affiliates add constraint affiliates_code_check
      check (code ~ '^[a-z0-9-]{4,32}$');
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 5. Referrals: who introduced which organization.
--
--    organization_id is the primary key, not merely unique: an organization is
--    introduced once, by whoever was first, and never reassigned. Without that
--    a second affiliate could claim an existing customer by getting them to
--    click a link.
-- ---------------------------------------------------------------------
create table if not exists referrals (
  organization_id  uuid primary key references organizations(id) on delete cascade,
  affiliate_id     uuid not null references affiliates(id) on delete cascade,
  referred_at      timestamptz not null default now(),
  first_paid_at    timestamptz
);

create index if not exists referrals_affiliate_idx on referrals (affiliate_id, referred_at desc);

-- ---------------------------------------------------------------------
-- 6. Commissions, one per payment.
--
--    payment_id is UNIQUE. A payment is the event that earns a commission, and
--    a gateway may deliver its webhook several times; without this constraint
--    one renewal could be paid out twice and nothing would look wrong.
-- ---------------------------------------------------------------------
create table if not exists commissions (
  id             uuid primary key default gen_random_uuid(),
  affiliate_id   uuid not null references affiliates(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  payment_id     uuid not null unique references payments(id) on delete cascade,
  billing_cycle  text not null,
  rate           numeric(5,4) not null,
  base_amount    numeric(14,2) not null,
  amount         numeric(14,2) not null,
  currency       text not null default 'USD',
  status         text not null default 'pending',
  -- Held until the refund window has passed, so a commission is never paid out
  -- on money that later goes back to the customer.
  available_at   timestamptz not null,
  payout_id      uuid,
  created_at     timestamptz not null default now(),
  note           text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'commissions_status_check') then
    alter table commissions add constraint commissions_status_check
      check (status in ('pending', 'approved', 'paid', 'void'));
  end if;
end
$$;

create index if not exists commissions_affiliate_idx on commissions (affiliate_id, status, created_at desc);
create index if not exists commissions_payout_idx on commissions (payout_id);

-- ---------------------------------------------------------------------
-- 7. Payouts. Recorded by hand: the money moves outside this system.
-- ---------------------------------------------------------------------
create table if not exists affiliate_payouts (
  id            uuid primary key default gen_random_uuid(),
  affiliate_id  uuid not null references affiliates(id) on delete cascade,
  amount        numeric(14,2) not null,
  currency      text not null default 'USD',
  method        text,
  reference     text,
  note          text,
  paid_at       timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null
);

create index if not exists affiliate_payouts_idx on affiliate_payouts (affiliate_id, paid_at desc);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'commissions_payout_fk' and table_name = 'commissions'
  ) then
    alter table commissions add constraint commissions_payout_fk
      foreign key (payout_id) references affiliate_payouts(id) on delete set null;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 8. None of these tables is reachable except through the server.
-- ---------------------------------------------------------------------
alter table subscriptions      enable row level security;
alter table affiliates         enable row level security;
alter table referrals          enable row level security;
alter table commissions        enable row level security;
alter table affiliate_payouts  enable row level security;

do $$
begin
  execute (
    select coalesce(string_agg(format('drop policy %I on public.%I;', policyname, tablename), ' '), '')
    from pg_policies
    where schemaname = 'public'
      and tablename in ('subscriptions', 'affiliates', 'referrals', 'commissions', 'affiliate_payouts', 'system_settings')
  );
end
$$;

-- ---------------------------------------------------------------------
-- 9. Recording a commission.
--
--    Everything is derived here, inside the database, from the payment row:
--    the rate from its cycle, the base from the amount actually received.
--    Passing an amount in from the application would mean the number that
--    leaves the company is one the application chose.
--
--    Returns the commission id, or null when there is nothing to pay — no
--    referral, a self-referral, an affiliate no longer active, or a commission
--    already recorded for this payment.
-- ---------------------------------------------------------------------
create or replace function record_commission(p_payment_id uuid)
returns uuid
language plpgsql
as $$
declare
  v_payment    payments%rowtype;
  v_referral   referrals%rowtype;
  v_affiliate  affiliates%rowtype;
  v_rate       numeric(5,4);
  v_amount     numeric(14,2);
  v_id         uuid;
  v_owner      uuid;
  v_hold_days  int := 30;
begin
  select * into v_payment from payments where id = p_payment_id;
  if not found or v_payment.paid_at is null then return null; end if;

  -- Already recorded. The unique index would catch it, but returning quietly
  -- is what makes a repeated webhook harmless rather than an error in a log.
  if exists (select 1 from commissions where payment_id = p_payment_id) then
    return null;
  end if;

  select * into v_referral from referrals where organization_id = v_payment.organization_id;
  if not found then return null; end if;

  select * into v_affiliate from affiliates where id = v_referral.affiliate_id;
  if not found or v_affiliate.status <> 'active' then return null; end if;

  -- Taking part requires a paying organization of one's own, and that is
  -- re-checked here rather than only at enrolment: the programme is for
  -- customers, so somebody whose own subscription has lapsed stops earning
  -- until it comes back. Nothing already recorded is touched.
  if not exists (
    select 1
    from organization_members m
    join organizations o on o.id = m.organization_id
    join plans pl on pl.id = o.plan_id
    where m.user_id = v_affiliate.user_id
      and m.role = 'admin'
      and coalesce(m.status, 'active') <> 'disabled'
      and o.billing_status = 'paid'
      and o.status <> 'suspended'
      and coalesce(pl.price_usd, 0) > 0
      and (o.plan_expires_at is null or o.plan_expires_at > now())
  ) then
    return null;
  end if;

  -- Nobody earns a commission on their own subscription. Checked against the
  -- organization's owner and its admin members, because an affiliate who also
  -- administers the paying organization is the same person either way.
  select owner_id into v_owner from organizations where id = v_payment.organization_id;
  if v_owner = v_affiliate.user_id then return null; end if;
  if exists (
    select 1 from organization_members m
    where m.organization_id = v_payment.organization_id
      and m.user_id = v_affiliate.user_id
      and m.role = 'admin'
  ) then
    return null;
  end if;

  v_rate := case when v_payment.billing_cycle = 'yearly' then 0.30 else 0.20 end;
  v_amount := round(coalesce(v_payment.amount, 0) * v_rate, 2);
  if v_amount <= 0 then return null; end if;

  insert into commissions (
    affiliate_id, organization_id, payment_id, billing_cycle,
    rate, base_amount, amount, currency, status, available_at
  ) values (
    v_affiliate.id, v_payment.organization_id, v_payment.id,
    coalesce(v_payment.billing_cycle, 'monthly'),
    v_rate, v_payment.amount, v_amount, coalesce(v_payment.currency, 'USD'),
    'pending', v_payment.paid_at + (v_hold_days || ' days')::interval
  )
  returning id into v_id;

  update referrals
  set first_paid_at = coalesce(first_paid_at, v_payment.paid_at)
  where organization_id = v_payment.organization_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 10. What an affiliate has earned.
--
--     One function so the console, the payout screen and any report all agree.
--     "Available" is the only figure that may be paid out: past its hold and
--     not already in a payout.
-- ---------------------------------------------------------------------
-- create or replace cannot change the shape of a RETURNS TABLE, so the old
-- version is dropped first. Without this, re-running a file whose function
-- signature has been edited fails halfway through with "cannot change return
-- type of existing function" — after the tables have already been created.
drop function if exists affiliate_balance(uuid);
create or replace function affiliate_balance(p_affiliate_id uuid)
returns table (
  pending_amount   numeric,
  available_amount numeric,
  paid_amount      numeric,
  referred_count   int,
  paying_count     int
)
language sql
stable
as $$
  select
    coalesce(sum(c.amount) filter (where c.status = 'pending' and c.available_at > now()), 0),
    coalesce(sum(c.amount) filter (where c.status in ('pending', 'approved') and c.available_at <= now()), 0),
    coalesce(sum(c.amount) filter (where c.status = 'paid'), 0),
    (select count(*)::int from referrals r where r.affiliate_id = p_affiliate_id),
    (select count(*)::int from referrals r where r.affiliate_id = p_affiliate_id and r.first_paid_at is not null)
  from commissions c
  where c.affiliate_id = p_affiliate_id;
$$;
-- (Every column above is aliased for the same reason: the OUT columns of a
--  RETURNS TABLE are variables inside the body.)

-- ---------------------------------------------------------------------
-- 11. Paying out.
--
--     Takes everything currently available for one affiliate, writes one payout
--     row and marks those commissions against it — in a single statement, so a
--     commission can never be in two payouts or in none.
-- ---------------------------------------------------------------------
drop function if exists pay_affiliate(uuid, text, text, text, uuid);
create or replace function pay_affiliate(
  p_affiliate_id uuid,
  p_method       text,
  p_reference    text,
  p_note         text,
  p_created_by   uuid
)
returns table (out_payout_id uuid, out_amount numeric, out_commission_count int)
language plpgsql
as $$
declare
  v_total numeric(14,2);
  v_count int;
  v_id uuid;
begin
  -- The payout row is written first, at zero, so the UPDATE below has something
  -- to point at. If nothing turns out to be claimable the exception rolls the
  -- whole function back and the empty row goes with it.
  insert into affiliate_payouts (affiliate_id, amount, method, reference, note, created_by)
  values (p_affiliate_id, 0, p_method, p_reference, p_note, p_created_by)
  returning id into v_id;

  -- Claim and total in ONE statement. Summing first and updating afterwards
  -- leaves a window where a second payout running at the same time totals the
  -- same commissions and pays them twice; "payout_id is null" in the WHERE
  -- makes this a compare-and-swap, so two concurrent payouts claim disjoint
  -- sets and the loser gets nothing rather than a duplicate.
  -- (An aggregate cannot be combined with FOR UPDATE, so locking the rows
  --  first and summing them was not an option either.)
  with claimed as (
    update commissions c
    set status = 'paid', payout_id = v_id
    where c.affiliate_id = p_affiliate_id
      and c.status in ('pending', 'approved')
      and c.available_at <= now()
      and c.payout_id is null
    returning c.amount
  )
  select coalesce(sum(claimed.amount), 0), count(*)::int
  into v_total, v_count
  from claimed;

  if v_count = 0 then
    raise exception 'This affiliate has nothing available to pay out';
  end if;

  update affiliate_payouts set amount = v_total where id = v_id;

  return query select v_id, v_total, v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 12. What ended up configured
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  raise notice '--- Plans after migration v13 ---';
  for r in select name, price_usd, price_usd_yearly, api_enabled from plans order by sort_order loop
    raise notice '% : $%/month, $%/year%',
      rpad(r.name, 14), r.price_usd, r.price_usd_yearly,
      case when r.api_enabled then ', API' else '' end;
  end loop;
  raise notice 'Affiliate commission: 20%% on monthly payments, 30%% on yearly, every payment, held 30 days.';
end
$$;
