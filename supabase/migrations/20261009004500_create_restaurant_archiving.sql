begin;

alter table public.restaurants
  add column archived_at timestamptz;

alter table public.restaurants
  add constraint restaurants_archived_must_be_inactive
  check (archived_at is null or active = false);

-- Histórico privado de arquivamento e restauração.
create table public.restaurant_archive_events (
  id uuid primary key default gen_random_uuid(),

  restaurant_id uuid not null
    references public.restaurants(id) on delete restrict,

  actor_user_id uuid
    references auth.users(id) on delete set null,

  action text not null
    check (action in ('archive', 'restore')),

  previous_active boolean not null,

  reason text not null
    check (char_length(btrim(reason)) between 3 and 500),

  created_at timestamptz not null default now()
);

create index restaurant_archive_events_restaurant_date_idx
  on public.restaurant_archive_events (
    restaurant_id,
    created_at desc
  );

alter table public.restaurant_archive_events
  enable row level security;

revoke all privileges
  on table public.restaurant_archive_events
  from public, anon, authenticated;

-- Impede reativação direta de um restaurante arquivado,
-- inclusive pela função ON/OFF já existente.
create function public.guard_archived_restaurant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.archived_at is not null and new.active then
    raise exception using
      errcode = '22023',
      message = 'Restaure o restaurante antes de reativá-lo.';
  end if;

  return new;
end;
$$;

revoke all
  on function public.guard_archived_restaurant()
  from public, anon, authenticated;

create trigger restaurants_guard_archived
  before insert or update of active, archived_at
  on public.restaurants
  for each row
  execute function public.guard_archived_restaurant();

create function public.set_platform_restaurant_archived(
  p_restaurant_id uuid,
  p_archived boolean,
  p_confirmation_name text,
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
  next_archived_at timestamptz;
begin
  actor_id := public.require_platform_admin();
  clean_reason := btrim(p_reason);

  if p_restaurant_id is null
    or p_archived is null
    or p_confirmation_name is null
    or clean_reason is null
    or char_length(clean_reason) not between 3 and 500
  then
    raise exception using
      errcode = '22023',
      message = 'Informe o restaurante, a confirmação e um motivo de 3 a 500 caracteres.';
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

  if btrim(p_confirmation_name) <> current_restaurant.name then
    raise exception using
      errcode = '22023',
      message = 'Digite o nome exato do restaurante para confirmar.';
  end if;

  -- Uma repetição da mesma ação não duplica o histórico.
  if (current_restaurant.archived_at is not null) = p_archived then
    return jsonb_build_object(
      'id', current_restaurant.id,
      'active', current_restaurant.active,
      'archivedAt', current_restaurant.archived_at
    );
  end if;

  next_archived_at := case
    when p_archived then now()
    else null
  end;

  -- Tanto arquivar quanto restaurar deixam o restaurante suspenso.
  update public.restaurants
  set
    active = false,
    archived_at = next_archived_at
  where id = p_restaurant_id;

  insert into public.restaurant_archive_events (
    restaurant_id,
    actor_user_id,
    action,
    previous_active,
    reason
  )
  values (
    p_restaurant_id,
    actor_id,
    case when p_archived then 'archive' else 'restore' end,
    current_restaurant.active,
    clean_reason
  );

  if current_restaurant.active then
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
      true,
      false,
      'Suspensão por arquivamento do restaurante.'
    );
  end if;

  return jsonb_build_object(
    'id', p_restaurant_id,
    'active', false,
    'archivedAt', next_archived_at
  );
end;
$$;

revoke all
  on function public.set_platform_restaurant_archived(
    uuid, boolean, text, text
  )
  from public, anon, authenticated;

grant execute
  on function public.set_platform_restaurant_archived(
    uuid, boolean, text, text
  )
  to authenticated;

-- A listagem passa a informar também o arquivamento.
create or replace function public.list_platform_restaurants()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_platform_admin();

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', restaurant.id,
          'name', restaurant.name,
          'slug', restaurant.slug,
          'active', restaurant.active,
          'archivedAt', restaurant.archived_at,
          'createdAt', restaurant.created_at,
          'adminCount', (
            select count(*)
            from public.restaurant_members as member
            where member.restaurant_id = restaurant.id
              and member.role = 'admin'
              and member.active = true
          )
        )
        order by restaurant.created_at desc, restaurant.id
      )
      from public.restaurants as restaurant
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all
  on function public.list_platform_restaurants()
  from public, anon, authenticated;

grant execute
  on function public.list_platform_restaurants()
  to authenticated;

notify pgrst, 'reload schema';

commit;