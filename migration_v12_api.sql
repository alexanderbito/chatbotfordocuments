-- =====================================================================
-- MIGRATION V12 — Public API: keys, per-key folder scope, and call quota
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v11_contact_messages.sql.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.folders') is null then
    raise exception E'Missing table "folders".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_name = 'plans' and column_name = 'price_usd_yearly') then
    raise exception E'Missing column plans.price_usd_yearly.\n=> You have not run migration_v10_yearly_billing.sql yet.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------
-- 1. What each plan may do with the API.
--
--    Two separate columns rather than one. A quota of 0 could mean "no API"
--    or "API with nothing left this month", and those need different answers
--    to the customer: one says upgrade, the other says wait or buy more.
-- ---------------------------------------------------------------------
-- The seed runs only on the pass that actually adds the column, so it happens
-- exactly once. An earlier version tested "has any plan got the API turned on",
-- which looks equivalent and is not: an admin who deliberately switched the API
-- off for every plan would have had it switched back on by the next re-run.
do $seed$
declare v_fresh boolean;
begin
  v_fresh := not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'plans' and column_name = 'api_enabled'
  );

  alter table plans add column if not exists api_enabled boolean not null default false;
  alter table plans add column if not exists max_api_calls_per_month int not null default 0;

  if v_fresh then
    update plans set api_enabled = true, max_api_calls_per_month = 20000 where code = 'business';
    raise notice 'Seeded: the Business plan now includes 20,000 API calls a month.';
  else
    raise notice 'API plan settings already existed — left exactly as they are.';
  end if;
end
$seed$;

comment on column plans.api_enabled is
  'Whether this plan may create API keys at all.';
comment on column plans.max_api_calls_per_month is
  'API calls included per calendar month. Only meaningful when api_enabled.';

-- A plan that sells the API with an allowance of zero refuses every call, which
-- no one intends. Enforced here and not only in the console, because the console
-- is one of several ways a row gets written.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_api_allowance_check') then
    alter table plans add constraint plans_api_allowance_check
      check (not api_enabled or max_api_calls_per_month > 0);
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 2. The keys.
--
--    THE KEY ITSELF IS NEVER STORED. Only a SHA-256 hash of it is, exactly as
--    a password would be. A stolen copy of this table therefore lets nobody
--    call the API — which is the whole point, because these keys sit in
--    customers' own servers and CI systems and will leak eventually.
--
--    key_prefix is the first few visible characters, kept in clear so the
--    customer can tell two keys apart in a list without us being able to
--    reconstruct either.
-- ---------------------------------------------------------------------
create table if not exists api_keys (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  name             text not null,
  key_hash         text not null unique,
  key_prefix       text not null,
  -- null = every folder the organization has, now and in future.
  -- A non-empty array = only these, which is what makes a key safe to put in a
  -- public-facing chatbot: it cannot reach the contracts folder even if the
  -- organization adds one later.
  folder_ids       uuid[],
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users(id) on delete set null
);

create index if not exists api_keys_org_idx on api_keys (organization_id, created_at desc);
-- The lookup on every single API call. Partial, because a revoked key is never
-- looked up by hash again.
create index if not exists api_keys_hash_idx on api_keys (key_hash) where revoked_at is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'api_keys_name_check') then
    alter table api_keys add constraint api_keys_name_check check (length(name) between 1 and 80);
  end if;
  -- null means "every folder"; a list means "only these". An EMPTY list is
  -- neither, and the code that reads it has to pick one — historically it
  -- picked "every folder", which turns a restricted key into an unrestricted
  -- one. Forbidding the state is better than relying on every reader to guess
  -- the safe interpretation.
  if not exists (select 1 from pg_constraint where conname = 'api_keys_folder_scope_check') then
    alter table api_keys add constraint api_keys_folder_scope_check
      check (folder_ids is null or array_length(folder_ids, 1) > 0);
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Usage, one row per call.
--
--    Counted here rather than on chat_messages because the two are sold
--    separately: a question asked in the browser must not eat the API
--    allowance, and an API call must not eat the seats' question allowance.
--    Keeping the rows (rather than a counter) is what lets a customer see
--    which key spent the month's quota when the bill surprises them.
-- ---------------------------------------------------------------------
create table if not exists api_usage (
  id               bigserial primary key,
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- The key may be deleted later; the usage it caused still counted.
  api_key_id       uuid references api_keys(id) on delete set null,
  endpoint         text not null,
  status           int not null,
  duration_ms      int,
  created_at       timestamptz not null default now()
);

-- Serves the "calls this month" question, which runs on EVERY API call.
create index if not exists api_usage_org_month_idx on api_usage (organization_id, created_at desc);
create index if not exists api_usage_key_idx on api_usage (api_key_id, created_at desc);
-- The sweep looks for reservations that were never finished.
create index if not exists api_usage_pending_idx on api_usage (created_at) where status = 0;

-- ---------------------------------------------------------------------
-- 4. Neither table is reachable except through the server.
--
--    RLS on with no policy refuses every anon and authenticated request. The
--    backend uses the service-role key, which bypasses RLS and never leaves
--    the server. Without this, the public anon key would read every key hash
--    and every customer's call history.
-- ---------------------------------------------------------------------
alter table api_keys enable row level security;
alter table api_usage enable row level security;

do $$
begin
  execute (
    select coalesce(string_agg(format('drop policy %I on public.%I;', policyname, tablename), ' '), '')
    from pg_policies
    where schemaname = 'public' and tablename in ('api_keys', 'api_usage')
  );
end
$$;

comment on table api_keys is
  'API keys. Only a SHA-256 hash is stored. Service-role only: RLS on with no policy.';
comment on table api_usage is
  'One row per API call, for the monthly quota. Service-role only: RLS on with no policy.';

-- ---------------------------------------------------------------------
-- 5. Counting a call.
--
--    The count is taken BEFORE the work, not after, and the row that carries it
--    is inserted in the same statement that reads the total. Counting
--    afterwards looked simpler and was wrong: every request in flight read the
--    same stale number, so an allowance of 5 served 22 concurrent calls in
--    testing — and in production the window is a whole model round trip, so the
--    overshoot is bounded only by how many connections a customer opens.
--
--    A reserved row carries status 0. That is below 400, so it counts towards
--    the allowance from the moment it exists, which is what makes concurrent
--    requests see each other. finish_api_call then writes the real status, and
--    a call that turned out to be the caller's own mistake (4xx) stops counting
--    — so debugging an integration still costs nothing.
-- ---------------------------------------------------------------------
create or replace function reserve_api_call(
  p_org_id   uuid,
  p_key_id   uuid,
  p_endpoint text
)
returns table (usage_id bigint, calls_used int)
language plpgsql
as $$
declare
  v_id bigint;
begin
  insert into api_usage (organization_id, api_key_id, endpoint, status)
  values (p_org_id, p_key_id, p_endpoint, 0)
  returning id into v_id;

  if p_key_id is not null then
    update api_keys set last_used_at = now() where id = p_key_id;
  end if;

  return query
    select v_id,
           (select count(*)::int from api_usage
             where organization_id = p_org_id
               and created_at >= date_trunc('month', now())
               and status < 400);
end;
$$;

/** Write the outcome onto a row reserved above. */
create or replace function finish_api_call(
  p_usage_id bigint,
  p_status   int,
  p_duration int default null
)
returns void
language sql
as $$
  update api_usage
  set status = p_status, duration_ms = p_duration
  where id = p_usage_id;
$$;

/**
 * Release a reservation without charging for it.
 *
 * Used when the request is refused before any work happens — an unknown key, a
 * plan without the API. Deleting rather than marking it keeps the usage table
 * to calls that actually did something.
 */
create or replace function release_api_call(p_usage_id bigint)
returns void
language sql
as $$
  delete from api_usage where id = p_usage_id and status = 0;
$$;

/** Calls used this calendar month, without recording one. */
create or replace function api_calls_this_month(p_org_id uuid)
returns int
language sql
stable
as $$
  select count(*)::int from api_usage
  where organization_id = p_org_id
    and created_at >= date_trunc('month', now())
    and status < 400;
$$;

/**
 * Calls per key this month.
 *
 * Exists so the console's per-key column and its total are computed the same
 * way. Counting the rows in JavaScript meant the month boundary came from the
 * Node host's local clock while the total came from Postgres, so on any
 * non-UTC host the two silently disagreed.
 */
create or replace function api_calls_by_key_this_month(p_org_id uuid)
returns table (api_key_id uuid, calls int)
language sql
stable
as $$
  select u.api_key_id, count(*)::int
  from api_usage u
  where u.organization_id = p_org_id
    and u.created_at >= date_trunc('month', now())
    and u.status < 400
    and u.api_key_id is not null
  group by u.api_key_id;
$$;

-- A reservation whose request died before it could be finished would otherwise
-- count for the rest of the month. Anything still at status 0 after an hour is
-- long dead.
create or replace function sweep_stale_api_reservations()
returns int
language sql
as $$
  with gone as (
    delete from api_usage
    where status = 0 and created_at < now() - interval '1 hour'
    returning id
  )
  select count(*)::int from gone;
$$;

-- ---------------------------------------------------------------------
-- 6. Housekeeping: usage rows older than 13 months.
--
--    Thirteen, not twelve, so a customer can still compare this month with the
--    same month last year. Called from the existing cron endpoint.
-- ---------------------------------------------------------------------
create or replace function cleanup_api_usage()
returns int
language sql
as $$
  with gone as (
    delete from api_usage where created_at < now() - interval '13 months' returning id
  )
  select count(*)::int from gone;
$$;

-- ---------------------------------------------------------------------
-- 7. What the plans ended up as
-- ---------------------------------------------------------------------
do $$
declare r record;
begin
  raise notice '--- API access by plan ---';
  for r in select name, api_enabled, max_api_calls_per_month from plans order by sort_order loop
    if r.api_enabled then
      raise notice '% : API included, % calls/month', rpad(r.name, 14), r.max_api_calls_per_month;
    else
      raise notice '% : no API', rpad(r.name, 14);
    end if;
  end loop;
end
$$;
