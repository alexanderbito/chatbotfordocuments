-- =====================================================================
-- MIGRATION V5 — Public / private folders and per-email access control
-- Run in Supabase Dashboard > SQL Editor > New query > Run
-- Safe to run more than once. Requires migration_v4_ocr_retry.sql to have been run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRECONDITION CHECK: stop early with a clear message if the files are run out of order
-- ---------------------------------------------------------------------
do $guard$
begin
  if to_regclass('public.folders') is null then
    raise exception E'Missing table "folders".\n=> This table is created by migration_v2_auth.sql. Run that file first, and only then run this one.\n=> If the app on Render is working fine with folders, the SQL Editor is most likely open on the WRONG Supabase project. Check the top left corner of the dashboard.\n=> Run kiem_tra_migration.sql to see which stage the database is at.';
  end if;
  if to_regclass('public.organization_members') is null then
    raise exception E'Missing table "organization_members".\n=> You have not run migration_v2_auth.sql yet.';
  end if;
end
$guard$;

-- 1. Folder visibility mode
--    public  : every member of the organization can ask about the documents inside
--    private : only explicitly granted emails (and organization admins) can read it
alter table folders add column if not exists visibility text not null default 'public';

alter table folders drop constraint if exists folders_visibility_check;
alter table folders add constraint folders_visibility_check
  check (visibility in ('public', 'private'));

create index if not exists folders_visibility_idx on folders (organization_id, visibility);

-- 2. The list of emails allowed to read each private folder
create table if not exists folder_permissions (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references folders(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  granted_by uuid,
  created_at timestamptz not null default now()
);

-- Emails are always stored in lower case so that matching is case-insensitive
create unique index if not exists folder_permissions_unique_idx
  on folder_permissions (folder_id, email);
create index if not exists folder_permissions_email_idx
  on folder_permissions (organization_id, email);

alter table folder_permissions enable row level security;

-- 3. Semantic search function WITH PERMISSION CHECKING.
--    It differs from match_document_chunks_scoped in that the backend passes in the
--    list of folders the asker is ALLOWED to read. This approach "fails closed" —
--    if the permission calculation goes wrong the user sees nothing, instead of
--    accidentally seeing confidential documents.
create or replace function match_document_chunks_acl(
  query_embedding vector(1024),
  match_org_id uuid,
  match_count int default 5,
  allowed_folder_ids uuid[] default '{}',
  include_unfiled boolean default true
)
returns table (id uuid, document_id uuid, folder_id uuid, content text, similarity float)
language sql stable
as $$
  select dc.id, dc.document_id, dc.folder_id, dc.content,
         1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.organization_id = match_org_id
    and (
      (dc.folder_id is null and include_unfiled)
      or dc.folder_id = any(allowed_folder_ids)
    )
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- 4. Clean up grants belonging to emails that were removed from the organization
create or replace function cleanup_orphan_folder_permissions()
returns int
language sql
as $$
  with deleted as (
    delete from folder_permissions fp
    where not exists (
      select 1 from organization_members m
      where m.organization_id = fp.organization_id
        and lower(m.email) = fp.email
    )
    returning fp.id
  )
  select count(*)::int from deleted;
$$;

-- =====================================================================
-- NOTE: all existing folders default to 'public', which means current behaviour
-- does not change until an admin deliberately makes a folder private.
-- =====================================================================
