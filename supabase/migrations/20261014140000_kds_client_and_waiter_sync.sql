begin;

-- ============================================================================
-- BLOCO 9.3: INTEGRAÇÃO PONTA A PONTA DO KDS
-- Sincronização de estação de preparo no cadastro de produtos e visibilidade
-- estendida de produção para clientes e equipe de salão.
-- ============================================================================

-- 1. ATUALIZAÇÃO DA RPC public.save_menu_product
-- Adiciona suporte e validação de `preparation_station` ('kitchen', 'bar', 'none').
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
  v_station text;
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

  -- Estação de preparo (KDS)
  v_station := coalesce(nullif(btrim(p_values->>'preparation_station'), ''), 'kitchen');
  if v_station not in ('kitchen', 'bar', 'none') then
    raise exception using errcode = '22023', message = 'Estação de preparo inválida. Escolha kitchen, bar ou none.';
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
      preparation_station = v_station,
      revision = revision + 1
    where id = p_id;
  else
    if p_revision <> 0 then
      raise exception using errcode = '22023', message = 'Produto não encontrado. Atualize a lista.';
    end if;

    insert into public.menu_products (
      id, restaurant_id, category_id, catalog_key, slug, name,
      short_description, description, price_in_cents, available, featured,
      sort_order, dietary_information, prep_time_min_minutes, prep_time_max_minutes,
      preparation_station
    ) values (
      p_id, rid, v.category_id, p_id::text, v.slug, btrim(v.name),
      btrim(v.short_description), btrim(v.description), v.price_in_cents, v.available, v.featured,
      v.sort_order, nullif(btrim(v.dietary_information), ''), v_prep_min, v_prep_max,
      v_station
    );
  end if;

  return p_id;
end;
$$;

revoke all on function public.save_menu_product(text, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_menu_product(text, uuid, integer, jsonb) to authenticated;

-- ============================================================================
-- 2. ATUALIZAÇÃO DA RPC public.get_table_tab_consumption
-- Garante exposição de preparation_station na lista de produtos e preserva
-- a serialização completa de itens (to_jsonb(item)) com os campos de KDS.
-- ============================================================================
create or replace function public.get_table_tab_consumption(
  p_restaurant_id uuid, p_table_tab_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id,
        'name', product.name,
        'price_in_cents', product.price_in_cents,
        'preparation_station', product.preparation_station
      ) order by product.sort_order, product.id)
      from public.menu_products as product
      join public.menu_categories as category
        on category.id = product.category_id and category.restaurant_id = product.restaurant_id
      where product.restaurant_id = tab.restaurant_id and product.available and category.active
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
      from public.table_tab_items as item
      where item.table_tab_id = tab.id and item.restaurant_id = tab.restaurant_id
    ), '[]'::jsonb),
    'totalInCents', coalesce((
      select sum(item.line_total_in_cents)
      from public.table_tab_items as item
      where item.table_tab_id = tab.id and item.restaurant_id = tab.restaurant_id
        and item.status = 'active'
    ), 0)
  )
  from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.restaurant_id = p_restaurant_id;
$$;

revoke all privileges on function public.get_table_tab_consumption(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_table_tab_consumption(uuid, uuid) to authenticated;

-- ============================================================================
-- 3. ATUALIZAÇÃO DA RPC public.get_public_menu
-- Expõe preparationStation no cardápio público para paridade de metadados.
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
      'preparationStation', product.preparation_station,
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

commit;
