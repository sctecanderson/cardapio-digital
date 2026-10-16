-- ============================================================================
-- BLOCO 19: DISPARO DE ALERTA DE PRATO PRONTO (KDS -> GARÇOM / EQUIPE)
-- ============================================================================

-- 1. EXPANSÃO DO DOMÍNIO DE TIPOS DE ALERTA DO RESTAURANTE
alter table public.restaurant_alerts
  drop constraint if exists restaurant_alerts_type_check;

alter table public.restaurant_alerts
  add constraint restaurant_alerts_type_check
  check (type in ('low_stock', 'system', 'call_waiter', 'close_table_request', 'dish_ready'));

-- 2. ATUALIZAÇÃO DA RPC update_tab_item_production_status
create or replace function public.update_tab_item_production_status(
  p_restaurant_slug text,
  p_item_id uuid,
  p_target_status text
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_subscription_plan text;
  target_member_id uuid;
  target_member_role text;
  target_table_id uuid;
  target_visit_id uuid;
  target_tab_id uuid;
  v_table_number smallint;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_item public.table_tab_items%rowtype;
begin
  current_user_id := auth.uid();
  if current_user_id is null
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_item_id is null or p_target_status is null or btrim(p_target_status) = '' then
    raise exception using
      errcode = '22023',
      message = 'Informe o item e o estado de produção desejado.';
  end if;

  if p_target_status not in ('pending', 'preparing', 'ready', 'delivered') then
    raise exception using
      errcode = '22023',
      message = 'Estado de produção inválido.';
  end if;

  -- 1. Restaurante ativo com bloqueio compartilhado (FOR SHARE)
  select restaurant.id, restaurant.subscription_plan
  into target_restaurant_id, target_subscription_plan
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  -- Validação de plano comercial para o KDS
  if target_subscription_plan = 'basic' then
    raise exception using
      errcode = '42501',
      message = 'O módulo KDS é exclusivo para planos Pro e Premium. Faça upgrade para utilizar a esteira de produção.';
  end if;

  -- 2. Membro da equipe com vínculo ativo e papel permitido (FOR SHARE)
  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  -- 3. Localizar e validar item
  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Item de comanda não encontrado.';
  end if;

  if target_item.restaurant_id <> target_restaurant_id then
    raise exception using
      errcode = '42501',
      message = 'Item pertence a outro restaurante.';
  end if;

  if target_item.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Itens cancelados não podem ter seu estado de produção alterado.';
  end if;

  target_tab_id := target_item.table_tab_id;
  target_visit_id := target_item.table_visit_id;
  target_table_id := target_item.restaurant_table_id;

  select *
  into target_visit
  from public.table_visits
  where id = target_visit_id
  for share;

  if not found or target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Atendimento da mesa não está mais aberto.';
  end if;

  select *
  into target_tab
  from public.table_tabs
  where id = target_tab_id
  for share;

  if not found or target_tab.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Comanda não está mais aberta.';
  end if;

  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id
  for update;

  if target_item.production_status = p_target_status then
    return target_item;
  end if;

  -- Máquina de estados
  if target_item.production_status = 'pending' and p_target_status = 'preparing' then
    update public.table_tab_items
    set
      production_status = 'preparing',
      prep_started_at = coalesce(prep_started_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'preparing' and p_target_status = 'ready' then
    update public.table_tab_items
    set
      production_status = 'ready',
      prep_ready_at = coalesce(prep_ready_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;

    -- Obter identificação da mesa
    select table_number
    into v_table_number
    from public.restaurant_tables
    where id = target_item.restaurant_table_id;

    -- Gerar alerta automático em tempo real para equipe/garçom
    insert into public.restaurant_alerts (
      restaurant_id,
      type,
      title,
      message,
      reference_id,
      is_read
    ) values (
      target_restaurant_id,
      'dish_ready',
      'Prato pronto para entrega — Mesa ' || coalesce(v_table_number::text, 'Balcão'),
      coalesce(target_item.product_name, 'Item') || ' está pronto na cozinha e aguarda entrega.',
      target_item.id,
      false
    );
  elsif target_item.production_status = 'ready' and p_target_status = 'delivered' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'pending' and p_target_status = 'delivered' and target_item.preparation_station = 'none' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_started_at = coalesce(prep_started_at, timezone('utc', now())),
      prep_ready_at = coalesce(prep_ready_at, timezone('utc', now())),
      prep_delivered_at = coalesce(prep_delivered_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  else
    raise exception using
      errcode = '22023',
      message = format('Transição de produção inválida: de %s para %s.', target_item.production_status, p_target_status);
  end if;

  return target_item;
end;
$$;

revoke all privileges on function public.update_tab_item_production_status(text, uuid, text) from public, anon, authenticated;
grant execute on function public.update_tab_item_production_status(text, uuid, text) to authenticated;
