-- =========================
-- TekeTeke Core Schema (Supabase / Postgres)
-- =========================

-- ---------- ORGS & USERS ----------
create table if not exists saccos (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  contact_phone text,
  contact_email text,
  default_till text,
  created_at timestamptz default now()
);

create table if not exists sacco_users (
  id uuid primary key default gen_random_uuid(),
  sacco_id uuid not null references saccos(id) on delete cascade,
  user_id uuid not null, -- supabase.auth.users.id
  role text not null check (role in ('SUPER_ADMIN','SACCO_ADMIN','STAFF','OWNER','BRANCH_MANAGER','CONDUCTOR')),
  created_at timestamptz default now()
);

create index if not exists sacco_users_sacco_idx on sacco_users(sacco_id);
create index if not exists sacco_users_user_idx on sacco_users(user_id);

-- ---------- CATALOG ----------
create table if not exists matatus (
  id uuid primary key default gen_random_uuid(),
  sacco_id uuid not null references saccos(id) on delete cascade,
  number_plate text not null,
  owner_name text,
  owner_phone text,
  vehicle_type text check (vehicle_type in ('bus','minibus','van')),
  tlb_number text,
  till_number text,
  created_at timestamptz default now(),
  unique(number_plate)
);
create index if not exists matatus_sacco_idx on matatus(sacco_id);
create index if not exists matatus_till_idx on matatus(till_number);

create table if not exists cashiers (
  id uuid primary key default gen_random_uuid(),
  sacco_id uuid not null references saccos(id) on delete cascade,
  branch_id uuid,
  matatu_id uuid references matatus(id) on delete set null,
  name text not null,
  phone text,
  ussd_code text unique,    -- e.g. *001*110#
  active boolean default true,
  created_at timestamptz default now()
);
create index if not exists cashiers_sacco_idx on cashiers(sacco_id);
create index if not exists cashiers_matatu_idx on cashiers(matatu_id);

-- ---------- RULESET / SETTINGS ----------
create table if not exists sacco_settings (
  sacco_id uuid primary key references saccos(id) on delete cascade,
  fare_fee_flat_kes numeric(10,2) not null default 2.50,  -- passenger fee charged by TekeTeke
  savings_percent   numeric(5,2)  not null default 5.00,  -- % of fare
  sacco_daily_fee_kes numeric(10,2) not null default 50.00, -- once per day per matatu
  loan_repay_percent numeric(5,2) not null default 0.00,   -- % of fare
  updated_at timestamptz default now()
);

-- ---------- TRANSACTIONS & LEDGER ----------
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  sacco_id uuid references saccos(id) on delete set null,
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
create index if not exists transactions_sacco_idx on transactions(sacco_id);
create index if not exists transactions_matatu_idx on transactions(matatu_id);
create index if not exists transactions_cashier_idx on transactions(cashier_id);
create index if not exists transactions_status_idx on transactions(status);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references transactions(id) on delete cascade,
  sacco_id uuid,
  matatu_id uuid,
  type text not null check (type in ('FARE','SERVICE_FEE','SACCO_FEE','SAVINGS','LOAN_REPAY')),
  amount_kes numeric(10,2) not null,
  created_at timestamptz default now()
);
create index if not exists ledger_tx_idx on ledger_entries(transaction_id);
create index if not exists ledger_sacco_idx on ledger_entries(sacco_id);
create index if not exists ledger_matatu_idx on ledger_entries(matatu_id);
create index if not exists ledger_type_idx on ledger_entries(type);

-- Helper view: did we take SACCO_FEE today for a given matatu?
create or replace view v_sacco_fee_today as
select
  matatu_id,
  date_trunc('day', created_at) as day,
  count(*) as cnt
from ledger_entries
where type = 'SACCO_FEE'
group by matatu_id, date_trunc('day', created_at);

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
