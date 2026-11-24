create table if not exists public.maker_ops_real (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens(id) on delete cascade,
  transaction_date date not null,
  amount bigint not null check (amount > 0),
  updated_by uuid not null references public.maker_profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kitchen_id, transaction_date)
);

alter table public.maker_ops_real enable row level security;
revoke all on public.maker_ops_real from anon, authenticated;
grant all on public.maker_ops_real to service_role;

create index if not exists maker_ops_real_transaction_date_idx
  on public.maker_ops_real (transaction_date desc);
