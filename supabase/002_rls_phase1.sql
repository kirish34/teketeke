-- RLS Phase 1 (read-only) for TekeTeke core tables

-- Enable extensions if needed
create extension if not exists pgcrypto;

-- 1) Enable RLS
alter table if exists sacco_users     enable row level security;
alter table if exists matatu_members  enable row level security;
alter table if exists matatus         enable row level security;
alter table if exists transactions    enable row level security;
alter table if exists ledger_entries  enable row level security;
-- ussd_pool: no RLS policy (admin-only via service role)

-- 2) Policies (SELECT only)

-- sacco_users: user sees own membership rows
do $$
begin
  if not exists (select 1 from pg_policies where tablename='sacco_users' and policyname='sacco_users_select_self') then
    create policy sacco_users_select_self
      on sacco_users for select
      using (user_id = auth.uid());
  end if;
end$$;

-- matatus: user sees matatus in saccos they belong to
do $$
begin
  if not exists (select 1 from pg_policies where tablename='matatus' and policyname='matatus_select_by_membership') then
    create policy matatus_select_by_membership
      on matatus for select
      using (
        sacco_id in (select sacco_id from sacco_users where user_id = auth.uid())
      );
  end if;
end$$;

-- transactions: user sees sacco-scoped
do $$
begin
  if not exists (select 1 from pg_policies where tablename='transactions' and policyname='transactions_select_by_membership') then
    create policy transactions_select_by_membership
      on transactions for select
      using (
        sacco_id in (select sacco_id from sacco_users where user_id = auth.uid())
      );
  end if;
end$$;

-- ledger_entries: user sees sacco-scoped
do $$
begin
  if not exists (select 1 from pg_policies where tablename='ledger_entries' and policyname='ledger_entries_select_by_membership') then
    create policy ledger_entries_select_by_membership
      on ledger_entries for select
      using (
        sacco_id in (select sacco_id from sacco_users where user_id = auth.uid())
      );
  end if;
end$$;

-- Optional: helper view for today’s TX and fees with same sacco scoping
create or replace view v_tx_today_by_sacco as
select
  t.sacco_id,
  count(*)::int as tx_today,
  coalesce(sum(case when le.type = 'SACCO_FEE' then le.amount_kes end),0)::numeric as fees_today_kes
from transactions t
left join ledger_entries le on le.sacco_id = t.sacco_id and le.created_at::date = now()::date
where t.created_at::date = now()::date
group by t.sacco_id;

-- Apply RLS to the view through underlying tables (no direct policies on view)

