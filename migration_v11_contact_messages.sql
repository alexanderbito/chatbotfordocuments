-- =====================================================================
-- MIGRATION V11 — Contact messages from the marketing site
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v10_yearly_billing.sql.
-- =====================================================================

do $guard$
begin
  if to_regclass('public.organizations') is null then
    raise exception E'Missing table "organizations".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------
-- 1. The messages themselves.
--
--    These come from people who are NOT signed in and usually not customers
--    yet, so nothing here links to a user or an organization. Every field is
--    stranger-supplied text and is treated as such: length-capped in the
--    column, escaped wherever it is rendered, and never interpolated into
--    anything that executes.
-- ---------------------------------------------------------------------
create table if not exists contact_messages (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  email        text not null,
  company      text,
  message      text not null,
  -- Kept for rate limiting and for recognising a flood. It is personal data,
  -- so the cleanup at the end of this file drops it once it is no longer
  -- useful for that, while keeping the message itself.
  ip           text,
  user_agent   text,
  status       text not null default 'new',
  read_at      timestamptz,
  read_by      uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'contact_messages_status_check') then
    alter table contact_messages add constraint contact_messages_status_check
      check (status in ('new', 'read', 'archived', 'spam'));
  end if;
  -- Caps at the database, not only in the route. A route can be bypassed by a
  -- later refactor; a column constraint cannot.
  if not exists (select 1 from pg_constraint where conname = 'contact_messages_length_check') then
    alter table contact_messages add constraint contact_messages_length_check
      check (
        length(name) between 1 and 120
        and length(email) between 3 and 200
        and length(coalesce(company, '')) <= 160
        and length(message) between 1 and 5000
      );
  end if;
end
$$;

create index if not exists contact_messages_status_idx on contact_messages (status, created_at desc);
-- Serves the rate-limit lookup: "how many from this IP in the last hour".
create index if not exists contact_messages_ip_idx on contact_messages (ip, created_at desc);

-- ---------------------------------------------------------------------
-- 2. Nobody reaches this table except the server.
--
--    Row-level security with no policy at all means every anon and
--    authenticated request is refused. The backend uses the service-role key,
--    which bypasses RLS, and that key never leaves the server. Without this,
--    anyone holding the public anon key could read every message sent to us.
-- ---------------------------------------------------------------------
alter table contact_messages enable row level security;

do $$
begin
  -- Drop any policy a previous run may have created, so "no policy" stays true.
  -- The schema is named because pg_policies covers every schema, and a table of
  -- the same name elsewhere would otherwise be matched.
  execute (
    select coalesce(string_agg(format('drop policy %I on public.contact_messages;', policyname), ' '), '')
    from pg_policies where schemaname = 'public' and tablename = 'contact_messages'
  );
end
$$;

comment on table contact_messages is
  'Messages from the public contact form. Service-role only: RLS is on with no policy.';

-- ---------------------------------------------------------------------
-- 3. Housekeeping, to be called from the existing cron endpoint.
--
--    Two separate retentions on purpose. The IP address is only needed to stop
--    a flood, which is a question about the last few hours, so it is cleared
--    after 30 days while the message stays readable. Messages that were marked
--    as spam are deleted outright after 30 days — keeping a year of somebody
--    else's junk serves nobody.
-- ---------------------------------------------------------------------
create or replace function cleanup_contact_messages()
returns table (ips_cleared int, spam_deleted int)
language plpgsql
as $$
declare
  v_ips int;
  v_spam int;
begin
  with cleared as (
    update contact_messages
    set ip = null, user_agent = null
    where created_at < now() - interval '30 days'
      and (ip is not null or user_agent is not null)
    returning id
  )
  select count(*)::int into v_ips from cleared;

  with gone as (
    delete from contact_messages
    where status = 'spam' and created_at < now() - interval '30 days'
    returning id
  )
  select count(*)::int into v_spam from gone;

  return query select v_ips, v_spam;
end;
$$;

do $$
declare v_count int;
begin
  select count(*)::int into v_count from contact_messages;
  raise notice 'contact_messages ready — % message(s) stored, RLS on with % policy(ies).',
    v_count, (select count(*) from pg_policies where tablename = 'contact_messages');
end
$$;
