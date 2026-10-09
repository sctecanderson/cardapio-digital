begin;

-- Primeira etapa do backup. Esta migration NÃO copia arquivos nem exclui dados.
-- snapshot_created nunca deve ser apresentado como backup completo.
create table public.platform_restaurant_backups (
  id uuid primary key,
  source_restaurant_id uuid not null,
  source_name text not null,
  source_slug text not null,
  format_version integer not null default 1 check (format_version = 1),
  status text not null default 'snapshot_created'
    check (status in ('snapshot_created', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  storage_inventory jsonb not null check (jsonb_typeof(storage_inventory) = 'array'),
  media_references jsonb not null check (jsonb_typeof(media_references) = 'array'),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

-- Sem FK para restaurants: uma futura exclusão não poderá apagar o backup.
create index platform_restaurant_backups_source_idx
  on public.platform_restaurant_backups (source_restaurant_id, created_at desc);
create unique index platform_restaurant_backups_one_pending_idx
  on public.platform_restaurant_backups (source_restaurant_id)
  where status = 'snapshot_created';

alter table public.platform_restaurant_backups enable row level security;
revoke all on public.platform_restaurant_backups from public, anon, authenticated;
grant select on public.platform_restaurant_backups to service_role;

-- Enquanto a cópia estiver pendente, não permitir restauração/reativação
-- pelo painel existente. Cancelar o backup libera essas operações.
create function public.guard_restaurant_pending_backup()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.platform_restaurant_backups b
    where b.source_restaurant_id = old.id and b.status = 'snapshot_created'
  ) then
    raise exception using errcode = '55000',
      message = 'Existe um backup em preparação. Conclua ou cancele a cópia antes de alterar o restaurante.';
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.guard_restaurant_pending_backup()
  from public, anon, authenticated;
create trigger restaurants_guard_pending_backup
  before update or delete on public.restaurants
  for each row execute function public.guard_restaurant_pending_backup();

create function public.create_platform_backup_snapshot(
  p_restaurant_id uuid,
  p_backup_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid;
  restaurant public.restaurants%rowtype;
  existing public.platform_restaurant_backups%rowtype;
  tenant_tables constant text[] := array[
    'restaurant_tables', 'restaurant_members', 'table_visits',
    'guest_sessions', 'service_requests', 'service_request_guests',
    'table_tabs', 'table_tab_guests', 'menu_categories', 'menu_products',
    'table_tab_items', 'menu_media_cleanup',
    'restaurant_status_events', 'restaurant_archive_events'
  ];
  table_name text;
  unknown_table text;
  rows_json jsonb;
  tables_json jsonb;
  objects_json jsonb;
  references_json jsonb;
  backup_time timestamptz := clock_timestamp();
begin
  actor_id := public.require_platform_admin();

  if p_restaurant_id is null or p_backup_id is null then
    raise exception using errcode = '22023', message = 'Informe o restaurante e o identificador do backup.';
  end if;

  -- Mesmo bloqueio de cadastro/suspensão/arquivamento. Aguarda operações
  -- anteriores e impede reativação até que o registro pendente seja criado.
  select * into restaurant from public.restaurants
    where id = p_restaurant_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Restaurante não encontrado.';
  end if;
  if restaurant.active or restaurant.archived_at is null then
    raise exception using errcode = '55000',
      message = 'Arquive o restaurante antes de preparar esta cópia de recuperação.';
  end if;

  select * into existing from public.platform_restaurant_backups where id = p_backup_id;
  if found then
    if existing.source_restaurant_id <> p_restaurant_id then
      raise exception using errcode = '22023', message = 'Identificador de backup já utilizado.';
    end if;
    return jsonb_build_object('id', existing.id, 'status', existing.status,
      'restaurantId', existing.source_restaurant_id, 'createdAt', existing.created_at);
  end if;

  if exists (select 1 from public.platform_restaurant_backups
    where source_restaurant_id = p_restaurant_id and status = 'snapshot_created') then
    raise exception using errcode = '55000',
      message = 'Este restaurante já possui uma cópia em preparação. Retome ou cancele a anterior.';
  end if;

  -- Falha explicitamente se uma futura migration acrescentar dados de
  -- restaurante que esta versão do exportador ainda não conhece.
  select c.relname into unknown_table
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and a.attname = 'restaurant_id' and not a.attisdropped
    and not (c.relname = any(tenant_tables))
  order by c.relname limit 1;
  if unknown_table is not null then
    raise exception using errcode = '55000',
      message = 'Atualize o exportador de backup para incluir a tabela ' || unknown_table || '.';
  end if;

  tables_json := jsonb_build_object('restaurants', jsonb_build_array(to_jsonb(restaurant)));
  foreach table_name in array tenant_tables loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), ''[]''::jsonb) '
      || 'from public.%I t where t.restaurant_id = $1', table_name
    ) into rows_json using p_restaurant_id;
    tables_json := tables_json || jsonb_build_object(table_name, rows_json);
  end loop;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.guest_session_id), '[]'::jsonb)
    into rows_json
  from public.guest_confirmation_codes c
  join public.guest_sessions g on g.id = c.guest_session_id
  where g.restaurant_id = p_restaurant_id;
  tables_json := tables_json || jsonb_build_object('guest_confirmation_codes', rows_json);

  select coalesce(jsonb_agg(to_jsonb(l) order by l.member_id), '[]'::jsonb)
    into rows_json
  from public.staff_confirmation_limits l
  join public.restaurant_members m on m.id = l.member_id
  where m.restaurant_id = p_restaurant_id;
  tables_json := tables_json || jsonb_build_object('staff_confirmation_limits', rows_json);

  -- Storage é apenas inventariado aqui. Os bytes serão copiados pela
  -- próxima etapa, usando a API Storage, nunca INSERT/DELETE em storage.objects.
  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', o.bucket_id, 'path', o.name,
    'metadata', o.metadata, 'createdAt', o.created_at, 'updatedAt', o.updated_at
  ) order by o.bucket_id, o.name), '[]'::jsonb) into objects_json
  from storage.objects o
  where o.bucket_id in ('menu-images', 'menu-videos', 'restaurant-images')
    and split_part(o.name, '/', 1) = p_restaurant_id::text;

  -- Inclui referências locais (/images, /videos), externas e Storage.
  -- Assim, zero arquivos no Storage não é interpretado como zero mídias.
  select coalesce(jsonb_agg(entry order by entry::text), '[]'::jsonb)
    into references_json
  from (
    select jsonb_build_object('kind', 'product_image', 'ownerId', p.id, 'media', i.value) as entry
    from public.menu_products p cross join lateral jsonb_array_elements(p.images) i
    where p.restaurant_id = p_restaurant_id
    union all
    select jsonb_build_object('kind', 'product_video', 'ownerId', p.id, 'media', p.video)
    from public.menu_products p where p.restaurant_id = p_restaurant_id and p.video is not null
    union all
    select jsonb_build_object('kind', 'restaurant_logo', 'ownerId', restaurant.id, 'media', restaurant.logo)
    where restaurant.logo is not null
    union all
    select jsonb_build_object('kind', 'restaurant_cover', 'ownerId', restaurant.id, 'media', restaurant.cover)
    where restaurant.cover is not null
  ) refs;

  insert into public.platform_restaurant_backups (
    id, source_restaurant_id, source_name, source_slug, created_by, created_at,
    snapshot, storage_inventory, media_references
  ) values (
    p_backup_id, restaurant.id, restaurant.name, restaurant.slug, actor_id, backup_time,
    jsonb_build_object(
      'format', 'elozi-restaurant-snapshot', 'version', 1,
      'restaurantId', restaurant.id, 'capturedAt', backup_time, 'tables', tables_json,
      'scope', jsonb_build_object(
        'authUsersIncluded', false,
        'platformConfigurationIncluded', false,
        'globalGuestRateLimitsIncluded', false,
        'mediaBytesIncluded', false,
        'recoveryTarget', 'same-project-existing-auth-users'
      )
    ), objects_json, references_json
  );

  return jsonb_build_object('id', p_backup_id, 'status', 'snapshot_created',
    'restaurantId', restaurant.id, 'createdAt', backup_time,
    'storageObjectCount', jsonb_array_length(objects_json),
    'mediaReferenceCount', jsonb_array_length(references_json));
end;
$$;

create function public.get_platform_backup_snapshot(p_backup_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare result jsonb;
begin
  perform public.require_platform_admin();
  select to_jsonb(b) into result from public.platform_restaurant_backups b where b.id = p_backup_id;
  if result is null then
    raise exception using errcode = '22023', message = 'Cópia não encontrada.';
  end if;
  return result;
end;
$$;

create function public.cancel_platform_backup_snapshot(p_backup_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare source_id uuid;
begin
  perform public.require_platform_admin();
  select source_restaurant_id into source_id
    from public.platform_restaurant_backups where id = p_backup_id;
  if source_id is null then
    raise exception using errcode = '22023', message = 'Cópia não encontrada.';
  end if;
  -- Ordem de bloqueio igual à criação: restaurante, depois registro do backup.
  perform id from public.restaurants where id = source_id for update;
  update public.platform_restaurant_backups
    set status = 'cancelled', cancelled_at = clock_timestamp()
    where id = p_backup_id and status = 'snapshot_created';
end;
$$;

revoke all on function public.create_platform_backup_snapshot(uuid, uuid),
  public.get_platform_backup_snapshot(uuid), public.cancel_platform_backup_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.create_platform_backup_snapshot(uuid, uuid),
  public.get_platform_backup_snapshot(uuid), public.cancel_platform_backup_snapshot(uuid)
  to authenticated;

notify pgrst, 'reload schema';
commit;
