begin;

create table public.service_requests (
  id uuid primary key default gen_random_uuid(),

  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,

  restaurant_table_id uuid not null,
  table_visit_id uuid,

  request_type text not null,
  status text not null default 'pending',

  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_member_id uuid,

  constraint service_requests_table_same_restaurant
    foreign key (restaurant_table_id, restaurant_id)
    references public.restaurant_tables (id, restaurant_id)
    on delete restrict,

  constraint service_requests_visit_same_table
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

  constraint service_requests_member_same_restaurant
    foreign key (resolved_by_member_id, restaurant_id)
    references public.restaurant_members (id, restaurant_id)
    on delete restrict,

  constraint service_requests_valid_type
    check (request_type in ('waiter', 'bill')),

  constraint service_requests_valid_status
    check (status in ('pending', 'attended', 'cancelled')),

  constraint service_requests_bill_requires_visit
    check (
      request_type <> 'bill'
      or table_visit_id is not null
    ),

  constraint service_requests_valid_resolution
    check (
      (
        status = 'pending'
        and resolved_at is null
        and resolved_by_member_id is null
      )
      or
      (
        status = 'attended'
        and resolved_at is not null
        and resolved_by_member_id is not null
        and resolved_at >= created_at
      )
      or
      (
        status = 'cancelled'
        and resolved_at is not null
        and resolved_at >= created_at
      )
    ),

  constraint service_requests_id_restaurant_table_unique
    unique (id, restaurant_id, restaurant_table_id)
);

-- Impedir chamados pendentes duplicados do mesmo tipo na mesa.
create unique index service_requests_one_pending_per_table_type
  on public.service_requests (
    restaurant_table_id,
    request_type
  )
  where status = 'pending';

-- Consultas da fila operacional por restaurante e status.
create index service_requests_restaurant_status_created_idx
  on public.service_requests (
    restaurant_id,
    status,
    created_at
  );

create index service_requests_visit_idx
  on public.service_requests (table_visit_id)
  where table_visit_id is not null;

alter table public.service_requests
  enable row level security;

-- O navegador não poderá inserir, alterar ou apagar diretamente.
revoke all privileges
  on table public.service_requests
  from public, anon, authenticated;

grant select
  on table public.service_requests
  to authenticated;

-- Nesta etapa, somente a equipe ativa do restaurante pode ler.
create policy service_requests_read_by_members
  on public.service_requests
  for select
  to authenticated
  using (
    not coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant
        on restaurant.id = member.restaurant_id
      where member.restaurant_id = service_requests.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role in ('admin', 'waiter')
        and restaurant.active = true
    )
  );

commit;