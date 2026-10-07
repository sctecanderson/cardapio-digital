begin;

-- Identificação pública dos restaurantes.
-- Não adicionar dados privados nesta tabela.
create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  subtitle text,
  active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint restaurants_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),

  constraint restaurants_name_not_empty
    check (length(btrim(name)) > 0)
);

-- Mesas permanentes de cada restaurante.
create table public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,
  table_number smallint not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint restaurant_tables_number_range
    check (table_number between 1 and 999),

  constraint restaurant_tables_unique_number
    unique (restaurant_id, table_number)
);

-- Vínculo entre uma conta autenticada e um restaurante.
-- Ter uma conta não significa ter acesso operacional.
create table public.restaurant_members (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  role text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint restaurant_members_valid_role
    check (role in ('admin', 'waiter')),

  constraint restaurant_members_unique_user
    unique (restaurant_id, user_id)
);

create index restaurant_members_user_id_idx
  on public.restaurant_members (user_id);

-- Habilitar proteção por registro.
alter table public.restaurants enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.restaurant_members enable row level security;

-- Remover permissões eventualmente concedidas por padrão.
revoke all privileges
  on table public.restaurants,
           public.restaurant_tables,
           public.restaurant_members
  from public, anon, authenticated;

-- Visitantes podem consultar apenas a identificação pública.
grant select on table public.restaurants
  to anon, authenticated;

-- Usuários autenticados podem consultar mesas e vínculos,
-- desde que as políticas abaixo permitam.
grant select
  on table public.restaurant_tables,
           public.restaurant_members
  to authenticated;

-- Restaurantes ativos são públicos.
create policy restaurants_read_active
  on public.restaurants
  for select
  to anon, authenticated
  using (active = true);

-- Cada usuário pode consultar somente seus próprios vínculos.
create policy restaurant_members_read_own
  on public.restaurant_members
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Mesas são consultadas apenas por membros ativos
-- do restaurante ao qual elas pertencem.
create policy restaurant_tables_read_by_members
  on public.restaurant_tables
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurant_members as member
      where member.restaurant_id =
            restaurant_tables.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
    )
  );

commit;