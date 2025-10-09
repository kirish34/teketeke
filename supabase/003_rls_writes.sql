-- RLS Phase 2: write policies for TekeTeke (daily_fees, transactions, pos_latest)

-- Ensure RLS is enabled (idempotent; safe if already enabled)
alter table if exists ledger_entries enable row level security;
alter table if exists transactions   enable row level security;
alter table if exists pos_latest     enable row level security;
alter table if exists daily_fees     enable row level security;

-- INSERT/UPDATE on ledger_entries (if used for fees)
do $$
begin
  if not exists (select 1 from pg_policies where tablename='ledger_entries' and policyname='ledger_ins_by_sacco_admin') then
    create policy ledger_ins_by_sacco_admin
    on ledger_entries for insert
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from sacco_users su
        where su.user_id = auth.uid()
          and su.sacco_id = ledger_entries.sacco_id
          and su.role = 'SACCO_ADMIN'
      )
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='ledger_entries' and policyname='ledger_upd_by_sacco_admin') then
    create policy ledger_upd_by_sacco_admin
    on ledger_entries for update
    using (
      auth.role() = 'service_role'
      or exists (
        select 1 from sacco_users su
        where su.user_id = auth.uid()
          and su.sacco_id = ledger_entries.sacco_id
          and su.role = 'SACCO_ADMIN'
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from sacco_users su
        where su.user_id = auth.uid()
          and su.sacco_id = ledger_entries.sacco_id
          and su.role = 'SACCO_ADMIN'
      )
    );
  end if;
end$$;

-- INSERT/UPDATE on transactions (if writes happen here)
do $$
begin
  if not exists (select 1 from pg_policies where tablename='transactions' and policyname='tx_ins_by_sacco_admin') then
    create policy tx_ins_by_sacco_admin
    on transactions for insert
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from sacco_users su
        where su.user_id = auth.uid()
          and su.sacco_id = transactions.sacco_id
          and su.role = 'SACCO_ADMIN'
      )
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='transactions' and policyname='tx_upd_by_sacco_admin') then
    create policy tx_upd_by_sacco_admin
    on transactions for update
    using (
      auth.role() = 'service_role'
      or exists (
        select 1 from sacco_users su
        where su.user_id = auth.uid()
          and su.sacco_id = transactions.sacco_id
          and su.role = 'SACCO_ADMIN'
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from sacco_users su
        where su.user_id = auth.uid()
          and su.sacco_id = transactions.sacco_id
          and su.role = 'SACCO_ADMIN'
      )
    );
  end if;
end$$;

-- INSERT/UPDATE on pos_latest (link via cashier -> sacco)
do $$
begin
  if not exists (select 1 from pg_policies where tablename='pos_latest' and policyname='pos_ins_by_sacco_admin') then
    create policy pos_ins_by_sacco_admin
    on pos_latest for insert
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from cashiers c
        join sacco_users su on su.sacco_id = c.sacco_id
        where su.user_id = auth.uid()
          and su.role = 'SACCO_ADMIN'
          and c.id::text = pos_latest.cashier_id
      )
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='pos_latest' and policyname='pos_upd_by_sacco_admin') then
    create policy pos_upd_by_sacco_admin
    on pos_latest for update
    using (
      auth.role() = 'service_role'
      or exists (
        select 1 from cashiers c
        join sacco_users su on su.sacco_id = c.sacco_id
        where su.user_id = auth.uid()
          and su.role = 'SACCO_ADMIN'
          and c.id::text = pos_latest.cashier_id
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from cashiers c
        join sacco_users su on su.sacco_id = c.sacco_id
        where su.user_id = auth.uid()
          and su.role = 'SACCO_ADMIN'
          and c.id::text = pos_latest.cashier_id
      )
    );
  end if;
end$$;

-- INSERT/UPDATE on daily_fees (link via matatu -> sacco)
do $$
begin
  if not exists (select 1 from pg_policies where tablename='daily_fees' and policyname='fees_ins_by_sacco_admin') then
    create policy fees_ins_by_sacco_admin
    on daily_fees for insert
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from matatus m
        join sacco_users su on su.sacco_id = m.sacco_id
        where su.user_id = auth.uid()
          and su.role = 'SACCO_ADMIN'
          and m.id = daily_fees.matatu_id
      )
    );
  end if;
  if not exists (select 1 from pg_policies where tablename='daily_fees' and policyname='fees_upd_by_sacco_admin') then
    create policy fees_upd_by_sacco_admin
    on daily_fees for update
    using (
      auth.role() = 'service_role'
      or exists (
        select 1 from matatus m
        join sacco_users su on su.sacco_id = m.sacco_id
        where su.user_id = auth.uid()
          and su.role = 'SACCO_ADMIN'
          and m.id = daily_fees.matatu_id
      )
    )
    with check (
      auth.role() = 'service_role'
      or exists (
        select 1 from matatus m
        join sacco_users su on su.sacco_id = m.sacco_id
        where su.user_id = auth.uid()
          and su.role = 'SACCO_ADMIN'
          and m.id = daily_fees.matatu_id
      )
    );
  end if;
end$$;

-- No policies for ussd_pool writes: admin-only via service_role.

