-- ============================================================================
-- BLOCO 17: PONTE ESTOQUE-CARDÁPIO, PEDIDO DIRETO KDS E LIBERAÇÃO DE MESA
-- ============================================================================

begin;

-- ============================================================================
-- 1. PONTE ESTOQUE <-> CARDÁPIO: COLUNA inventory_item_id EM menu_products
-- ============================================================================
alter table public.menu_products
  add column if not exists inventory_item_id uuid references public.inventory_items(id) on delete set null;

create index if not exists menu_products_inventory_item_id_idx
  on public.menu_products (inventory_item_id);

-- Permitir que itens e comandas abertas via pedido digital direto da mesa
-- não exijam obrigatoriamente um funcionário logado
alter table public.table_tabs
  alter column created_by_member_id drop not null;

alter table public.table_tabs
  drop constraint if exists table_tabs_valid_closure;

alter table public.table_tabs
  add constraint table_tabs_valid_closure
  check (
    (
      status = 'open'
      and closed_by_member_id is null
      and closed_at is null
    )
    or
    (
      status = 'closed'
      and closed_at is not null
      and closed_at >= created_at
    )
  );

alter table public.table_tab_items
  alter column added_by_member_id drop not null;


-- ============================================================================
-- 2. TABELA DE ALERTAS: EXPANSÃO DOS TIPOS DE ATENDIMENTO
-- ============================================================================
alter table public.restaurant_alerts
  drop constraint if exists restaurant_alerts_type_check;

alter table public.restaurant_alerts
  add constraint restaurant_alerts_type_check
  check (type in ('low_stock', 'system', 'call_waiter', 'close_table_request'));

-- ============================================================================
-- 3. ATUALIZAÇÃO DA RPC public.save_menu_product
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
  v_station text;
  v_inv_id uuid;
begin
  rid := public.require_catalog_admin(p_slug);
  select * into v from jsonb_populate_record(null::public.menu_products, p_values);

  if p_id is null or p_revision is null or p_revision < 0 or v.name is null
    or char_length(btrim(v.name)) not between 1 and 120 or v.slug is null
    or char_length(v.slug) > 120 or v.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or v.short_description is null or char_length(v.short_description) > 200
    or v.description is null or char_length(v.description) > 1000
    or v.price_in_cents is null or v.price_in_cents < 0
    or v.available is null or v.featured is null or v.sort_order is null
    or v.sort_order not between 0 and 9999 or v.category_id is null
    or char_length(coalesce(v.dietary_information, '')) > 1000 then
    raise exception using errcode = '22023', message = 'Confira os dados do produto.';
  end if;

  -- Validação da Estação KDS
  v_station := coalesce(nullif(btrim(p_values->>'preparation_station'), ''), 'kitchen');
  if v_station not in ('kitchen', 'bar', 'none') then
    raise exception using errcode = '22023', message = 'Estação de preparo inválida. Use kitchen, bar ou none.';
  end if;

  -- Validação de tempos de preparo (em minutos)
  if p_values ? 'prep_time_min_minutes' and p_values->>'prep_time_min_minutes' is not null and btrim(p_values->>'prep_time_min_minutes') <> '' then
    v_prep_min := (p_values->>'prep_time_min_minutes')::integer;
    if v_prep_min < 1 or v_prep_min > 1440 then
      raise exception using errcode = '22023', message = 'O tempo mínimo de preparo deve ser entre 1 e 1440 minutos.';
    end if;
  else
    v_prep_min := null;
  end if;

  if p_values ? 'prep_time_max_minutes' and p_values->>'prep_time_max_minutes' is not null and btrim(p_values->>'prep_time_max_minutes') <> '' then
    v_prep_max := (p_values->>'prep_time_max_minutes')::integer;
    if v_prep_max < 1 or v_prep_max > 1440 then
      raise exception using errcode = '22023', message = 'O tempo máximo de preparo deve ser entre 1 e 1440 minutos.';
    end if;
  else
    v_prep_max := null;
  end if;

  if v_prep_min is not null and v_prep_max is not null and v_prep_min > v_prep_max then
    raise exception using errcode = '22023', message = 'O tempo mínimo de preparo não pode ser maior que o tempo máximo.';
  end if;

  -- Validação do vínculo opcional de estoque
  if p_values ? 'inventory_item_id' and p_values->>'inventory_item_id' is not null and btrim(p_values->>'inventory_item_id') <> '' then
    v_inv_id := (p_values->>'inventory_item_id')::uuid;
    perform id from public.inventory_items where id = v_inv_id and restaurant_id = rid;
    if not found then
      raise exception using errcode = '22023', message = 'Item de estoque selecionado não pertence a este restaurante.';
    end if;
  else
    v_inv_id := null;
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
      inventory_item_id = v_inv_id,
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
      preparation_station, inventory_item_id
    ) values (
      p_id, rid, v.category_id, p_id::text, v.slug, btrim(v.name),
      btrim(v.short_description), btrim(v.description), v.price_in_cents, v.available, v.featured,
      v.sort_order, nullif(btrim(v.dietary_information), ''), v_prep_min, v_prep_max,
      v_station, v_inv_id
    );
  end if;

  return p_id;
end;
$$;

revoke all on function public.save_menu_product(text, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_menu_product(text, uuid, integer, jsonb) to authenticated;

-- ============================================================================
-- 4. ATUALIZAÇÃO DA RPC public.get_public_menu COM STATUS DE ESTOQUE
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
      'inventoryItemId', product.inventory_item_id,
      'inventory_item_id', product.inventory_item_id,
      'isOutOfStock', (product.inventory_item_id is not null and coalesce(inv.current_quantity, 0) <= 0),
      'is_out_of_stock', (product.inventory_item_id is not null and coalesce(inv.current_quantity, 0) <= 0),
      'likesCount', coalesce(product.likes_count, 0),
      'commentsCount', coalesce(product.comments_count, 0)
    ) order by product.sort_order, product.id)
    from public.menu_products as product
    join public.menu_categories as category
      on category.id = product.category_id and category.restaurant_id = product.restaurant_id
    left join public.inventory_items as inv
      on inv.id = product.inventory_item_id
    where product.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb)
)
from public.restaurants as restaurant
where restaurant.slug = p_restaurant_slug and restaurant.active;
$$;

revoke all on function public.get_public_menu(text) from public, anon, authenticated;
grant execute on function public.get_public_menu(text) to anon, authenticated;

-- ============================================================================
-- 5. RPC PÚBLICA: create_direct_table_order
-- Cria pedido direto do cliente para a mesa identificada via QR Code,
-- deduz o estoque atomicamente e projeta o item diretamente no KDS.
-- ============================================================================
create or replace function public.create_direct_table_order(
  p_table_id uuid,
  p_product_id uuid,
  p_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_table public.restaurant_tables%rowtype;
  target_rest public.restaurants%rowtype;
  target_prod public.menu_products%rowtype;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  v_inv_qty integer;
  v_station text;
  v_prod_status text;
  v_delivered_at timestamptz;
  v_item_id uuid;
begin
  if p_table_id is null or p_product_id is null or p_quantity is null or p_quantity not between 1 and 99 then
    raise exception using errcode = '22023', message = 'Informe a mesa, o produto e uma quantidade entre 1 e 99.';
  end if;

  -- 1. Validar mesa e restaurante
  select * into target_table
  from public.restaurant_tables
  where id = p_table_id
    and deleted_at is null
    and (coalesce(is_active, active, true) = true);

  if not found then
    raise exception using errcode = '22023', message = 'Mesa não identificada ou inativa.';
  end if;

  select * into target_rest
  from public.restaurants
  where id = target_table.restaurant_id
    and active = true;

  if not found then
    raise exception using errcode = '22023', message = 'Restaurante temporariamente indisponível.';
  end if;

  if public.get_restaurant_billing_status(target_rest.subscription_expires_at) = 'expired' then
    raise exception using errcode = '42501', message = 'Atendimento suspenso temporariamente no restaurante.';
  end if;

  -- 2. Validar produto
  select * into target_prod
  from public.menu_products
  where id = p_product_id
    and restaurant_id = target_rest.id
    and available = true;

  if not found then
    raise exception using errcode = '22023', message = 'Produto temporariamente indisponível.';
  end if;

  -- 3. Validação e Baixa Atômica de Estoque
  if target_prod.inventory_item_id is not null then
    select current_quantity into v_inv_qty
    from public.inventory_items
    where id = target_prod.inventory_item_id
    for update;

    if v_inv_qty is null or v_inv_qty < p_quantity then
      raise exception using errcode = '22023', message = 'ITEM_OUT_OF_STOCK: Produto esgotado no estoque.';
    end if;

    update public.inventory_items
    set current_quantity = current_quantity - p_quantity
    where id = target_prod.inventory_item_id;
  end if;

  -- 4. Localizar ou Inicializar Atendimento (table_visit) da Mesa
  select * into target_visit
  from public.table_visits
  where restaurant_table_id = p_table_id
    and status = 'open'
  order by opened_at desc
  limit 1
  for update;

  if not found then
    insert into public.table_visits (restaurant_id, restaurant_table_id, status)
    values (target_rest.id, p_table_id, 'open')
    returning * into target_visit;
  end if;

  -- 5. Localizar ou Inicializar Comanda (table_tab) da Mesa
  select * into target_tab
  from public.table_tabs
  where table_visit_id = target_visit.id
    and status = 'open'
  order by created_at asc
  limit 1
  for update;

  if not found then
    insert into public.table_tabs (
      restaurant_id, restaurant_table_id, table_visit_id, label, status
    ) values (
      target_rest.id, p_table_id, target_visit.id, 'Mesa ' || lpad(target_table.table_number::text, 2, '0'), 'open'
    ) returning * into target_tab;
  end if;

  -- 6. Configurar Esteira KDS
  v_station := coalesce(target_prod.preparation_station, 'kitchen');
  if v_station = 'none' then
    v_prod_status := 'delivered';
    v_delivered_at := timezone('utc', now());
  else
    v_prod_status := 'pending';
    v_delivered_at := null;
  end if;

  -- 7. Inserir Item de Consumo
  v_item_id := gen_random_uuid();
  insert into public.table_tab_items (
    id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
    product_id, product_name, unit_price_in_cents, quantity, status,
    preparation_station, production_status, created_at, prep_delivered_at
  ) values (
    v_item_id, target_rest.id, p_table_id, target_visit.id, target_tab.id,
    target_prod.id, target_prod.name, target_prod.price_in_cents, p_quantity, 'active',
    v_station, v_prod_status, timezone('utc', now()), v_delivered_at
  );

  return jsonb_build_object(
    'success', true,
    'itemId', v_item_id,
    'tableTabId', target_tab.id,
    'tableVisitId', target_visit.id,
    'tableNumber', target_table.table_number,
    'productName', target_prod.name,
    'quantity', p_quantity,
    'unitPriceInCents', target_prod.price_in_cents,
    'productionStatus', v_prod_status,
    'preparationStation', v_station
  );
end;
$$;

revoke all on function public.create_direct_table_order(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.create_direct_table_order(uuid, uuid, integer) to anon, authenticated;

-- ============================================================================
-- 6. RPC PÚBLICA: request_table_assistance
-- Dispara alertas de assistência ("call_waiter" ou "close_table_request")
-- com trava anti-spam para o sino da topbar em Realtime.
-- ============================================================================
create or replace function public.request_table_assistance(
  p_table_id uuid,
  p_request_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.restaurant_tables%rowtype;
  v_rest public.restaurants%rowtype;
  v_alert_id uuid;
begin
  if p_table_id is null or p_request_type is null or p_request_type not in ('call_waiter', 'close_table_request') then
    raise exception using errcode = '22023', message = 'Tipo de solicitação ou identificador de mesa inválido.';
  end if;

  select * into v_table
  from public.restaurant_tables
  where id = p_table_id
    and deleted_at is null
    and (coalesce(is_active, active, true) = true);

  if not found then
    raise exception using errcode = '22023', message = 'Mesa não encontrada ou inativa.';
  end if;

  select * into v_rest
  from public.restaurants
  where id = v_table.restaurant_id
    and active = true;

  if not found then
    raise exception using errcode = '22023', message = 'Restaurante indisponível.';
  end if;

  if public.get_restaurant_billing_status(v_rest.subscription_expires_at) = 'expired' then
    raise exception using errcode = '42501', message = 'Atendimento suspenso no restaurante.';
  end if;

  -- Trava anti-spam de 3 minutos para chamados não atendidos do mesmo tipo na mesma mesa
  if exists (
    select 1
    from public.restaurant_alerts
    where restaurant_id = v_rest.id
      and reference_id = p_table_id
      and type = p_request_type
      and is_read = false
      and created_at >= timezone('utc', now()) - interval '3 minutes'
  ) then
    return jsonb_build_object(
      'success', true,
      'throttled', true,
      'message', 'Chamado já registrado recentemente. A equipe foi notificada.'
    );
  end if;

  insert into public.restaurant_alerts (
    restaurant_id, type, title, message, reference_id, is_read, created_at
  ) values (
    v_rest.id,
    p_request_type,
    case
      when p_request_type = 'call_waiter' then 'Mesa ' || lpad(v_table.table_number::text, 2, '0') || ' solicita atendimento'
      else 'Mesa ' || lpad(v_table.table_number::text, 2, '0') || ' solicitou encerramento'
    end,
    case
      when p_request_type = 'call_waiter' then 'Cliente na mesa ' || coalesce(v_table.label, 'Mesa ' || v_table.table_number) || ' chamou a equipe.'
      else 'Cliente na mesa ' || coalesce(v_table.label, 'Mesa ' || v_table.table_number) || ' pediu a conta / encerramento do consumo.'
    end,
    p_table_id,
    false,
    timezone('utc', now())
  ) returning id into v_alert_id;

  return jsonb_build_object(
    'success', true,
    'throttled', false,
    'alertId', v_alert_id,
    'message', 'Chamado enviado com sucesso para a equipe!'
  );
end;
$$;

revoke all on function public.request_table_assistance(uuid, text) from public, anon, authenticated;
grant execute on function public.request_table_assistance(uuid, text) to anon, authenticated;

-- ============================================================================
-- 7. RPC ADMINISTRATIVA: reset_and_release_table
-- Encerra o ciclo da mesa sem exigir fluxo financeiro/caixa no sistema,
-- marcando alertas como lidos e deixando a mesa limpa para o próximo cliente.
-- ============================================================================
create or replace function public.reset_and_release_table(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.restaurant_tables%rowtype;
  v_member_id uuid;
begin
  if p_table_id is null then
    raise exception using errcode = '22023', message = 'Informe a mesa a ser liberada.';
  end if;

  select * into v_table
  from public.restaurant_tables
  where id = p_table_id
    and deleted_at is null;

  if not found then
    raise exception using errcode = '22023', message = 'Mesa não encontrada.';
  end if;

  -- Trava de autorização
  if not (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as m
      where m.restaurant_id = v_table.restaurant_id
        and m.user_id = (select auth.uid())
        and m.active = true
        and m.role in ('admin', 'waiter')
    )
  ) then
    raise exception using errcode = '42501', message = 'Acesso não autorizado para liberar esta mesa.';
  end if;

  select id into v_member_id
  from public.restaurant_members
  where restaurant_id = v_table.restaurant_id
    and user_id = (select auth.uid())
  limit 1;

  -- 1. Encerrar comandas abertas da mesa primeiro (para satisfazer prevent_visit_close_with_open_tabs)
  update public.table_tabs
  set status = 'closed',
      closed_by_member_id = v_member_id,
      closed_at = timezone('utc', now())
  where restaurant_table_id = p_table_id
    and status = 'open';

  -- 2. Encerrar atendimentos abertos da mesa
  update public.table_visits
  set status = 'closed',
      closed_at = timezone('utc', now())
  where restaurant_table_id = p_table_id
    and status = 'open';

  -- 3. Encerrar solicitações de serviço pendentes
  update public.service_requests
  set status = 'cancelled',
      resolved_at = timezone('utc', now()),
      resolved_by_member_id = v_member_id
  where restaurant_table_id = p_table_id
    and status = 'pending';

  -- 4. Marcar alertas da mesa como lidos
  update public.restaurant_alerts
  set is_read = true
  where reference_id = p_table_id
    and is_read = false;

  return jsonb_build_object(
    'success', true,
    'tableId', p_table_id,
    'tableNumber', v_table.table_number,
    'message', 'Mesa liberada e pronta para o próximo cliente.'
  );
end;
$$;

revoke all on function public.reset_and_release_table(uuid) from public, anon;
grant execute on function public.reset_and_release_table(uuid) to authenticated;

commit;
