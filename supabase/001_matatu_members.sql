-- Matatu membership table used by code (idempotent)
create table if not exists matatu_members (
  id uuid primary key default gen_random_uuid(),
  matatu_id uuid not null references matatus(id) on delete cascade,
  user_id uuid not null, -- supabase.auth.users.id
  member_role text not null check (member_role in ('SACCO_ADMIN','STAFF','OWNER','CONDUCTOR')),
  created_at timestamptz default now()
);

create index if not exists idx_matatu_members_user on matatu_members(user_id);
create index if not exists idx_matatu_members_matatu on matatu_members(matatu_id);

