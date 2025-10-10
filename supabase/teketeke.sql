-- =========================================================
-- TekeTeke Core Schema (Supabase / Postgres) — FULL SCRIPT
-- Includes fixes + additions used by server.js (taxi/boda,
-- USSD pool field names, daily fees, matatu_members, views)
-- Safe to run multiple times (IF NOT EXISTS / idempotent).
-- =========================================================

-- UUID helper (needed for gen_random_uuid)
create extension if not exists pgcrypto;

-- ---------- ORGS & USERS ----------
create table if not exists saccos (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name  text,
  contact_phone text,
  contact_email text,
  default_till  text,
  created_at    timestamptz default now()
);

create table if not exists sacco_users (
  id uuid primary key default gen_random_uuid(),
  sacco_id uuid not null references saccos(id) on delete cascade,
  user_id  uuid not null, -- supabase.auth.users.id
  role     text not null check (role in ('SUPER_ADMIN','SACCO_ADMIN','STAFF','OWNER','BRANCH_MANAGER','CONDUCTOR')),
  created_at timestamptz default now()
);
create index if not exists sacco_users_sacco_idx on sacco_users(sacco_id);
create index if not exists sacco_users_user_idx  on sacco_users(user_id);

-- ---------- CATALOG ----------
create table if not exists matatus (
  id uuid primary key default gen_random_uuid(),
  sacco_id uuid not null references saccos(id) on delete cascade,
  number_plate text not null,
  owner_name   text,
  owner_phone  text,
  vehicle_type text check (vehicle_type in ('bus','minibus','van')),
  tlb_number   text,
  till_number  text,
  created_at   timestamptz default now(),
  unique(number_plate)
);
create index if not exists matatus_sacco_idx on matatus(sacco_id);
create index if not exists matatus_till_idx  on matatus(till_number);

-- (optional but recommended) ensure one matatu per till (when till is set)
create unique index if not exists matatus_till_unique
  on matatus(till_number)
  where till_number is not null;

-- NEW: members per matatu (used by login + role checks)
create table if not exists matatu_members (
  id uuid primary key default gen_random_uuid(),
  matatu_id uuid not null references matatus(id) on delete cascade,
  user_id   uuid not null, -- supabase.auth.users.id
  member_role text not null check (member_role in ('owner','conductor')),
  created_at timestamptz default now(),
  unique (matatu_id, user_id)
);
create index if not exists matatu_members_matatu_idx on matatu_members(matatu_id);
create index if not exists matatu_members_user_idx   on matatu_members(user_id);

create table if not exists cashiers (
  id uuid primary key default gen_random_uuid(),
  sacco_id  uuid not null references saccos(id) on delete cascade,
  branch_id uuid,
  matatu_id uuid references matatus(id) on delete set null,
  name text not null,
  phone text,
  ussd_code text unique,          -- e.g. *001*110#
  active boolean default true,
  created_at timestamptz default now()
);
create index if not exists cashiers_sacco_idx  on cashiers(sacco_id);
create index if not exists cashiers_matatu_idx on cashiers(matatu_id);

-- ---------- RULESET / SETTINGS ----------
create table if not exists sacco_settings (
  sacco_id uuid primary key references saccos(id) on delete cascade,
  fare_fee_flat_kes  numeric(10,2) not null default 2.50,  -- passenger fee charged by TekeTeke
  savings_percent    numeric(5,2)  not null default 5.00,  -- % of fare
  sacco_daily_fee_kes numeric(10,2) not null default 50.00, -- once per day per matatu
  loan_repay_percent numeric(5,2)  not null default 0.00,   -- % of fare
  updated_at timestamptz default now()
);

-- ---------- TRANSACTIONS & LEDGER ----------
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  sacco_id  uuid references saccos(id)  on delete set null,
  matatu_id uuid references matatus(id) on delete set null,
  cashier_id uuid references cashiers(id) on delete set null,
  ussd_code text,
  passenger_msisdn text,
  fare_amount_kes numeric(10,2) not null,
  service_fee_kes numeric(10,2) not null default 2.50, -- passenger fee (policy snapshot)
  mpesa_merchant_fee_kes numeric(10,2) default 0.00,   -- till fee (client/merchant cost)
  status text not null check (status in ('PENDING','SUCCESS','FAILED','TIMEOUT')) default 'PENDING',
  mpesa_checkout_id text unique,                       -- idempotency anchor
  mpesa_receipt text,
  created_at timestamptz default now()
);
create index if not exists transactions_sacco_idx   on transactions(sacco_id);
create index if not exists transactions_matatu_idx  on transactions(matatu_id);
create index if not exists transactions_cashier_idx on transactions(cashier_id);
create index if not exists transactions_status_idx  on transactions(status);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade,
  sacco_id  uuid,
  matatu_id uuid,
  type text not null check (type in ('FARE','SERVICE_FEE','SACCO_FEE','SAVINGS','LOAN_REPAY')),
  amount_kes numeric(10,2) not null,
  created_at timestamptz default now()
);
create index if not exists ledger_tx_idx    on ledger_entries(transaction_id);
create index if not exists ledger_sacco_idx on ledger_entries(sacco_id);
create index if not exists ledger_matatu_idx on ledger_entries(matatu_id);
create index if not exists ledger_type_idx  on ledger_entries(type);

-- Helper view: did we take SACCO_FEE today for a given matatu?
create or replace view v_sacco_fee_today as
select
  matatu_id,
  date_trunc('day', created_at) as day,
  count(*) as cnt
from ledger_entries
where type = 'SACCO_FEE'
group by matatu_id, date_trunc('day', created_at);

-- ---------- DAILY FEES (used by /fees/* endpoints) ----------
create table if not exists daily_fees (
  id uuid primary key default gen_random_uuid(),
  matatu_id uuid not null references matatus(id) on delete cascade,
  amount    numeric(10,2) not null,
  paid_at   date default current_date,
  created_at timestamptz default now()
);
create index if not exists daily_fees_matatu_idx on daily_fees(matatu_id, paid_at);

-- ---------- POS LATEST (for cashier amount prefill) ----------
create table if not exists pos_latest (
  cashier_id text primary key,
  amount_kes numeric(10,2) not null,
  updated_at timestamptz default now()
);

-- ---------- (Optional) seed defaults ----------
insert into sacco_settings (sacco_id, fare_fee_flat_kes, savings_percent, sacco_daily_fee_kes, loan_repay_percent)
select id, 2.50, 5.00, 50.00, 0.00 from saccos
on conflict (sacco_id) do nothing;

-- =============================================================
-- USSD POOL (aligned with server.js field names)
-- =============================================================
-- Table to manage 001..999 bases and their checksum (digital root)
create table if not exists ussd_pool (
  base text primary key,          -- '001'..'999'
  checksum text not null,         -- '1'..'9' (digital root of base)

  -- field names expected by server.js:
  allocated boolean not null default false,
  level text check (level in ('MATATU','SACCO','CASHIER')),
  sacco_id  uuid,
  matatu_id uuid,
  cashier_id uuid,
  allocated_at timestamptz
);

-- Format/consistency guards
alter table ussd_pool
  add constraint if not exists ussd_base_format
  check (base ~ '^[0-9]{3}$' and base <> '000');

alter table ussd_pool
  add constraint if not exists ussd_checksum_format
  check (checksum ~ '^[1-9]$');

-- checksum must equal digital-root of the 3 digits in base
alter table ussd_pool
  add constraint if not exists ussd_checksum_matches_base
  check (
    (checksum)::int = (
      (( (substring(base from 1 for 1)::int
        + substring(base from 2 for 1)::int
        + substring(base from 3 for 1)::int) - 1) % 9) + 1
    )
  );

-- keep allocation fields in sync
alter table ussd_pool
  add constraint if not exists ussd_allocated_fields
  check (
    (allocated = false and level is null and sacco_id is null and matatu_id is null and cashier_id is null)
    or
    (allocated = true and (
        (level = 'SACCO'   and sacco_id  is not null and matatu_id is null and cashier_id is null) or
        (level = 'MATATU'  and matatu_id is not null and sacco_id  is null and cashier_id is null) or
        (level = 'CASHIER' and cashier_id is not null and sacco_id is null and matatu_id is null)
    ))
  );

-- helpful indexes
create index if not exists ussd_pool_alloc_idx on ussd_pool(allocated, allocated_at desc);

-- Seed 001..999 with correct checksums (idempotent)
insert into ussd_pool(base, checksum)
select lpad(n::text, 3, '0') as base,
       (((n - 1) % 9) + 1)::text as checksum
from generate_series(1, 999) as t(n)
on conflict (base) do nothing;

-- =============================================================
-- ADMIN VIEWS used by server.js dashboards
-- =============================================================

-- Today's TX count + sum of SERVICE_FEE per SACCO
drop view if exists v_tx_today_by_sacco;
create view v_tx_today_by_sacco as
select
  t.sacco_id,
  count(*)::bigint as tx_count,
  coalesce(sum(le.amount_kes), 0)::numeric(12,2) as fees_sum
from transactions t
left join ledger_entries le
  on le.transaction_id = t.id and le.type = 'SERVICE_FEE'
where t.status = 'SUCCESS'
  and t.created_at >= date_trunc('day', now())
group by t.sacco_id;

-- Yesterday's TX count + sum of SERVICE_FEE per SACCO
drop view if exists v_tx_yesterday_by_sacco;
create view v_tx_yesterday_by_sacco as
select
  t.sacco_id,
  count(*)::bigint as tx_count,
  coalesce(sum(le.amount_kes), 0)::numeric(12,2) as fees_sum
from transactions t
left join ledger_entries le
  on le.transaction_id = t.id and le.type = 'SERVICE_FEE'
where t.status = 'SUCCESS'
  and t.created_at >= date_trunc('day', now()) - interval '1 day'
  and t.created_at <  date_trunc('day', now())
group by t.sacco_id;

-- =============================================================
-- SIMPLE CASHBOOK (Taxi & Boda UIs) — optional persistence
-- =============================================================

-- A single flexible table for both namespaces & kinds
create table if not exists simple_cashbook (
  id uuid primary key default gen_random_uuid(),
  namespace text not null check (namespace in ('taxi','boda')),
  kind      text not null check (kind in ('CASH','EXPENSE')),
  amount    numeric(12,2) not null,
  name      text,    -- payer/vendor
  phone     text,
  category  text,
  notes     text,
  created_at timestamptz default now(),
  created_by uuid default auth.uid()   -- who recorded it (Supabase JWT)
);
create index if not exists simple_cashbook_ns_day_idx on simple_cashbook(namespace, created_at desc);
create index if not exists simple_cashbook_user_idx   on simple_cashbook(created_by);

-- Row Level Security so each user sees their own cashbook only
alter table simple_cashbook enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'simple_cashbook' and policyname = 'scb_select_own'
  ) then
    create policy scb_select_own on simple_cashbook
      for select using (created_by = auth.uid());
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'simple_cashbook' and policyname = 'scb_insert_own'
  ) then
    create policy scb_insert_own on simple_cashbook
      for insert with check (created_by = auth.uid());
  end if;
end $$;

-- =============================================================
-- DONE
-- =============================================================
