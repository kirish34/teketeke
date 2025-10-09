-- Tighten core constraints & indexes (safe/idempotent)

-- saccos
alter table if exists saccos
  alter column name set not null;

-- matatus
alter table if exists matatus
  alter column sacco_id set not null;
do $$ begin
  if not exists (select 1 from pg_indexes where tablename='matatus' and indexname='uq_matatus_number_plate') then
    create unique index uq_matatus_number_plate on matatus(lower(number_plate));
  end if;
end $$;

-- sacco_users unique pair
do $$ begin
  if not exists (select 1 from pg_indexes where tablename='sacco_users' and indexname='uq_sacco_users_user_sacco') then
    create unique index uq_sacco_users_user_sacco on sacco_users(user_id, sacco_id);
  end if;
end $$;

-- ledger_entries
alter table if exists ledger_entries
  alter column sacco_id set not null;
alter table if exists ledger_entries
  add constraint chk_ledger_amount_positive check (amount_kes > 0) not valid;
alter table if exists ledger_entries validate constraint chk_ledger_amount_positive;

