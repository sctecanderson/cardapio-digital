begin;

-- ============================================================================
-- 1. TABELAS DE CURTIDAS E CONTROLE DE FREQUÊNCIA
-- Sem FK para auth.users para permitir portabilidade e recuperação de backups
-- mesmo quando contas anônimas originais tiverem sido purgadas ou em novo ambiente.
-- Validação da sessão de cliente ocorre em tempo de execução via auth.uid() nas RPCs.
-- Integridade multi-tenant reforçada: validação referencial composta garante
-- que product_id pertença estritamente ao restaurant_id da mesma linha.
-- ============================================================================

create table public.product_likes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  product_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint product_likes_product_same_restaurant
    foreign key (product_id, restaurant_id)
    references public.menu_products(id, restaurant_id)
    on delete cascade,
  constraint product_likes_product_user_unique unique (product_id, user_id)
);

create index product_likes_restaurant_product_idx
  on public.product_likes (restaurant_id, product_id);

create index product_likes_user_restaurant_idx
  on public.product_likes (user_id, restaurant_id);

-- Histórico persistente de alterações para throttle (mesmo após exclusão da curtida)
create table public.product_like_events (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  product_id uuid not null,
  user_id uuid not null,
  action text not null check (action in ('like', 'unlike')),
  created_at timestamptz not null default clock_timestamp(),
  constraint product_like_events_product_same_restaurant
    foreign key (product_id, restaurant_id)
    references public.menu_products(id, restaurant_id)
    on delete cascade
);

create index product_like_events_throttle_idx
  on public.product_like_events (user_id, product_id, created_at desc);

create index product_like_events_user_rate_idx
  on public.product_like_events (user_id, restaurant_id, created_at desc);

-- RLS e Revogação Estrita de Acesso Direto às Tabelas
alter table public.product_likes enable row level security;
alter table public.product_like_events enable row level security;

revoke all on public.product_likes from public, anon, authenticated;
revoke all on public.product_like_events from public, anon, authenticated;
grant select on public.product_likes to service_role;
grant select on public.product_like_events to service_role;

-- ============================================================================
-- 2. CONTADOR MATERIALIZADO E PROTEÇÃO INVIOLÁVEL DE likes_count
-- Sem variáveis GUC (current_setting), sem pg_trigger_depth() e sem DDL
-- de DISABLE TRIGGER em funções de reconciliação.
-- A guarda verifica a identidade matemática: likes_count DEVE ser igual ao
-- total real de linhas em public.product_likes para aquele produto.
-- Nenhuma escrita arbitrária é aceita; atualizações legítimas após insert/delete
-- ou reconciliação passam naturalmente por satisfazerem a verdade contábil.
-- ============================================================================

alter table public.menu_products
  add column if not exists likes_count integer not null default 0;

alter table public.menu_products
  drop constraint if exists menu_products_likes_count_non_negative,
  add constraint menu_products_likes_count_non_negative
    check (likes_count >= 0);

create or replace function public.guard_menu_product_likes_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actual_likes integer;
begin
  if new.likes_count is distinct from old.likes_count then
    select count(*)::integer into actual_likes
    from public.product_likes
    where product_id = new.id;

    if new.likes_count is distinct from coalesce(actual_likes, 0) then
      raise exception using errcode = '42501',
        message = 'A contagem de curtidas é gerenciada automaticamente pelo sistema e deve corresponder exatamente às curtidas registradas.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_menu_product_likes_count() from public, anon, authenticated;

drop trigger if exists menu_products_guard_likes_count on public.menu_products;
create trigger menu_products_guard_likes_count
  before update of likes_count on public.menu_products
  for each row execute function public.guard_menu_product_likes_count();

-- Preserva o controle de concorrência otimista (revision) do catálogo administrativo:
-- Atualizações que alteram exclusivamente likes_count não incrementam revision,
-- evitando falso conflito 40001 caso um administrador esteja editando o produto simultaneamente.
-- Qualquer alteração em campos administrativos (isolada ou combinada com likes_count) incrementa revision.
create or replace function public.bump_catalog_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_schema = 'public' and tg_table_name = 'menu_products' then
    if new.likes_count is distinct from old.likes_count
       and (to_jsonb(new) - 'likes_count') is not distinct from (to_jsonb(old) - 'likes_count') then
      return new;
    end if;
  end if;

  new.revision := old.revision + 1;
  return new;
end;
$$;

revoke all on function public.bump_catalog_revision() from public, anon, authenticated;

-- Trigger de sincronização estrita disparado exclusivamente por product_likes
create or replace function public.sync_product_likes_count()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Serializa atualizações no produto para garantir visibilidade MVCC em guard_menu_product_likes_count
    perform id from public.menu_products where id = new.product_id for no key update;

    update public.menu_products
    set likes_count = (
      select count(*)::integer from public.product_likes where product_id = new.product_id
    )
    where id = new.product_id;
    return new;
  elsif tg_op = 'DELETE' then
    perform id from public.menu_products where id = old.product_id for no key update;

    update public.menu_products
    set likes_count = (
      select count(*)::integer from public.product_likes where product_id = old.product_id
    )
    where id = old.product_id;
    return old;
  end if;
  return null;
end;
$$;

revoke all on function public.sync_product_likes_count() from public, anon, authenticated;

drop trigger if exists product_likes_counter_sync on public.product_likes;
create trigger product_likes_counter_sync
  after insert or delete on public.product_likes
  for each row execute function public.sync_product_likes_count();

-- ============================================================================
-- 3. FUNÇÃO DE RECONCILIAÇÃO DETERMINÍSTICA DE CONTADORES (SEM DDL)
-- ============================================================================

create or replace function public.reconcile_restaurant_likes_count(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_restaurant_id is null then
    raise exception using errcode = '22023', message = 'Informe o restaurante.';
  end if;

  -- Serializa todos os produtos do restaurante em ordem determinística de ID antes da reconciliação
  perform id
  from public.menu_products
  where restaurant_id = p_restaurant_id
  order by id
  for no key update;

  update public.menu_products p
  set likes_count = coalesce((
    select count(*)::integer
    from public.product_likes l
    where l.product_id = p.id
  ), 0)
  where p.restaurant_id = p_restaurant_id
    and p.likes_count is distinct from coalesce((
      select count(*)::integer
      from public.product_likes l
      where l.product_id = p.id
    ), 0);
end;
$$;

revoke all on function public.reconcile_restaurant_likes_count(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_restaurant_likes_count(uuid) to service_role;

-- ============================================================================
-- 4. RPCS PARA CLIENTES (TOGGLE COM SERIALIZAÇÃO TRIPLA E GET_MY_LIKES)
-- ============================================================================

create or replace function public.toggle_product_like(
  p_restaurant_slug text,
  p_product_id uuid,
  p_liked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_product public.menu_products%rowtype;
  current_liked boolean;
  recent_events_count integer;
  updated_likes_count integer;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    raise exception using errcode = '42501',
      message = 'Esta operação exige uma sessão de cliente.';
  end if;

  if p_restaurant_slug is null or p_product_id is null or p_liked is null then
    raise exception using errcode = '22023',
      message = 'Informe o restaurante, o produto e a ação de curtida.';
  end if;

  -- 1. Validar restaurante ativo e não arquivado
  select r.id into target_restaurant_id
  from public.restaurants r
  where r.slug = p_restaurant_slug
    and r.active = true
    and r.archived_at is null;

  if target_restaurant_id is null then
    raise exception using errcode = '22023',
      message = 'Restaurante indisponível.';
  end if;

  -- 2. Validar produto pertencente ao restaurante e disponível (leitura rápida sem lock antes da idempotência)
  select * into target_product
  from public.menu_products
  where id = p_product_id
    and restaurant_id = target_restaurant_id;

  if target_product.id is null then
    raise exception using errcode = '22023',
      message = 'Produto não encontrado.';
  end if;

  if not target_product.available then
    raise exception using errcode = '22023',
      message = 'Este produto está temporariamente indisponível para interações.';
  end if;

  -- 3. Lock A: Serializa por par (usuário, produto) para operações específicas no item
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat(current_user_id::text, p_product_id::text), 0)
  );

  -- 4. Verificar estado atual persistido
  select exists (
    select 1
    from public.product_likes
    where product_id = p_product_id
      and user_id = current_user_id
  ) into current_liked;

  -- 5. IDEMPOTÊNCIA: Se o estado já corresponde ao solicitado, retorna sem erro e sem aplicar throttle
  if current_liked = p_liked then
    select likes_count into updated_likes_count
    from public.menu_products
    where id = p_product_id;

    return jsonb_build_object(
      'liked', current_liked,
      'likesCount', coalesce(updated_likes_count, 0)
    );
  end if;

  -- 6. Lock B: Serializa por (usuário, restaurante) para garantir atomicidade no rate limit global
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(concat(current_user_id::text, target_restaurant_id::text), 1)
  );

  -- 7. THROTTLE: Se houver mudança efetiva, verificar se houve alteração nos últimos 2 segundos
  if exists (
    select 1
    from public.product_like_events
    where user_id = current_user_id
      and product_id = p_product_id
      and created_at >= clock_timestamp() - interval '2 seconds'
  ) then
    raise exception using errcode = '55000',
      message = 'Aguarde um momento antes de alterar sua curtida novamente.';
  end if;

  -- 8. RATE LIMITING: Máximo de 15 alterações por minuto por usuário no restaurante
  select count(*) into recent_events_count
  from public.product_like_events
  where user_id = current_user_id
    and restaurant_id = target_restaurant_id
    and created_at >= clock_timestamp() - interval '1 minute';

  if recent_events_count >= 15 then
    raise exception using errcode = '55000',
      message = 'Muitas interações recentes. Aguarde um minuto para continuar.';
  end if;

  -- 9. Lock C (Por Produto em menu_products ANTES de modificar product_likes):
  -- Serializa escritas concorrentes de múltiplos usuários distintos no mesmo produto,
  -- impede deadlocks de upgrade de lock (FK FOR KEY SHARE -> UPDATE) e garante que
  -- sync_product_likes_count e guard_menu_product_likes_count enxerguem o mesmo snapshot MVCC.
  select * into target_product
  from public.menu_products
  where id = p_product_id
    and restaurant_id = target_restaurant_id
  for no key update;

  if target_product.id is null or not target_product.available then
    raise exception using errcode = '22023',
      message = 'Este produto está temporariamente indisponível para interações.';
  end if;

  -- 10. Executar mutação e registrar evento persistente
  if p_liked then
    insert into public.product_likes (restaurant_id, product_id, user_id)
    values (target_restaurant_id, p_product_id, current_user_id)
    on conflict (product_id, user_id) do nothing;

    insert into public.product_like_events (restaurant_id, product_id, user_id, action)
    values (target_restaurant_id, p_product_id, current_user_id, 'like');
  else
    delete from public.product_likes
    where product_id = p_product_id
      and user_id = current_user_id;

    insert into public.product_like_events (restaurant_id, product_id, user_id, action)
    values (target_restaurant_id, p_product_id, current_user_id, 'unlike');
  end if;

  -- 11. Obter contador atualizado
  select likes_count into updated_likes_count
  from public.menu_products
  where id = p_product_id;

  return jsonb_build_object(
    'liked', p_liked,
    'likesCount', coalesce(updated_likes_count, 0)
  );
end;
$$;

revoke all on function public.toggle_product_like(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.toggle_product_like(text, uuid, boolean) to authenticated;

-- Consulta dos próprios produtos curtidos pelo cliente chamador
create or replace function public.get_my_product_likes(p_restaurant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
begin
  current_user_id := auth.uid();
  if current_user_id is null then
    return '[]'::jsonb;
  end if;

  if p_restaurant_slug is null then
    return '[]'::jsonb;
  end if;

  select id into target_restaurant_id
  from public.restaurants
  where slug = p_restaurant_slug
    and active = true
    and archived_at is null;

  if target_restaurant_id is null then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(l.product_id order by l.created_at)
    from public.product_likes l
    where l.restaurant_id = target_restaurant_id
      and l.user_id = current_user_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_my_product_likes(text) from public, anon, authenticated;
grant execute on function public.get_my_product_likes(text) to anon, authenticated;

-- ============================================================================
-- 5. ATUALIZAÇÃO DO CATÁLOGO PÚBLICO (INCLUIR likesCount)
-- ============================================================================

create or replace function public.get_public_menu(p_restaurant_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
select jsonb_build_object(
  'restaurantId', restaurant.id,
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', category.id, 'restaurantId', category.restaurant_id,
      'name', category.name, 'slug', category.slug, 'sortOrder', category.sort_order
    ) order by category.sort_order, category.id)
    from public.menu_categories as category
    where category.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', product.id, 'restaurantId', product.restaurant_id,
      'categoryId', product.category_id, 'slug', product.slug,
      'name', product.name, 'shortDescription', product.short_description,
      'description', product.description, 'priceInCents', product.price_in_cents,
      'available', product.available, 'featured', product.featured,
      'sortOrder', product.sort_order, 'images', product.images,
      'coverImageId', product.cover_image_id, 'video', product.video,
      'dietaryInformation', product.dietary_information,
      'likesCount', coalesce(product.likes_count, 0)
    ) order by product.sort_order, product.id)
    from public.menu_products as product
    join public.menu_categories as category
      on category.id = product.category_id and category.restaurant_id = product.restaurant_id
    where product.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb)
)
from public.restaurants as restaurant
where restaurant.slug = p_restaurant_slug and restaurant.active;
$$;

revoke all on function public.get_public_menu(text) from public, anon, authenticated;
grant execute on function public.get_public_menu(text) to anon, authenticated;

-- ============================================================================
-- 6. CICLO DE VIDA: VERSIONAMENTO EXPLÍCITO DE BACKUP SNAPSHOTS (v1 e v2)
-- Snapshots anteriores ao Bloco 6 permanecem version = 1.
-- Novos snapshots gerados a partir do Bloco 6 possuem format_version = 2 e version = 2.
-- ============================================================================

alter table public.platform_restaurant_backups
  drop constraint if exists platform_restaurant_backups_format_version_check;

alter table public.platform_restaurant_backups
  alter column format_version set default 2,
  add constraint platform_restaurant_backups_format_version_check
    check (format_version in (1, 2));

create or replace function public.create_platform_backup_snapshot(
  p_restaurant_id uuid,
  p_backup_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
    'restaurant_status_events', 'restaurant_archive_events',
    'product_likes', 'product_like_events'
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
    id, source_restaurant_id, source_name, source_slug, format_version,
    created_by, created_at, snapshot, storage_inventory, media_references
  ) values (
    p_backup_id, restaurant.id, restaurant.name, restaurant.slug, 2,
    actor_id, backup_time,
    jsonb_build_object(
      'format', 'elozi-restaurant-snapshot', 'version', 2,
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

revoke all on function public.create_platform_backup_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_platform_backup_snapshot(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- 7. CICLO DE VIDA: RECUPERAÇÃO COM VERSIONAMENTO EXPLÍCITO (v1 vs v2)
-- Version 1 (legado, Blocos 1-5):
--   - Deve possuir as 17 tabelas originais.
--   - Não pode possuir product_likes nem product_like_events.
--   - Nenhum item em menu_products pode possuir likes_count; é adicionado likes_count = 0.
-- Version 2 (atual, Bloco 6+):
--   - Deve possuir todas as 19 tabelas obrigatoriamente.
--   - Todos os produtos devem possuir likes_count.
-- ============================================================================

create or replace function public.stage_platform_backup_recovery(p_backup_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.platform_restaurant_backups%rowtype;
  names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events'
  ];
  v1_names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events'
  ];
  name text; columns_sql text; columns_json jsonb; rows_json jsonb;
  canonical jsonb; expected jsonb; unknown_name text; row_count bigint; total bigint := 0;
  fk record; target text; conditions text; nonnull text; has_invalid boolean;
  root public.restaurants%rowtype;
  snap_version text;
begin
  select * into b from public.platform_restaurant_backups where id = p_backup_id;
  if not found or b.status <> 'ready' then
    raise exception using errcode='55000', message='Selecione um backup concluído.';
  end if;

  snap_version := b.snapshot->>'version';

  if b.snapshot->>'format' <> 'elozi-restaurant-snapshot'
    or snap_version not in ('1', '2')
    or b.format_version::text <> snap_version
    or b.snapshot->>'restaurantId' <> b.source_restaurant_id::text then
    raise exception using errcode='22023', message='Formato ou versão do snapshot inválido.';
  end if;

  -- Validação estrita das tabelas permitidas e obrigatórias segundo a versão explícita
  if snap_version = '1' then
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(v1_names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot v1: %', unknown_name;
    end if;

    foreach name in array v1_names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  else
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot: %', unknown_name;
    end if;

    foreach name in array names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  end if;

  -- Confirma se não há novas tabelas do sistema com restaurant_id não mapeadas
  select c.relname into unknown_name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attname='restaurant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind in ('r','p') and not (c.relname=any(names)) limit 1;
  if unknown_name is not null then
    raise exception 'Atualize a recuperação para a tabela: %', unknown_name;
  end if;

  foreach name in array names loop
    if snap_version = '1' and name in ('product_likes', 'product_like_events') then
      rows_json := '[]'::jsonb;
    else
      rows_json := b.snapshot->'tables'->name;
    end if;

    if rows_json is null or jsonb_typeof(rows_json) <> 'array' then
      raise exception 'Tabela ausente ou inválida no snapshot: %', name;
    end if;

    -- Em snapshot v1 (legado), nenhum produto possui likes_count originalmente.
    -- Verificamos que nenhuma linha em v1 já tenha likes_count (evita hibridismo adulterado)
    -- e injetamos explicitamente likes_count: 0 em todas as linhas de menu_products.
    if snap_version = '1' and name = 'menu_products' then
      if exists (
        select 1 from jsonb_array_elements(rows_json) as item
        where jsonb_typeof(item) = 'object' and (item ? 'likes_count')
      ) then
        raise exception 'Colunas incompatíveis em menu_products para snapshot v1.';
      end if;

      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object' then item || jsonb_build_object('likes_count', 0)
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    end if;

    select string_agg(quote_ident(a.attname),',' order by a.attnum),
      jsonb_agg(a.attname order by a.attname)
      into columns_sql, columns_json
      from pg_catalog.pg_attribute a
      where a.attrelid=('public.'||name)::regclass and a.attnum>0 and not a.attisdropped
        and a.attgenerated='' and a.attidentity='';

    select jsonb_agg(a.attname order by a.attname) into columns_json
      from pg_catalog.pg_attribute a
      where a.attrelid=('public.'||name)::regclass and a.attnum>0 and not a.attisdropped;

    if exists(select 1 from jsonb_array_elements(rows_json) r
      where jsonb_typeof(r)<>'object' or
        (select jsonb_agg(k order by k) from jsonb_object_keys(r) k) is distinct from columns_json) then
      raise exception 'Colunas incompatíveis em %. Não é permitido omitir dados silenciosamente.', name;
    end if;

    execute format('drop table if exists pg_temp.%I', 'elozi_restore_'||name);
    execute format('create temporary table %I (like public.%I including all) on commit drop',
      'elozi_restore_'||name, name);
    execute format('insert into pg_temp.%I (%s) select %s from jsonb_populate_recordset(null::public.%I,$1)',
      'elozi_restore_'||name,columns_sql,columns_sql,name) using rows_json;
    get diagnostics row_count = row_count;
    total := total + row_count;

    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb) from pg_temp.%I r',
      'elozi_restore_'||name) into canonical;
    select coalesce(jsonb_agg(r order by r::text),'[]'::jsonb) into expected from jsonb_array_elements(rows_json) r;
    if canonical is distinct from expected then
      raise exception 'Dados ou valores gerados incompatíveis em %.', name;
    end if;

    if name='restaurants' then
      if row_count<>1 then raise exception 'O snapshot deve conter um único restaurante.'; end if;
    elsif name not in ('guest_confirmation_codes','staff_confirmation_limits') then
      execute format('select exists(select 1 from pg_temp.%I where restaurant_id <> $1)',
        'elozi_restore_'||name) into has_invalid using b.source_restaurant_id;
      if has_invalid then raise exception 'Dados de outro restaurante em %.',name; end if;
    end if;
  end loop;

  -- Validar em staging que likes_count de cada produto corresponde exatamente aos likes do snapshot
  if exists (
    select 1
    from pg_temp.elozi_restore_menu_products p
    where p.likes_count is distinct from coalesce((
      select count(*)::integer
      from pg_temp.elozi_restore_product_likes l
      where l.product_id = p.id
    ), 0)
  ) then
    raise exception 'Contagem de curtidas inconsistente com os registros de product_likes no snapshot.';
  end if;

  select * into root from pg_temp.elozi_restore_restaurants;
  if root.id<>b.source_restaurant_id or root.active or root.archived_at is null then
    raise exception 'O restaurante recuperado precisa permanecer arquivado e inativo.';
  end if;

  for fk in
    select c.*, sc.relname as source_name, tc.relname as target_name, tn.nspname as target_schema
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class sc on sc.oid=c.conrelid
    join pg_catalog.pg_namespace sn on sn.oid=sc.relnamespace
    join pg_catalog.pg_class tc on tc.oid=c.confrelid
    join pg_catalog.pg_namespace tn on tn.oid=tc.relnamespace
    where c.contype='f' and sn.nspname='public' and sc.relname=any(names)
  loop
    if fk.confmatchtype<>'s' then raise exception 'Tipo de relacionamento não suportado: %',fk.conname; end if;
    if fk.target_schema='public' and fk.target_name=any(names) then
      target:=format('pg_temp.%I','elozi_restore_'||fk.target_name);
    elsif fk.target_schema='auth' and fk.target_name='users' then
      target:='auth.users';
    else raise exception 'Relacionamento não suportado: %',fk.conname;
    end if;
    select string_agg(format('s.%I=t.%I',sa.attname,ta.attname),' and ' order by x.ord),
      string_agg(format('s.%I is not null',sa.attname),' and ' order by x.ord)
      into conditions,nonnull
      from unnest(fk.conkey,fk.confkey) with ordinality x(skey,tkey,ord)
      join pg_catalog.pg_attribute sa on sa.attrelid=fk.conrelid and sa.attnum=x.skey
      join pg_catalog.pg_attribute ta on ta.attrelid=fk.confrelid and ta.attnum=x.tkey;
    execute format('select exists(select 1 from pg_temp.%I s where %s and not exists(select 1 from %s t where %s))',
      'elozi_restore_'||fk.source_name,nonnull,target,conditions) into has_invalid;
    if has_invalid then
      raise exception 'Relacionamento ausente em %. Confira as contas do Auth e a integridade do backup.',fk.conname;
    end if;
  end loop;

  return jsonb_build_object('backupId',b.id,'restaurantId',root.id,'name',root.name,'slug',root.slug,
    'tableCount', case when snap_version = '1' then cardinality(v1_names) else cardinality(names) end,
    'rowCount',total,
    'sourceExists',exists(select 1 from public.restaurants where id=root.id),
    'slugConflict',exists(select 1 from public.restaurants where slug=root.slug and id<>root.id));
end;
$$;

revoke all on function public.stage_platform_backup_recovery(uuid) from public,anon,authenticated;

create or replace function public.complete_platform_backup_recovery(p_backup_id uuid,p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  validation jsonb; name text; columns_sql text;
  names constant text[]:=array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events'
  ];
  rid uuid; trigger_table text; trigger_name text;
begin
  perform user_id from public.platform_admins where user_id=p_actor_id and active for share;
  if not found then raise exception using errcode='42501',message='Acesso exclusivo da administração da Elozi.'; end if;
  select source_restaurant_id into rid from public.platform_restaurant_backups where id=p_backup_id and status='ready' for share;
  if rid is null then raise exception 'Backup concluído não encontrado.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
  if exists(select 1 from public.platform_backup_recoveries where backup_id=p_backup_id)
    and exists(select 1 from public.restaurants where id=rid) then
    return jsonb_build_object('restaurantId',rid,'alreadyRecovered',true);
  end if;
  validation:=public.stage_platform_backup_recovery(p_backup_id);
  if (validation->>'sourceExists')::boolean or (validation->>'slugConflict')::boolean then
    raise exception using errcode='55000',message='O restaurante ou seu endereço ainda existe. A recuperação não substitui dados.';
  end if;

  lock table public.table_tabs,public.table_tab_guests,public.table_tab_items,public.product_likes,public.menu_products in access exclusive mode;
  for trigger_table,trigger_name in values
    ('table_tabs','table_tabs_validate_write'),
    ('table_tab_guests','table_tab_guests_validate_write'),
    ('table_tab_items','table_tab_items_validate_write'),
    ('product_likes','product_likes_counter_sync')
  loop
    if not exists(select 1 from pg_catalog.pg_trigger where tgrelid=('public.'||trigger_table)::regclass
      and tgname=trigger_name and tgenabled='O') then
      raise exception 'Confira a configuração do trigger % antes da recuperação.',trigger_name;
    end if;
    execute format('alter table public.%I disable trigger %I',trigger_table,trigger_name);
  end loop;

  foreach name in array names loop
    select string_agg(quote_ident(a.attname),',' order by a.attnum) into columns_sql
      from pg_catalog.pg_attribute a where a.attrelid=('public.'||name)::regclass
        and a.attnum>0 and not a.attisdropped and a.attgenerated='' and a.attidentity='';
    execute format('insert into public.%I (%s) select %s from pg_temp.%I',
      name,columns_sql,columns_sql,'elozi_restore_'||name);
  end loop;

  alter table public.table_tabs enable trigger table_tabs_validate_write;
  alter table public.table_tab_guests enable trigger table_tab_guests_validate_write;
  alter table public.table_tab_items enable trigger table_tab_items_validate_write;
  alter table public.product_likes enable trigger product_likes_counter_sync;

  -- Reconciliação dos contadores de likes pós-recuperação (sem DDL de trigger)
  perform public.reconcile_restaurant_likes_count(rid);

  insert into public.platform_backup_recoveries(backup_id,source_restaurant_id,recovered_by)
    values(p_backup_id,rid,p_actor_id)
    on conflict(backup_id) do update set recovered_at=now(),recovered_by=excluded.recovered_by;
  return validation || jsonb_build_object('recovered',true,'archived',true);
end;
$$;

revoke all on function public.complete_platform_backup_recovery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.complete_platform_backup_recovery(uuid,uuid) to service_role;

-- ============================================================================
-- 8. CICLO DE VIDA: EXCLUSÃO DEFINITIVA E VERIFICAÇÃO DE BACKUP (v1 e v2)
-- ============================================================================

drop trigger if exists guard_platform_deletion on public.product_likes;
create trigger guard_platform_deletion
  before insert or update or delete on public.product_likes
  for each row execute function public.guard_platform_restaurant_deletion();

drop trigger if exists guard_platform_deletion on public.product_like_events;
create trigger guard_platform_deletion
  before insert or update or delete on public.product_like_events
  for each row execute function public.guard_platform_restaurant_deletion();

create or replace function public.check_platform_deletion_backup(p_restaurant_id uuid,p_backup_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  b public.platform_restaurant_backups%rowtype;
  r public.restaurants%rowtype;
  name text; live_rows jsonb; expected jsonb; inventory jsonb;
begin
  select * into r from public.restaurants where id=p_restaurant_id;
  if not found or r.active or r.archived_at is null then
    raise exception using errcode='55000',message='Arquive o restaurante antes de excluir definitivamente.';
  end if;
  select * into b from public.platform_restaurant_backups where id=p_backup_id;
  if not found or b.source_restaurant_id<>p_restaurant_id or b.status<>'ready' then
    raise exception using errcode='22023',message='Escolha um backup concluído deste restaurante.';
  end if;
  if exists(select 1 from public.platform_restaurant_backups where source_restaurant_id=p_restaurant_id and status='snapshot_created') then
    raise exception using errcode='55000',message='Conclua ou cancele o backup em preparação antes da exclusão.';
  end if;
  -- Reutiliza a validação de formato, tabelas novas, CHECKs, FKs e Auth.
  perform public.stage_platform_backup_recovery(p_backup_id);

  -- Se o backup for v1 (anterior ao Bloco 6), só pode autorizar exclusão se não houver curtidas/eventos criados após o backup
  if b.format_version = 1 then
    if exists(select 1 from public.product_likes where restaurant_id=p_restaurant_id)
      or exists(select 1 from public.product_like_events where restaurant_id=p_restaurant_id) then
      raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
    end if;
  end if;

  for name in select jsonb_object_keys(b.snapshot->'tables') loop
    if name='restaurants' then
      live_rows:=jsonb_build_array(to_jsonb(r));
    elsif name='guest_confirmation_codes' then
      select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text),'[]'::jsonb) into live_rows
        from public.guest_confirmation_codes c join public.guest_sessions g on g.id=c.guest_session_id
        where g.restaurant_id=p_restaurant_id;
    elsif name='staff_confirmation_limits' then
      select coalesce(jsonb_agg(to_jsonb(c) order by to_jsonb(c)::text),'[]'::jsonb) into live_rows
        from public.staff_confirmation_limits c join public.restaurant_members m on m.id=c.member_id
        where m.restaurant_id=p_restaurant_id;
    elsif name='menu_products' and b.format_version = 1 then
      -- Em backups v1, os produtos não possuíam a chave likes_count no JSON,
      -- mas somente se likes_count atual for 0 é que os dados permanecem inalterados.
      if exists(select 1 from public.menu_products where restaurant_id=p_restaurant_id and likes_count <> 0) then
        raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
      end if;
      select coalesce(jsonb_agg((to_jsonb(t) - 'likes_count') order by (to_jsonb(t) - 'likes_count')::text),'[]'::jsonb)
        into live_rows from public.menu_products t where restaurant_id=p_restaurant_id;
    else
      execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from public.%I t where restaurant_id=$1',name)
        into live_rows using p_restaurant_id;
    end if;
    select coalesce(jsonb_agg(v order by v::text),'[]'::jsonb) into expected
      from jsonb_array_elements(b.snapshot->'tables'->name) v;
    if live_rows is distinct from expected then
      raise exception using errcode='55000',message='Os dados mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('bucket',o.bucket_id,'path',o.name,
    'metadata',o.metadata,'createdAt',o.created_at,'updatedAt',o.updated_at) order by o.bucket_id,o.name),'[]'::jsonb)
    into inventory from storage.objects o
    where o.bucket_id in ('menu-images','menu-videos','restaurant-images') and split_part(o.name,'/',1)=p_restaurant_id::text;
  if inventory is distinct from b.storage_inventory then
    raise exception using errcode='55000',message='As mídias mudaram depois deste backup. Gere e baixe uma nova cópia antes de excluir.';
  end if;
end;
$$;

revoke all on function public.check_platform_deletion_backup(uuid,uuid) from public,anon,authenticated;

create or replace function public.delete_platform_restaurant_data(p_deletion_id uuid,p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare j public.platform_restaurant_deletions%rowtype; rid uuid; name text;
begin
  perform user_id from public.platform_admins where user_id=p_actor_id and active for share;
  if not found then raise exception using errcode='42501',message='Acesso exclusivo da administração da Elozi.'; end if;
  select source_restaurant_id into rid from public.platform_restaurant_deletions where id=p_deletion_id;
  if rid is null then raise exception 'Exclusão não encontrada.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(rid::text,0));
  perform id from public.restaurants where id=rid for update;
  select * into j from public.platform_restaurant_deletions where id=p_deletion_id for update;
  if j.status in ('media_cleanup','completed') then return; end if;
  if j.status<>'pending' then raise exception 'Exclusão cancelada ou indisponível.'; end if;
  if exists(
    select 1 from (select 'snapshot' as key union all select 'manifest' union all
      select id::text from public.platform_backup_files where backup_id=j.backup_id) expected
    where not exists(select 1 from public.platform_deletion_checks c where c.deletion_id=j.id
      and c.file_key=expected.key and c.verified_at>=now()-interval '15 minutes')
  ) then raise exception 'Confira novamente todos os arquivos do backup antes de excluir.'; end if;
  perform public.check_platform_deletion_backup(rid,j.backup_id);
  update public.platform_restaurant_deletions set status='deleting_data' where id=j.id;

  -- Ordem explícita de dependências. Sem CASCADE e sem excluir auth.users.
  delete from public.guest_confirmation_codes c using public.guest_sessions g where c.guest_session_id=g.id and g.restaurant_id=rid;
  delete from public.staff_confirmation_limits c using public.restaurant_members m where c.member_id=m.id and m.restaurant_id=rid;

  -- Desabilita temporariamente o trigger de contagem durante a limpeza de dados da exclusão
  alter table public.product_likes disable trigger product_likes_counter_sync;
  delete from public.product_like_events where restaurant_id=rid;
  delete from public.product_likes where restaurant_id=rid;
  alter table public.product_likes enable trigger product_likes_counter_sync;

  foreach name in array array['service_request_guests','service_requests','table_tab_items','table_tab_guests','table_tabs',
    'guest_sessions','table_visits','menu_products','menu_categories','menu_media_cleanup','restaurant_status_events',
    'restaurant_archive_events','restaurant_members','restaurant_tables'] loop
    execute format('delete from public.%I where restaurant_id=$1',name) using rid;
  end loop;
  delete from public.restaurants where id=rid;
  update public.platform_restaurant_deletions set status='media_cleanup',data_deleted_at=now() where id=j.id;
end;
$$;

revoke all on function public.delete_platform_restaurant_data(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_platform_restaurant_data(uuid,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
