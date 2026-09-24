-- =====================================================================
-- v9 — Downloadable PDF invoices
--
-- Adds the two things an invoice needs that the database did not hold yet:
--   1. Who the invoice is addressed to. organizations.name is a display name
--      that people change freely; an invoice needs the legal entity and its
--      address, which are separate fields the customer fills in once.
--   2. A stable invoice number. It must never change once issued and must
--      never be reused, so it is stored on the payment row rather than being
--      derived at download time from data that could be edited later.
--
-- Run after v8. Safe to run more than once.
-- =====================================================================

do $guard$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'payments') then
    raise exception
      'Run migration_v6_payments.sql first: the payments table does not exist yet. If you are unsure which migration the database is at, run kiem_tra_migration.sql.';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------
-- 1. Billing identity of the customer
-- ---------------------------------------------------------------------
-- Left null, the invoice falls back to organizations.name, so existing
-- customers keep working without filling anything in.
alter table organizations add column if not exists billing_name text;
alter table organizations add column if not exists billing_address text;

comment on column organizations.billing_name is
  'Legal entity the invoice is addressed to. Falls back to organizations.name when empty.';
comment on column organizations.billing_address is
  'Postal address printed on the invoice. Free text, newlines preserved.';

-- ---------------------------------------------------------------------
-- 2. Invoice numbering
-- ---------------------------------------------------------------------
alter table payments add column if not exists invoice_number text;
alter table payments add column if not exists invoice_issued_at timestamptz;

create unique index if not exists payments_invoice_number_idx
  on payments (invoice_number) where invoice_number is not null;

create sequence if not exists invoice_number_seq start with 1;

-- Assign the number on first download and never again.
--
-- Two details that matter:
--   * The row is locked before the check, so two downloads racing each other
--     cannot both take a number for the same payment.
--   * Only a payment that has actually been received gets a number. Issuing an
--     invoice for a pending or failed transaction would put a document into the
--     customer's accounts for money that never arrived.
create or replace function assign_invoice_number(p_payment_id uuid)
returns text
language plpgsql
as $$
declare
  v_existing text;
  v_paid_at  timestamptz;
  v_number   text;
begin
  select invoice_number, paid_at into v_existing, v_paid_at
    from payments where id = p_payment_id for update;

  if not found then
    raise exception 'No payment with id %', p_payment_id;
  end if;

  if v_existing is not null then
    return v_existing;
  end if;

  if v_paid_at is null then
    raise exception 'Payment % has not been received, so no invoice can be issued for it', p_payment_id;
  end if;

  v_number := 'BC-' || to_char(v_paid_at, 'YYYY') || '-' ||
              lpad(nextval('invoice_number_seq')::text, 5, '0');

  update payments
     set invoice_number = v_number,
         invoice_issued_at = now()
   where id = p_payment_id;

  return v_number;
end;
$$;

do $report$
begin
  raise notice 'Invoice numbering is ready. Numbers are issued on first download, in the form BC-YYYY-00001.';
end
$report$;
