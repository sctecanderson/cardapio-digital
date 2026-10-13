begin;

-- Permitir uma chave estrangeira que confira sessão,
-- restaurante e mesa conjuntamente.
alter table public.guest_sessions
  add constraint guest_sessions_id_restaurant_table_unique
  unique (id, restaurant_id, restaurant_table_id);

create table public.service_request_guests (
  service_request_id uuid not null,
  guest_session_id uuid not null,
  restaurant_id uuid not null,
  restaurant_table_id uuid not null,

  linked_at timestamptz not null default now(),

  primary key (service_request_id, guest_session_id),

  constraint service_request_guests_request_same_table
    foreign key (
      service_request_id,
      restaurant_id,
      restaurant_table_id
    )
    references public.service_requests (
      id,
      restaurant_id,
      restaurant_table_id
    )
    on delete cascade,

  constraint service_request_guests_session_same_table
    foreign key (
      guest_session_id,
      restaurant_id,
      restaurant_table_id
    )
    references public.guest_sessions (
      id,
      restaurant_id,
      restaurant_table_id
    )
    on delete cascade
);

create index service_request_guests_session_idx
  on public.service_request_guests (guest_session_id);

alter table public.service_request_guests
  enable row level security;

revoke all privileges
  on table public.service_request_guests
  from public, anon, authenticated;

grant select
  on table public.service_request_guests
  to authenticated;

-- O cliente só pode consultar seus próprios vínculos,
-- enquanto sua sessão estiver válida.
create policy service_request_guests_read_own
  on public.service_request_guests
  for select
  to authenticated
  using (
    coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.guest_sessions as guest
      where guest.id = service_request_guests.guest_session_id
        and guest.user_id = (select auth.uid())
        and guest.status in ('pending', 'active')
        and guest.expires_at > now()
    )
  );

-- Permitir ao cliente acompanhar apenas os chamados
-- vinculados a uma de suas sessões válidas.
create policy service_requests_read_by_linked_guests
  on public.service_requests
  for select
  to authenticated
  using (
    coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.service_request_guests as link
      join public.guest_sessions as guest
        on guest.id = link.guest_session_id
      join public.restaurants as restaurant
        on restaurant.id = guest.restaurant_id
      where link.service_request_id = service_requests.id
        and guest.user_id = (select auth.uid())
        and guest.status in ('pending', 'active')
        and guest.expires_at > now()
        and restaurant.active = true
    )
  );

commit;