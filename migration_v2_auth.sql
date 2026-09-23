-- =====================================================================
-- MIGRATION V2 — Auth, permissions, folders, members, plans, and logs
-- Run this entire file in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once (idempotent).
-- =====================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. User profiles (mapped one-to-one onto auth.users from Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists app_users (
  id uuid primary key,
  email text unique not null,
  full_name text,
  phone text,
  is_system_admin boolean not null default false,
  status text not null default 'active',   -- active | disabled
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_users_email_idx on app_users (lower(email));

-- ---------------------------------------------------------------------
-- 2. Subscription plans
-- ---------------------------------------------------------------------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,               -- free | pro | business ...
  name text not null,
  description text,
  price_vnd bigint not null default 0,     -- price per month
  max_documents int not null default 20,
  max_members int not null default 5,
  max_storage_mb int not null default 100,
  max_questions_per_month int not null default 500,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into plans (code, name, description, price_vnd, max_documents, max_members, max_storage_mb, max_questions_per_month, sort_order)
values
  ('free',     'Free trial',   'Free of charge, for trying the system out',   0,        20,   5,   100,   500, 1),
  ('pro',      'Professional', 'A good fit for small and medium businesses', 490000,   500,  30,  5000, 10000, 2),
  ('business', 'Business',     'No practical limits, priority support',   1990000,   10000, 300, 50000, 100000, 3)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 3. Additional columns on the organizations table
-- ---------------------------------------------------------------------
alter table organizations add column if not exists owner_id uuid;
alter table organizations add column if not exists plan_id uuid references plans(id);
alter table organizations add column if not exists status text not null default 'active';        -- active | suspended
alter table organizations add column if not exists billing_status text not null default 'trial'; -- trial | paid | overdue
alter table organizations add column if not exists plan_started_at timestamptz default now();
alter table organizations add column if not exists plan_expires_at timestamptz;
alter table organizations add column if not exists tax_code text;
alter table organizations add column if not exists contact_email text;
alter table organizations add column if not exists note text;

-- Assign the free trial plan to existing organizations that have no plan yet
update organizations
set plan_id = (select id from plans where code = 'free')
where plan_id is null;

-- ---------------------------------------------------------------------
-- 4. Organization members
-- ---------------------------------------------------------------------
create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references app_users(id) on delete cascade,
  email text not null,
  role text not null default 'member',     -- admin | member
  status text not null default 'active',   -- active | invited | disabled
  invite_token text,
  invited_by uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists organization_members_org_email_idx
  on organization_members (organization_id, lower(email));
create index if not exists organization_members_user_idx
  on organization_members (user_id);
create unique index if not exists organization_members_invite_token_idx
  on organization_members (invite_token) where invite_token is not null;

-- ---------------------------------------------------------------------
-- 5. Document folders (a nested tree)
-- ---------------------------------------------------------------------
create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  parent_id uuid references folders(id) on delete cascade,
  name text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists folders_org_idx on folders (organization_id);
create index if not exists folders_parent_idx on folders (parent_id);

-- ---------------------------------------------------------------------
-- 6. Additional columns on documents / document_chunks
-- ---------------------------------------------------------------------
alter table documents add column if not exists folder_id uuid references folders(id) on delete set null;
alter table documents add column if not exists uploaded_by uuid;
alter table documents add column if not exists size_bytes bigint default 0;
alter table documents add column if not exists mime_type text;
alter table documents add column if not exists chunk_count int default 0;
alter table documents add column if not exists error_message text;

create index if not exists documents_org_idx on documents (organization_id);
create index if not exists documents_folder_idx on documents (folder_id);

alter table document_chunks add column if not exists folder_id uuid;
create index if not exists document_chunks_folder_idx on document_chunks (folder_id);

-- ---------------------------------------------------------------------
-- 7. Question and answer history
-- ---------------------------------------------------------------------
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid,
  user_email text,
  question text not null,
  answer text,
  sources jsonb default '[]'::jsonb,
  matched_chunks int default 0,
  latency_ms int,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_org_idx on chat_messages (organization_id, created_at desc);

-- ---------------------------------------------------------------------
-- 8. System logs
-- ---------------------------------------------------------------------
create table if not exists system_logs (
  id uuid primary key default gen_random_uuid(),
  level text not null default 'info',      -- info | warn | error
  scope text not null default 'system',    -- auth | upload | chat | billing | system
  organization_id uuid,
  user_id uuid,
  message text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists system_logs_created_idx on system_logs (created_at desc);
create index if not exists system_logs_level_idx on system_logs (level);

-- ---------------------------------------------------------------------
-- 9. Payments
-- ---------------------------------------------------------------------
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  plan_id uuid references plans(id),
  amount_vnd bigint not null default 0,
  period_start date,
  period_end date,
  status text not null default 'paid',     -- pending | paid | failed | refunded
  method text,                              -- bank_transfer | momo | card | manual
  reference text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists payments_org_idx on payments (organization_id, created_at desc);

-- ---------------------------------------------------------------------
-- 10. Semantic search function (with optional folder filtering)
-- ---------------------------------------------------------------------
create or replace function match_document_chunks(
  query_embedding vector(1024),
  match_org_id uuid,
  match_count int default 5
)
returns table (id uuid, document_id uuid, content text, similarity float)
language sql stable
as $$
  select dc.id, dc.document_id, dc.content,
         1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.organization_id = match_org_id
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_document_chunks_scoped(
  query_embedding vector(1024),
  match_org_id uuid,
  match_count int default 5,
  filter_folder_ids uuid[] default null
)
returns table (id uuid, document_id uuid, folder_id uuid, content text, similarity float)
language sql stable
as $$
  select dc.id, dc.document_id, dc.folder_id, dc.content,
         1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.organization_id = match_org_id
    and (filter_folder_ids is null or dc.folder_id = any(filter_folder_ids))
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------
-- 11. Quick statistics for the system admin console
-- ---------------------------------------------------------------------
create or replace function admin_daily_stats(days_back int default 30)
returns table (day date, questions bigint, documents bigint, organizations bigint)
language sql stable
as $$
  with d as (
    select generate_series(
      (current_date - (days_back - 1))::date, current_date, interval '1 day'
    )::date as day
  )
  select d.day,
    (select count(*) from chat_messages c where c.created_at::date = d.day) as questions,
    (select count(*) from documents doc where doc.created_at::date = d.day) as documents,
    (select count(*) from organizations o where o.created_at::date = d.day) as organizations
  from d
  order by d.day;
$$;

-- ---------------------------------------------------------------------
-- 12. RLS — the backend uses service_role and therefore bypasses it; enabled to block direct access
-- ---------------------------------------------------------------------
alter table documents           enable row level security;
alter table document_chunks     enable row level security;
alter table folders             enable row level security;
alter table organization_members enable row level security;
alter table chat_messages       enable row level security;
alter table payments            enable row level security;
alter table system_logs         enable row level security;
alter table app_users           enable row level security;

-- =====================================================================
-- AFTER THIS FILE HAS RUN: create the first system admin account by
-- signing up through /register.html, then running the statement below:
--
--   update app_users set is_system_admin = true where email = 'your-email@example.com';
-- =====================================================================
