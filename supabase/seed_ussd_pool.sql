-- Seed 30 free USSD bases (three-digit bases 110..139)
-- Schema assumed: ussd_pool(base text, checksum text, allocated bool default false, level text, sacco_id uuid, matatu_id uuid, allocated_at timestamptz)

with bases as (
  select lpad(g::text, 3, '0') as base_txt
  from generate_series(110, 139) as g
),
digital_root as (
  select base_txt,
         case
           when (base_txt ~ '^\d+$') is false then '0'
           else (
             -- digital root: 1 + ((n-1) % 9) for n>0
             case when (base_txt)::int = 0 then '0'
                  else (1 + (((base_txt)::int - 1) % 9))::text
             end
           )
         end as checksum
  from bases
)
insert into ussd_pool (base, checksum, allocated)
select base_txt, checksum, false
from digital_root
on conflict (base) do nothing;

-- Verify
select base, checksum, allocated
from ussd_pool
where base between '110' and '139'
order by base;

