-- Daily TX/fees by sacco with Today/Yesterday helpers

create or replace view v_tx_daily_by_sacco as
select
  t.sacco_id,
  (t.created_at::date) as day,
  count(*)::int as tx_count,
  coalesce(sum(case when le.type = 'SACCO_FEE' then le.amount_kes end),0)::numeric as fees_sum
from transactions t
left join ledger_entries le
  on le.sacco_id = t.sacco_id
 and le.created_at::date = t.created_at::date
group by t.sacco_id, (t.created_at::date);

create or replace view v_tx_today_by_sacco as
select * from v_tx_daily_by_sacco
where day = now()::date;

create or replace view v_tx_yesterday_by_sacco as
select * from v_tx_daily_by_sacco
where day = (now()::date - interval '1 day')::date;

