begin;

-- Histórico privado das mudanças de disponibilidade.
create table public.restaurant_status_events (
  id uuid primary key default gen_random_uuid(),

  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,

  actor_user_id uuid
    references auth.users(id) on delete set null,

  previous_active boolean not null,
  new_active boolean not null,
  reason text not null,
  created_at timestamptz not null default now(),

  constraint restaurant_status_events_reason_length
    check (char_length(btrim(reason)) between 3 and 500),

  constraint restaurant_status_events_changed
    check (previous_active <> new_active)
);

create index restaurant_status_events_restaurant_date_idx
  on public.restaurant_status_events (
    restaurant_id,
    created_at desc
  );

alter table public.restaurant_status_events
  enable row level security;

revoke all privileges
  on table public.restaurant_status_events
  from public, anon, authenticated;

-- Somente administradores da Elozi podem alterar o status.
create function public.set_platform_restaurant_active(
  p_restaurant_id uuid,
  p_expected_active boolean,
  p_active boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  current_restaurant public.restaurants%rowtype;
  clean_reason text;
begin
  actor_id := public.require_platform_admin();
  clean_reason := btrim(p_reason);

  if p_restaurant_id is null
    or p_expected_active is null
    or p_active is null
    or clean_reason is null
    or char_length(clean_reason) not between 3 and 500
  then
    raise exception using
      errcode = '22023',
      message = 'Informe o restaurante, o status e um motivo de 3 a 500 caracteres.';
  end if;

  select *
  into current_restaurant
  from public.restaurants
  where id = p_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Restaurante não encontrado.';
  end if;

  -- Repetir uma solicitação concluída não duplica o histórico.
  if current_restaurant.active = p_active then
    return jsonb_build_object(
      'id', current_restaurant.id,
      'active', current_restaurant.active
    );
  end if;

  if current_restaurant.active <> p_expected_active then
    raise exception using
      errcode = '40001',
      message = 'O status foi alterado por outra operação. Atualize a lista.';
  end if;

  update public.restaurants
  set active = p_active
  where id = p_restaurant_id;

  insert into public.restaurant_status_events (
    restaurant_id,
    actor_user_id,
    previous_active,
    new_active,
    reason
  )
  values (
    p_restaurant_id,
    actor_id,
    current_restaurant.active,
    p_active,
    clean_reason
  );

  return jsonb_build_object(
    'id', p_restaurant_id,
    'active', p_active
  );
end;
$$;

revoke all
  on function public.set_platform_restaurant_active(
    uuid, boolean, boolean, text
  )
  from public, anon, authenticated;

grant execute
  on function public.set_platform_restaurant_active(
    uuid, boolean, boolean, text
  )
  to authenticated;

-- Estas políticas acrescentam a exigência de restaurante ativo
-- às regras de acesso já existentes.
create policy restaurant_members_require_active_restaurant
  on public.restaurant_members
  as restrictive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurants as restaurant
      where restaurant.id = restaurant_members.restaurant_id
        and restaurant.active = true
    )
  );

create policy restaurant_tables_require_active_restaurant
  on public.restaurant_tables
  as restrictive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurants as restaurant
      where restaurant.id = restaurant_tables.restaurant_id
        and restaurant.active = true
    )
  );

create policy table_visits_require_active_restaurant
  on public.table_visits
  as restrictive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurants as restaurant
      where restaurant.id = table_visits.restaurant_id
        and restaurant.active = true
    )
  );

create policy guest_sessions_require_active_restaurant
  on public.guest_sessions
  as restrictive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurants as restaurant
      where restaurant.id = guest_sessions.restaurant_id
        and restaurant.active = true
    )
  );

notify pgrst, 'reload schema';

commit;