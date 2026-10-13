begin;

-- ============================================================================
-- BLOCO 9.4: AGRUPAMENTO INTELIGENTE E SINCRONISMO KDS
-- 1. Criação da RPC public.get_guest_table_tab_context com retorno atômico
--    de comanda, total e itens com campos explícitos de ciclo de produção KDS.
-- 2. Atualização da RPC public.add_table_tab_item para que produtos com
--    estação 'none' já nasçam como 'delivered' e prep_delivered_at preenchido.
-- ============================================================================

-- 1. ATUALIZAÇÃO DA RPC public.add_table_tab_item
-- Produtos com preparation_station = 'none' já nascem entregues.
create or replace function public.add_table_tab_item(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_item_id uuid
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_product public.menu_products%rowtype;
  target_item public.table_tab_items%rowtype;
  v_station text;
  v_prod_status text;
  v_delivered_at timestamptz;
begin
  if p_restaurant_slug is null or length(btrim(p_restaurant_slug)) = 0
    or p_table_tab_id is null or p_product_id is null or p_item_id is null
    or p_quantity is null or p_quantity not between 1 and 99 then
    raise exception using errcode = '22023', message = 'Selecione o produto e uma quantidade entre 1 e 99.';
  end if;

  select tab.table_visit_id into target_visit_id from public.table_tabs as tab
  join public.restaurants as restaurant on restaurant.id = tab.restaurant_id
  where tab.id = p_table_tab_id and restaurant.slug = p_restaurant_slug and restaurant.active;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste restaurante.';
  end if;

  target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste atendimento.';
  end if;

  -- Repetir o mesmo ID e os mesmos dados não duplica o consumo.
  select item.* into target_item from public.table_tab_items as item
  where item.id = p_item_id for update;
  if found then
    if target_item.table_tab_id = target_tab.id
      and target_item.restaurant_id = target_visit.restaurant_id
      and target_item.product_id = p_product_id and target_item.quantity = p_quantity
      and target_item.added_by_member_id = target_visit.assigned_member_id then
      return target_item;
    end if;
    raise exception using errcode = '22023', message = 'Identificador de lançamento já utilizado. Atualize a comanda.';
  end if;

  if target_visit.status <> 'open' or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Não é possível registrar consumo em uma comanda encerrada.';
  end if;

  select product.* into target_product from public.menu_products as product
  where product.id = p_product_id and product.restaurant_id = target_visit.restaurant_id for share;
  if not found or not target_product.available then
    raise exception using errcode = '22023', message = 'Produto indisponível neste restaurante.';
  end if;

  perform category.id from public.menu_categories as category
  where category.id = target_product.category_id and category.restaurant_id = target_visit.restaurant_id
    and category.active for share;
  if not found then
    raise exception using errcode = '22023', message = 'A categoria deste produto está indisponível.';
  end if;

  v_station := coalesce(target_product.preparation_station, 'kitchen');
  if v_station = 'none' then
    v_prod_status := 'delivered';
    v_delivered_at := clock_timestamp();
  else
    v_prod_status := 'pending';
    v_delivered_at := null;
  end if;

  insert into public.table_tab_items (
    id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
    product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
    preparation_station, production_status, prep_delivered_at
  ) values (
    p_item_id, target_visit.restaurant_id, target_visit.restaurant_table_id,
    target_visit.id, target_tab.id, target_product.id, target_product.name,
    target_product.price_in_cents, p_quantity, target_visit.assigned_member_id,
    greatest(clock_timestamp(), target_tab.created_at),
    v_station, v_prod_status, v_delivered_at
  ) returning * into target_item;

  return target_item;
end;
$$;

revoke all privileges on function public.add_table_tab_item(text, uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.add_table_tab_item(text, uuid, uuid, integer, uuid) to authenticated;

-- ============================================================================
-- 2. NOVA RPC: public.get_guest_table_tab_context
-- Retorna de forma atômica e segura no servidor o contexto da comanda
-- e da sessão do cliente anônimo, incluindo a lista de itens com os campos
-- explícitos do ciclo de produção do KDS.
-- ============================================================================
create or replace function public.get_guest_table_tab_context(
  p_restaurant_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_restaurant_id uuid;
  v_table_id uuid;
  v_session record;
  v_visit_status text;
  v_tab record;
  v_items jsonb;
  v_total bigint;
begin
  v_user_id := auth.uid();
  if v_user_id is null or not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return null;
  end if;

  if p_restaurant_slug is null or length(btrim(p_restaurant_slug)) = 0 then
    return null;
  end if;

  if p_table_number is null or p_table_number < 1 or p_table_number > 999 then
    return null;
  end if;

  -- 1. Validar restaurante ativo
  select r.id into v_restaurant_id
  from public.restaurants as r
  where r.slug = p_restaurant_slug and r.active = true;

  if v_restaurant_id is null then
    return null;
  end if;

  -- 2. Validar mesa ativa
  select rt.id into v_table_id
  from public.restaurant_tables as rt
  where rt.restaurant_id = v_restaurant_id
    and rt.table_number = p_table_number
    and rt.active = true;

  if v_table_id is null then
    return null;
  end if;

  -- 3. Obter a sessão mais recente do usuário nesta mesa deste restaurante
  select
    gs.id,
    gs.restaurant_id,
    gs.restaurant_table_id,
    gs.status,
    gs.table_visit_id,
    gs.created_at,
    gs.expires_at
  into v_session
  from public.guest_sessions as gs
  where gs.user_id = v_user_id
    and gs.restaurant_id = v_restaurant_id
    and gs.restaurant_table_id = v_table_id
  order by gs.created_at desc
  limit 1;

  if v_session.id is null then
    return null;
  end if;

  -- 4. Tratar expiração temporal
  if v_session.status = 'expired' or v_session.expires_at <= now() then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'expired',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb
    );
  end if;

  -- 5. Tratar status = 'revoked'
  if v_session.status = 'revoked' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'revoked',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb
    );
  end if;

  -- 6. Tratar status = 'pending'
  if v_session.status = 'pending' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'pending',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb
    );
  end if;

  if v_session.status <> 'active' then
    return null;
  end if;

  if v_session.table_visit_id is null then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'revoked',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb
    );
  end if;

  select v.status into v_visit_status
  from public.table_visits as v
  where v.id = v_session.table_visit_id
    and v.restaurant_id = v_restaurant_id
    and v.restaurant_table_id = v_table_id;

  if v_visit_status is null or v_visit_status <> 'open' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'revoked',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb
    );
  end if;

  -- 7. Obter a comanda vinculada
  select
    tt.id as table_tab_id,
    tt.status as tab_status,
    tt.label as tab_label
  into v_tab
  from public.table_tab_guests as ttg
  join public.table_tabs as tt
    on tt.id = ttg.table_tab_id
   and tt.table_visit_id = v_session.table_visit_id
   and tt.restaurant_id = v_restaurant_id
   and tt.restaurant_table_id = v_table_id
  where ttg.guest_session_id = v_session.id
    and ttg.restaurant_id = v_restaurant_id
    and ttg.restaurant_table_id = v_table_id
    and ttg.table_visit_id = v_session.table_visit_id
  limit 1;

  if v_tab.table_tab_id is null then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'active',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb
    );
  end if;

  -- 8. Coletar itens da comanda com todos os campos de KDS explicitamente
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'restaurant_id', i.restaurant_id,
        'restaurant_table_id', i.restaurant_table_id,
        'table_visit_id', i.table_visit_id,
        'table_tab_id', i.table_tab_id,
        'product_id', i.product_id,
        'product_name', i.product_name,
        'unit_price_in_cents', i.unit_price_in_cents,
        'quantity', i.quantity,
        'line_total_in_cents', i.line_total_in_cents,
        'status', i.status,
        'added_by_member_id', i.added_by_member_id,
        'created_at', i.created_at,
        'cancelled_by_member_id', i.cancelled_by_member_id,
        'cancelled_at', i.cancelled_at,
        'cancellation_reason', i.cancellation_reason,
        'production_status', coalesce(i.production_status, 'pending'),
        'preparation_station', coalesce(i.preparation_station, 'kitchen'),
        'prep_started_at', i.prep_started_at,
        'prep_ready_at', i.prep_ready_at,
        'prep_delivered_at', i.prep_delivered_at
      ) order by i.created_at, i.id
    ), '[]'::jsonb),
    coalesce(sum(i.line_total_in_cents) filter (where i.status = 'active'), 0)
  into v_items, v_total
  from public.table_tab_items as i
  where i.table_tab_id = v_tab.table_tab_id
    and i.restaurant_id = v_restaurant_id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'restaurant_id', v_session.restaurant_id,
    'restaurant_table_id', v_session.restaurant_table_id,
    'status', 'active',
    'table_visit_id', v_session.table_visit_id,
    'table_tab_id', v_tab.table_tab_id,
    'tab_status', v_tab.tab_status,
    'tab_label', v_tab.tab_label,
    'created_at', v_session.created_at,
    'expires_at', v_session.expires_at,
    'totalInCents', coalesce(v_total, 0),
    'items', coalesce(v_items, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_guest_table_tab_context(text, integer) from public, anon, authenticated;
grant execute on function public.get_guest_table_tab_context(text, integer) to authenticated;

commit;
