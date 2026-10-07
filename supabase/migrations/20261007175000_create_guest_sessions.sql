begin;

create table public.guest_sessions (
  id uuid primary key default gen_random_uuid(),

  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,

  restaurant_table_id uuid not null,

  user_id uuid not null
    references auth.users(id) on delete cascade,

  table_visit_id uuid,
  confirmed_by_member_id uuid,
  confirmed_at timestamptz,

  status text not null default 'pending',

  created_at timestamptz not null default now(),
  expires_at timestamptz not null
    default (now() + interval '24 hours'),

  constraint guest_sessions_table_same_restaurant
    foreign key (restaurant_table_id, restaurant_id)
    references public.restaurant_tables (id, restaurant_id)
    on delete restrict,

  -- A sessão só pode pertencer a um atendimento
  -- do mesmo restaurante e da mesma mesa.
  constraint guest_sessions_visit_same_table
    foreign key (
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
    references public.table_visits (
      id,
      restaurant_id,
      restaurant_table_id
    )
    on delete restrict,

  constraint guest_sessions_member_same_restaurant
    foreign key (confirmed_by_member_id, restaurant_id)
    references public.restaurant_members (id, restaurant_id)
    on delete restrict,

  constraint guest_sessions_valid_status
    check (
      status in ('pending', 'active', 'revoked', 'expired')
    ),

  constraint guest_sessions_valid_expiration
    check (expires_at > created_at),

  -- Dados de confirmação devem existir juntos.
  constraint guest_sessions_complete_confirmation
    check (
      (
        table_visit_id is null
        and confirmed_by_member_id is null
        and confirmed_at is null
      )
      or
      (
        table_visit_id is not null
        and confirmed_by_member_id is not null
        and confirmed_at is not null
        and confirmed_at >= created_at
        and confirmed_at < expires_at
      )
    ),

  constraint guest_sessions_pending_not_confirmed
    check (
      status <> 'pending'
      or table_visit_id is null
    ),

  constraint guest_sessions_active_is_confirmed
    check (
      status <> 'active'
      or table_visit_id is not null
    )
);

-- Evitar sessões pendentes/ativas duplicadas
-- para o mesmo usuário na mesma mesa.
create unique index guest_sessions_one_current_per_user_table
  on public.guest_sessions (
    user_id,
    restaurant_table_id
  )
  where status in ('pending', 'active');

create index guest_sessions_restaurant_status_idx
  on public.guest_sessions (restaurant_id, status);

create index guest_sessions_visit_idx
  on public.guest_sessions (table_visit_id)
  where table_visit_id is not null;

alter table public.guest_sessions enable row level security;

revoke all privileges
  on table public.guest_sessions
  from public, anon, authenticated;

grant select on table public.guest_sessions
  to authenticated;

-- Cliente autenticado pode consultar suas próprias sessões.
create policy guest_sessions_read_own
  on public.guest_sessions
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Equipe ativa pode consultar sessões do seu restaurante.
create policy guest_sessions_read_by_members
  on public.guest_sessions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurant_members as member
      where member.restaurant_id = guest_sessions.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
    )
  );

commit;