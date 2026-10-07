begin;

-- Permitir referências que garantam o mesmo restaurante.
alter table public.restaurant_tables
  add constraint restaurant_tables_id_restaurant_unique
  unique (id, restaurant_id);

alter table public.restaurant_members
  add constraint restaurant_members_id_restaurant_unique
  unique (id, restaurant_id);

-- Uma ocupação específica de uma mesa.
create table public.table_visits (
  id uuid primary key default gen_random_uuid(),

  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,

  restaurant_table_id uuid not null,

  assigned_member_id uuid,

  status text not null default 'open',

  opened_at timestamptz not null default now(),
  closed_at timestamptz,

  constraint table_visits_table_same_restaurant
    foreign key (restaurant_table_id, restaurant_id)
    references public.restaurant_tables (id, restaurant_id)
    on delete restrict,

  constraint table_visits_member_same_restaurant
    foreign key (assigned_member_id, restaurant_id)
    references public.restaurant_members (id, restaurant_id)
    on delete restrict,

  constraint table_visits_valid_status
    check (status in ('open', 'closed')),

  constraint table_visits_valid_closure
    check (
      (status = 'open' and closed_at is null)
      or
      (
        status = 'closed'
        and closed_at is not null
        and closed_at >= opened_at
      )
    ),

  -- Será utilizado para vincular sessões ao atendimento
  -- garantindo também restaurante e mesa.
  constraint table_visits_id_restaurant_table_unique
    unique (id, restaurant_id, restaurant_table_id)
);

-- Uma mesa não pode ter dois atendimentos abertos.
create unique index table_visits_one_open_per_table
  on public.table_visits (restaurant_table_id)
  where status = 'open';

-- Facilitar consultas do painel operacional.
create index table_visits_restaurant_status_idx
  on public.table_visits (restaurant_id, status);

-- Proteger acesso aos registros.
alter table public.table_visits enable row level security;

revoke all privileges
  on table public.table_visits
  from public, anon, authenticated;

grant select on table public.table_visits
  to authenticated;

-- Membros ativos podem consultar atendimentos
-- somente dos restaurantes aos quais estão vinculados.
create policy table_visits_read_by_members
  on public.table_visits
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurant_members as member
      where member.restaurant_id = table_visits.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
    )
  );

commit;