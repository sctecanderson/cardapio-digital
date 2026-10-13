begin;

-- ============================================================================
-- 1. EXTENSÃO DA TABELA public.menu_products: TEMPO ESTIMADO DE PREPARO
-- prep_time_min_minutes e prep_time_max_minutes são opcionais.
-- Se preenchidos, devem ser inteiros estritamente positivos (1 a 1440 min)
-- e min deve ser menor ou igual a max.
-- ============================================================================
alter table public.menu_products
  add column if not exists prep_time_min_minutes integer,
  add column if not exists prep_time_max_minutes integer;

alter table public.menu_products
  drop constraint if exists menu_products_prep_time_check,
  add constraint menu_products_prep_time_check
    check (
      (prep_time_min_minutes is null and prep_time_max_minutes is null)
      or (
        prep_time_min_minutes is not null
        and prep_time_max_minutes is not null
        and prep_time_min_minutes between 1 and 1440
        and prep_time_max_minutes between 1 and 1440
        and prep_time_min_minutes <= prep_time_max_minutes
      )
    );

-- ============================================================================
-- 2. EXTENSÃO DA TABELA public.restaurants: LINK OFICIAL DE AVALIAÇÃO NO GOOGLE
-- google_review_url é opcional.
-- Se preenchido, aceita estritamente links oficiais e conhecidos de avaliação do Google:
-- https://g.page/r/.../review, https://maps.app.goo.gl/..., https://search.google.com/local/writereview?...
-- ou domínios oficiais google.com / google.com.br / goo.gl com caminho válido.
-- ============================================================================
alter table public.restaurants
  add column if not exists google_review_url text;

alter table public.restaurants
  drop constraint if exists restaurants_google_review_url_check,
  add constraint restaurants_google_review_url_check
    check (
      google_review_url is null
      or (
        char_length(btrim(google_review_url)) between 10 and 500
        and google_review_url = btrim(google_review_url)
        and google_review_url ~* '^https://([a-z0-9-]+\.)*(google\.(com|com\.br)|g\.page|goo\.gl)/'
      )
    );

-- ============================================================================
-- 3. ATUALIZAÇÃO DA RPC public.save_menu_product
-- Salva e atualiza prep_time_min_minutes e prep_time_max_minutes com validações.
-- ============================================================================
create or replace function public.save_menu_product(
  p_slug text,
  p_id uuid,
  p_revision integer,
  p_values jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.menu_products%rowtype;
  v public.menu_products%rowtype;
  v_prep_min integer;
  v_prep_max integer;
begin
  rid := public.require_catalog_admin(p_slug);
  select * into v from jsonb_populate_record(null::public.menu_products, p_values);

  if p_id is null or p_revision is null or p_revision < 0 or v.name is null
    or char_length(btrim(v.name)) not between 1 and 120 or v.slug is null
    or char_length(v.slug) > 120 or v.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or v.short_description is null or char_length(v.short_description) > 240
    or v.description is null or char_length(v.description) > 5000
    or char_length(coalesce(v.dietary_information, '')) > 1000
    or v.price_in_cents is null or v.price_in_cents not between 0 and 99999999
    or v.sort_order is null or v.sort_order not between 0 and 9999
    or v.available is null or v.featured is null then
    raise exception using errcode = '22023', message = 'Confira os campos do produto, o preço e a ordem.';
  end if;

  -- Processamento seguro do tempo de preparo
  if (p_values ? 'prep_time_min_minutes') or (p_values ? 'prep_time_max_minutes') then
    v_prep_min := case
      when p_values->>'prep_time_min_minutes' is null or btrim(p_values->>'prep_time_min_minutes') = '' then null
      else (p_values->>'prep_time_min_minutes')::integer
    end;
    v_prep_max := case
      when p_values->>'prep_time_max_minutes' is null or btrim(p_values->>'prep_time_max_minutes') = '' then null
      else (p_values->>'prep_time_max_minutes')::integer
    end;

    if (v_prep_min is null and v_prep_max is not null) or (v_prep_min is not null and v_prep_max is null) then
      raise exception using errcode = '22023', message = 'Informe o tempo de preparo mínimo e máximo ou deixe ambos em branco.';
    end if;

    if v_prep_min is not null then
      if v_prep_min < 1 or v_prep_max < 1 or v_prep_min > 1440 or v_prep_max > 1440 then
        raise exception using errcode = '22023', message = 'O tempo de preparo deve estar entre 1 e 1440 minutos.';
      end if;
      if v_prep_min > v_prep_max then
        raise exception using errcode = '22023', message = 'O tempo mínimo de preparo não pode ser maior que o tempo máximo.';
      end if;
    end if;
  else
    v_prep_min := null;
    v_prep_max := null;
  end if;

  perform id from public.menu_categories where id = v.category_id and restaurant_id = rid for share;
  if not found then
    raise exception using errcode = '22023', message = 'Selecione uma categoria deste restaurante.';
  end if;

  select * into old_row from public.menu_products where id = p_id for update;
  if found then
    if old_row.restaurant_id <> rid then
      raise exception using errcode = '42501', message = 'Produto de outro restaurante.';
    end if;
    if old_row.revision <> p_revision then
      raise exception using errcode = '40001', message = 'Este produto foi alterado. Atualize a lista e abra a edição novamente.';
    end if;

    update public.menu_products set
      category_id = v.category_id,
      name = btrim(v.name),
      short_description = btrim(v.short_description),
      description = btrim(v.description),
      price_in_cents = v.price_in_cents,
      available = v.available,
      featured = v.featured,
      sort_order = v.sort_order,
      dietary_information = nullif(btrim(v.dietary_information), ''),
      prep_time_min_minutes = v_prep_min,
      prep_time_max_minutes = v_prep_max,
      revision = revision + 1
    where id = p_id;
  else
    if p_revision <> 0 then
      raise exception using errcode = '22023', message = 'Produto não encontrado. Atualize a lista.';
    end if;

    insert into public.menu_products (
      id, restaurant_id, category_id, catalog_key, slug, name,
      short_description, description, price_in_cents, available, featured,
      sort_order, dietary_information, prep_time_min_minutes, prep_time_max_minutes
    ) values (
      p_id, rid, v.category_id, p_id::text, v.slug, btrim(v.name),
      btrim(v.short_description), btrim(v.description), v.price_in_cents, v.available, v.featured,
      v.sort_order, nullif(btrim(v.dietary_information), ''), v_prep_min, v_prep_max
    );
  end if;

  return p_id;
end;
$$;

revoke all on function public.save_menu_product(text, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_menu_product(text, uuid, integer, jsonb) to authenticated;

-- ============================================================================
-- 4. ATUALIZAÇÃO DA RPC public.get_public_menu
-- Expõe prepTimeMinMinutes e prepTimeMaxMinutes para clientes e equipe.
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
      'prepTimeMinMinutes', product.prep_time_min_minutes,
      'prepTimeMaxMinutes', product.prep_time_max_minutes,
      'likesCount', coalesce(product.likes_count, 0),
      'commentsCount', coalesce(product.comments_count, 0)
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
-- 5. ATUALIZAÇÃO DA RPC public.get_public_restaurant
-- Expõe googleReviewUrl para os clientes.
-- ============================================================================
create or replace function public.get_public_restaurant(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'slug', r.slug,
    'name', r.name,
    'subtitle', coalesce(r.subtitle, ''),
    'logo', r.logo,
    'cover', r.cover,
    'theme', jsonb_build_object(
      'primary', r.theme_primary,
      'background', r.theme_background,
      'text', r.theme_text
    ),
    'description', r.description,
    'address', r.address,
    'phone', r.phone,
    'openingHours', r.opening_hours,
    'revision', r.revision,
    'serviceFeePercent', r.service_fee_percent,
    'timezone', r.timezone,
    'googleReviewUrl', r.google_review_url
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public, anon, authenticated;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

-- ============================================================================
-- 6. ATUALIZAÇÃO DA RPC public.save_restaurant_identity
-- Permite cadastrar, alterar e remover google_review_url com validação rigorosa.
-- ============================================================================
create or replace function public.save_restaurant_identity(
  p_slug text,
  p_revision integer,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.restaurants%rowtype;
  v public.restaurants%rowtype;
  field text;
  media jsonb;
  path text;
  primary_l numeric;
  text_l numeric;
  bg_l numeric;
  v_fee numeric;
  v_tz text;
  v_google_url text;
begin
  rid := public.require_catalog_admin(p_slug);
  select * into old_row from public.restaurants where id = rid for update;
  if p_revision is distinct from old_row.revision then
    raise exception using errcode = '40001', message = 'A identidade foi alterada. Recarregue antes de editar novamente.';
  end if;
  select * into v from jsonb_populate_record(null::public.restaurants, p_values);
  if v.name is null or char_length(btrim(v.name)) not between 1 and 120
  or v.subtitle is null or char_length(v.subtitle) > 120
  or v.description is null or char_length(v.description) > 1000
  or v.address is null or char_length(v.address) > 300
  or v.phone is null or char_length(v.phone) > 40
  or v.opening_hours is null or char_length(v.opening_hours) > 500 then
    raise exception using errcode = '22023', message = 'Confira os dados e os limites dos campos.';
  end if;

  if p_values ? 'service_fee_percent' then
    v_fee := (p_values->>'service_fee_percent')::numeric;
    if v_fee is null or v_fee < 0 or v_fee > 30 then
      raise exception using errcode = '22023', message = 'A taxa de serviço deve estar entre 0% e 30%.';
    end if;
  else
    v_fee := old_row.service_fee_percent;
  end if;

  if p_values ? 'timezone' then
    v_tz := btrim(p_values->>'timezone');
    if v_tz is null or length(v_tz) = 0 then
      raise exception using errcode = '22023', message = 'Informe um fuso horário válido.';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_timezone_names where name = v_tz
    ) then
      raise exception using errcode = '22023', message = 'Fuso horário não reconhecido pelo sistema.';
    end if;
  else
    v_tz := old_row.timezone;
  end if;

  if p_values ? 'google_review_url' then
    v_google_url := nullif(btrim(p_values->>'google_review_url'), '');
    if v_google_url is not null then
      if char_length(v_google_url) not between 10 and 500
      or v_google_url !~* '^https://([a-z0-9-]+\.)*(google\.(com|com\.br)|g\.page|goo\.gl)/' then
        raise exception using errcode = '22023', message = 'Informe um link válido do Perfil da Empresa no Google (ex: https://g.page/r/.../review ou https://maps.app.goo.gl/...).';
      end if;
    end if;
  else
    v_google_url := old_row.google_review_url;
  end if;

  primary_l := public.hex_luminance(v.theme_primary);
  bg_l := public.hex_luminance(v.theme_background);
  text_l := public.hex_luminance(v.theme_text);
  if primary_l is null or bg_l is null or text_l is null or 1.05 / (primary_l + 0.05) < 4.5
  or (greatest(bg_l, text_l) + 0.05) / (least(bg_l, text_l) + 0.05) < 4.5 or 1.05 / (text_l + 0.05) < 4.5 then
    raise exception using errcode = '22023', message = 'Ajuste as cores: texto, cards e botões precisam de contraste mínimo de 4,5:1.';
  end if;

  foreach field in array array['logo', 'cover'] loop
    if not (p_values ? field) then
      raise exception using errcode = '22023', message = 'Informe logo e capa.';
    end if;
    media := p_values->field;
    if media is not null and media <> 'null'::jsonb then
      path := media->>'storagePath';
      if jsonb_typeof(media) is distinct from 'object' or path is null
      or path !~ ('^' || rid::text || '/identity/[0-9a-f-]{36}\.webp$')
      or jsonb_typeof(media->'url') is distinct from 'string'
      or media->>'url' !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/restaurant-images/'
      or right(media->>'url', char_length(path) + 1) <> '/' || path then
        raise exception using errcode = '22023', message = 'Envie logo e capa pelo painel deste restaurante.';
      end if;
      perform id from storage.objects where bucket_id = 'restaurant-images' and name = path for share;
      if not found then
        raise exception using errcode = '22023', message = 'A imagem ainda não foi enviada.';
      end if;
      media := jsonb_build_object('url', media->>'url', 'storagePath', path);
    end if;
    if field = 'logo' then v.logo := nullif(media, 'null'::jsonb); else v.cover := nullif(media, 'null'::jsonb); end if;
  end loop;

  update public.restaurants set
    name = btrim(v.name),
    subtitle = btrim(v.subtitle),
    description = btrim(v.description),
    address = btrim(v.address),
    phone = btrim(v.phone),
    opening_hours = btrim(v.opening_hours),
    theme_primary = upper(v.theme_primary),
    theme_background = upper(v.theme_background),
    theme_text = upper(v.theme_text),
    logo = v.logo,
    cover = v.cover,
    service_fee_percent = v_fee,
    timezone = v_tz,
    google_review_url = v_google_url
  where id = rid;

  return public.get_public_restaurant(p_slug);
end;
$$;

revoke all on function public.save_restaurant_identity(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_restaurant_identity(text, integer, jsonb) to authenticated;

-- ============================================================================
-- 7. PLATAFORMA: SNAPSHOTS DE BACKUP v5 E RECUPERAÇÃO RETROCOMPATÍVEL v1-v5
-- Preserva tempos de preparo em menu_products e google_review_url em restaurants.
-- ============================================================================
alter table public.platform_restaurant_backups
  drop constraint if exists platform_restaurant_backups_format_version_check;

alter table public.platform_restaurant_backups
  alter column format_version set default 5,
  add constraint platform_restaurant_backups_format_version_check
    check (format_version in (1, 2, 3, 4, 5));

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
    'product_likes', 'product_like_events', 'product_comments',
    'restaurant_comment_restricted_terms', 'product_comment_likes'
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
      message = 'Já existe um snapshot em preparação para este restaurante.';
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', o.bucket_id, 'path', o.name,
    'metadata', o.metadata, 'createdAt', o.created_at, 'updatedAt', o.updated_at
  ) order by o.bucket_id, o.name), '[]'::jsonb) into objects_json
  from storage.objects o
  where o.bucket_id in ('menu-images', 'menu-videos', 'restaurant-images')
    and split_part(o.name, '/', 1) = p_restaurant_id::text;

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
    p_backup_id, restaurant.id, restaurant.name, restaurant.slug, 5,
    actor_id, backup_time,
    jsonb_build_object(
      'format', 'elozi-restaurant-snapshot', 'version', 5,
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

-- Staging de recuperação com normalização retrocompatível v1-v5
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
    'product_likes','product_like_events','product_comments',
    'restaurant_comment_restricted_terms','product_comment_likes'
  ];
  v3_names constant text[] := array[
    'restaurants','restaurant_members','restaurant_tables','menu_categories','menu_products',
    'table_visits','guest_sessions','table_tabs','table_tab_guests','table_tab_items',
    'service_requests','service_request_guests','guest_confirmation_codes',
    'staff_confirmation_limits','menu_media_cleanup','restaurant_status_events','restaurant_archive_events',
    'product_likes','product_like_events','product_comments'
  ];
  v2_names constant text[] := array[
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
    raise exception using errcode = '55000', message = 'Selecione um backup concluído.';
  end if;

  snap_version := b.snapshot->>'version';

  if b.snapshot->>'format' <> 'elozi-restaurant-snapshot'
    or snap_version not in ('1', '2', '3', '4', '5')
    or b.format_version::text <> snap_version
    or b.snapshot->>'restaurantId' <> b.source_restaurant_id::text then
    raise exception using errcode = '22023', message = 'Formato ou versão do snapshot inválido.';
  end if;

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
  elsif snap_version = '2' then
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(v2_names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot v2: %', unknown_name;
    end if;
    foreach name in array v2_names loop
      if not (b.snapshot->'tables' ? name) then
        raise exception 'Tabela ausente no snapshot: %', name;
      end if;
    end loop;
  elsif snap_version = '3' then
    select key into unknown_name from jsonb_object_keys(b.snapshot->'tables') as t(key)
      where not (key = any(v3_names)) limit 1;
    if unknown_name is not null then
      raise exception 'Tabela não suportada no snapshot v3: %', unknown_name;
    end if;
    foreach name in array v3_names loop
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

  select c.relname into unknown_name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurant_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r','p') and not (c.relname = any(names)) limit 1;
  if unknown_name is not null then
    raise exception 'Atualize a recuperação para a tabela: %', unknown_name;
  end if;

  foreach name in array names loop
    if snap_version = '1' and name in ('product_likes', 'product_like_events', 'product_comments', 'restaurant_comment_restricted_terms', 'product_comment_likes') then
      rows_json := '[]'::jsonb;
    elsif snap_version = '2' and name in ('product_comments', 'restaurant_comment_restricted_terms', 'product_comment_likes') then
      rows_json := '[]'::jsonb;
    elsif snap_version = '3' and name in ('restaurant_comment_restricted_terms', 'product_comment_likes') then
      rows_json := '[]'::jsonb;
    else
      rows_json := b.snapshot->'tables'->name;
    end if;

    if rows_json is null or jsonb_typeof(rows_json) <> 'array' then
      raise exception 'Tabela ausente ou inválida no snapshot: %', name;
    end if;

    -- Normalização de restaurants para snapshots v1 a v4 (sem google_review_url)
    if snap_version in ('1', '2', '3', '4') and name = 'restaurants' then
      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object' and not (item ? 'google_review_url')
             then item || jsonb_build_object('google_review_url', null)
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    end if;

    -- Normalização de menu_products
    if snap_version = '1' and name = 'menu_products' then
      if exists (
        select 1 from jsonb_array_elements(rows_json) as item
        where jsonb_typeof(item) = 'object' and ((item ? 'likes_count') or (item ? 'comments_count'))
      ) then
        raise exception 'Colunas incompatíveis em menu_products para snapshot v1.';
      end if;

      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object'
             then item || jsonb_build_object(
               'likes_count', 0,
               'comments_count', 0,
               'prep_time_min_minutes', null,
               'prep_time_max_minutes', null
             )
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    elsif snap_version = '2' and name = 'menu_products' then
      if exists (
        select 1 from jsonb_array_elements(rows_json) as item
        where jsonb_typeof(item) = 'object' and (item ? 'comments_count')
      ) then
        raise exception 'Colunas incompatíveis em menu_products para snapshot v2.';
      end if;

      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object'
             then item || jsonb_build_object(
               'comments_count', 0,
               'prep_time_min_minutes', null,
               'prep_time_max_minutes', null
             )
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    elsif snap_version in ('3', '4') and name = 'menu_products' then
      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object'
             then item || jsonb_build_object(
               'prep_time_min_minutes', null,
               'prep_time_max_minutes', null
             )
             else item
        end
      ), '[]'::jsonb)
      into rows_json
      from jsonb_array_elements(rows_json) as item;
    end if;

    -- Em snapshots v1, v2 ou v3, a tabela product_comments (se existente) não tinha likes_count
    if snap_version in ('1', '2', '3') and name = 'product_comments' then
      select coalesce(jsonb_agg(
        case when jsonb_typeof(item) = 'object' and not (item ? 'likes_count')
             then item || jsonb_build_object('likes_count', 0)
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
      where a.attrelid = ('public.' || name)::regclass and a.attnum > 0 and not a.attisdropped
        and a.attgenerated = '' and a.attidentity = '';

    select jsonb_agg(a.attname order by a.attname) into columns_json
      from pg_catalog.pg_attribute a
      where a.attrelid = ('public.' || name)::regclass and a.attnum > 0 and not a.attisdropped;

    if exists (select 1 from jsonb_array_elements(rows_json) r
      where jsonb_typeof(r) <> 'object' or
        (select jsonb_agg(k order by k) from jsonb_object_keys(r) k) is distinct from columns_json) then
      raise exception 'Colunas incompatíveis em %. Não é permitido omitir dados silenciosamente.', name;
    end if;

    execute format('drop table if exists pg_temp.%I', 'elozi_restore_' || name);
    execute format('create temporary table %I (like public.%I including all) on commit drop',
      'elozi_restore_' || name, name);
    execute format('insert into pg_temp.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)',
      'elozi_restore_' || name, columns_sql, columns_sql, name) using rows_json;
    get diagnostics row_count = row_count;
    total := total + row_count;

    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text), ''[]''::jsonb) from pg_temp.%I r',
      'elozi_restore_' || name) into canonical;
    select coalesce(jsonb_agg(r order by r::text), '[]'::jsonb) into expected from jsonb_array_elements(rows_json) r;
    if canonical is distinct from expected then
      raise exception 'Dados ou valores gerados incompatíveis em %.', name;
    end if;

    if name = 'restaurants' then
      if row_count <> 1 then raise exception 'O snapshot deve conter um único restaurante.'; end if;
    elsif name not in ('guest_confirmation_codes', 'staff_confirmation_limits') then
      execute format('select exists(select 1 from pg_temp.%I where restaurant_id <> $1)',
        'elozi_restore_' || name) into has_invalid using b.source_restaurant_id;
      if has_invalid then raise exception 'Dados de outro restaurante em %.', name; end if;
    end if;
  end loop;

  -- Validações de consistência lógica de contadores
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

  if exists (
    select 1
    from pg_temp.elozi_restore_menu_products p
    where p.comments_count is distinct from coalesce((
      select count(*)::integer
      from pg_temp.elozi_restore_product_comments c
      where c.product_id = p.id
        and c.status = 'approved'
    ), 0)
  ) then
    raise exception 'Contagem de comentários inconsistente com os registros aprovados de product_comments no snapshot.';
  end if;

  if exists (
    select 1
    from pg_temp.elozi_restore_product_comments c
    where c.likes_count is distinct from coalesce((
      select count(*)::integer
      from pg_temp.elozi_restore_product_comment_likes l
      where l.comment_id = c.id
    ), 0)
  ) then
    raise exception 'Contagem de curtidas do comentário inconsistente com os registros de product_comment_likes no snapshot.';
  end if;

  select * into root from pg_temp.elozi_restore_restaurants;
  if root.id <> b.source_restaurant_id or root.active or root.archived_at is null then
    raise exception 'O restaurante recuperado precisa permanecer arquivado e inativo.';
  end if;

  for fk in
    select c.*, sc.relname as source_name, tc.relname as target_name, tn.nspname as target_schema
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class sc on sc.oid = c.conrelid
    join pg_catalog.pg_namespace sn on sn.oid = sc.relnamespace
    join pg_catalog.pg_class tc on tc.oid = c.confrelid
    join pg_catalog.pg_namespace tn on tn.oid = tc.relnamespace
    where c.contype = 'f' and sn.nspname = 'public' and sc.relname = any(names)
  loop
    if fk.confmatchtype <> 's' then raise exception 'Tipo de relacionamento não suportado: %', fk.conname; end if;
    if fk.target_schema = 'public' and fk.target_name = any(names) then
      target := format('pg_temp.%I', 'elozi_restore_' || fk.target_name);
    elsif fk.target_schema = 'auth' and fk.target_name = 'users' then
      target := 'auth.users';
    else raise exception 'Relacionamento não suportado: %', fk.conname;
    end if;
    select string_agg(format('s.%I=t.%I', sa.attname, ta.attname), ' and ' order by x.ord),
      string_agg(format('s.%I is not null', sa.attname), ' and ' order by x.ord)
      into conditions, nonnull
      from unnest(fk.conkey, fk.confkey) with ordinality x(skey, tkey, ord)
      join pg_catalog.pg_attribute sa on sa.attrelid = fk.conrelid and sa.attnum = x.skey
      join pg_catalog.pg_attribute ta on ta.attrelid = fk.confrelid and ta.attnum = x.tkey;
    execute format('select exists(select 1 from pg_temp.%I s where %s and not exists(select 1 from %s t where %s))',
      'elozi_restore_' || fk.source_name, nonnull, target, conditions) into has_invalid;
    if has_invalid then
      raise exception 'Relacionamento ausente em %. Confira as contas do Auth e a integridade do backup.', fk.conname;
    end if;
  end loop;

  return jsonb_build_object(
    'backupId', b.id, 'restaurantId', root.id, 'name', root.name, 'slug', root.slug,
    'tableCount', case
      when snap_version = '1' then cardinality(v1_names)
      when snap_version = '2' then cardinality(v2_names)
      when snap_version = '3' then cardinality(v3_names)
      else cardinality(names)
    end,
    'rowCount', total,
    'sourceExists', exists(select 1 from public.restaurants where id = root.id),
    'slugConflict', exists(select 1 from public.restaurants where slug = root.slug and id <> root.id)
  );
end;
$$;

revoke all on function public.stage_platform_backup_recovery(uuid) from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
