-- ============================================================================
-- BLOCO 11.6: EXCLUSÃO SEGURA DE MESAS (BOTÃO X), RECÁLCULO DE COTA
-- E RESTRIÇÃO COMERCIAL DO KDS POR PLANO SAAS
-- ============================================================================

begin;

-- ============================================================================
-- 1. ADICIONAR COLUNA deleted_at EM public.restaurant_tables
-- ============================================================================
alter table public.restaurant_tables
  add column if not exists deleted_at timestamptz default null;

-- Ajustar unicidade para considerar apenas mesas não excluídas
alter table public.restaurant_tables
  drop constraint if exists restaurant_tables_unique_number;

drop index if exists public.restaurant_tables_unique_number;

create unique index if not exists restaurant_tables_unique_number
  on public.restaurant_tables (restaurant_id, table_number)
  where deleted_at is null;

-- Atualizar view dining_tables para ignorar mesas excluídas
create or replace view public.dining_tables as
  select * from public.restaurant_tables
  where deleted_at is null;

-- ============================================================================
-- 2. ATUALIZAR sync_restaurant_tables_to_plan_limit PARA IGNORAR EXCLUÍDAS
-- ============================================================================
create or replace function public.sync_restaurant_tables_to_plan_limit(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_tables integer;
  v_allowed_table_ids uuid[];
  v_activated_count integer := 0;
  v_deactivated_count integer := 0;
begin
  select r.max_tables
  into v_max_tables
  from public.restaurants as r
  where r.id = p_restaurant_id;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  -- Identificar IDs das mesas que devem ficar ativas respeitando a prioridade:
  -- 1) Mesas com atendimento/comanda aberta prioritárias
  -- 2) Menor table_number
  -- Apenas mesas não excluídas (deleted_at is null)
  select array_agg(sub.id)
  into v_allowed_table_ids
  from (
    select
      t.id,
      case
        when exists (
          select 1 from public.table_visits as v
          where v.restaurant_table_id = t.id
            and v.status = 'open'
        ) then 0
        else 1
      end as open_priority,
      t.table_number
    from public.restaurant_tables as t
    where t.restaurant_id = p_restaurant_id
      and t.deleted_at is null
    order by open_priority asc, t.table_number asc
    limit v_max_tables
  ) as sub;

  if v_allowed_table_ids is null then
    v_allowed_table_ids := array[]::uuid[];
  end if;

  -- Desativar verificação da trigger durante a sincronização atômica
  perform set_config('app.skip_plan_limit_check', 'true', true);

  -- 1. Ativar mesas dentro do limite permitido que estavam inativas
  with activated as (
    update public.restaurant_tables
    set is_active = true,
        active = true
    where restaurant_id = p_restaurant_id
      and deleted_at is null
      and id = any(v_allowed_table_ids)
      and (is_active = false or active = false)
    returning 1
  )
  select count(*) into v_activated_count from activated;

  -- 2. Desativar mesas excedentes que não possuem atendimento aberto
  with deactivated as (
    update public.restaurant_tables
    set is_active = false,
        active = false
    where restaurant_id = p_restaurant_id
      and deleted_at is null
      and not (id = any(v_allowed_table_ids))
      and (is_active = true or active = true)
      and not exists (
        select 1 from public.table_visits as v
        where v.restaurant_table_id = restaurant_tables.id
          and v.status = 'open'
      )
    returning 1
  )
  select count(*) into v_deactivated_count from deactivated;

  -- Restaurar verificação da trigger
  perform set_config('app.skip_plan_limit_check', 'false', true);

  return jsonb_build_object(
    'success', true,
    'maxTables', v_max_tables,
    'activatedCount', v_activated_count,
    'deactivatedCount', v_deactivated_count
  );
end;
$$;

revoke all on function public.sync_restaurant_tables_to_plan_limit(uuid) from public, anon;
grant execute on function public.sync_restaurant_tables_to_plan_limit(uuid) to authenticated;

-- ============================================================================
-- 3. ATUALIZAR TRIGGER enforce_restaurant_tables_plan_limit
-- ============================================================================
create or replace function public.enforce_restaurant_tables_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_tables integer;
  v_active_count integer;
  v_becoming_active boolean := false;
begin
  if current_setting('app.skip_plan_limit_check', true) = 'true' then
    return NEW;
  end if;

  -- Ignorar se a mesa estiver excluída
  if NEW.deleted_at is not null then
    NEW.active := false;
    NEW.is_active := false;
    return NEW;
  end if;

  -- Harmonizar active e is_active
  if TG_OP = 'UPDATE' then
    if NEW.is_active is distinct from OLD.is_active then
      NEW.active := NEW.is_active;
    elsif NEW.active is distinct from OLD.active then
      NEW.is_active := NEW.active;
    end if;
    v_becoming_active := (coalesce(NEW.is_active, NEW.active, false) = true and coalesce(OLD.is_active, OLD.active, false) = false);
  else -- INSERT
    if NEW.is_active is null and NEW.active is not null then
      NEW.is_active := NEW.active;
    elsif NEW.active is null and NEW.is_active is not null then
      NEW.active := NEW.is_active;
    elsif NEW.is_active is null and NEW.active is null then
      NEW.is_active := true;
      NEW.active := true;
    else
      NEW.active := NEW.is_active;
    end if;
    v_becoming_active := (coalesce(NEW.is_active, NEW.active, false) = true);
  end if;

  if not v_becoming_active then
    return NEW;
  end if;

  -- Obter cota máxima de mesas do plano do restaurante
  select r.max_tables
  into v_max_tables
  from public.restaurants as r
  where r.id = NEW.restaurant_id;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  -- Contar quantas mesas ativas e não excluídas já existem no restaurante
  select count(*)
  into v_active_count
  from public.restaurant_tables as t
  where t.restaurant_id = NEW.restaurant_id
    and t.deleted_at is null
    and (t.is_active = true or t.active = true)
    and (TG_OP = 'INSERT' or t.id <> NEW.id);

  if v_active_count >= v_max_tables then
    raise exception 'Limite de % mesas ativas do plano atual atingido. Faça upgrade do plano para liberar mais mesas.', v_max_tables
      using errcode = 'P0001';
  end if;

  return NEW;
end;
$$;

-- ============================================================================
-- 4. ATUALIZAR get_admin_tables PARA FILTRAR MESAS EXCLUÍDAS
-- ============================================================================
create or replace function public.get_admin_tables(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  v_max_tables integer;
  v_active_count integer;
begin
  rid := public.require_catalog_admin(p_slug);

  select max_tables into v_max_tables
  from public.restaurants
  where id = rid;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  select count(*) into v_active_count
  from public.restaurant_tables
  where restaurant_id = rid
    and deleted_at is null
    and (active = true or is_active = true);

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'tableNumber', t.table_number,
          'label', t.label,
          'active', (t.active and t.is_active),
          'isActive', (t.active and t.is_active),
          'is_active', (t.active and t.is_active),
          'isLockedByPlan', (
            (not (t.active and t.is_active)) and (
              t.table_number > v_max_tables or v_active_count >= v_max_tables
            )
          ),
          'revision', t.revision,
          'visitId', v.id,
          'tabCount', (select count(*) from public.table_tabs tab where tab.table_visit_id = v.id and tab.status = 'open'),
          'totalInCents', coalesce((select sum(i.line_total_in_cents) from public.table_tab_items i where i.table_visit_id = v.id and i.status = 'active'), 0),
          'billPending', exists(select 1 from public.service_requests sr where sr.table_visit_id = v.id and sr.request_type = 'bill' and sr.status = 'pending')
        )
        order by t.table_number
      )
      from public.restaurant_tables as t
      left join public.table_visits as v on v.restaurant_table_id = t.id and v.status = 'open'
      where t.restaurant_id = rid
        and t.deleted_at is null
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.get_admin_tables(text) from public, anon, authenticated;
grant execute on function public.get_admin_tables(text) to authenticated;

-- ============================================================================
-- 5. RPC public.delete_restaurant_table: EXCLUSÃO SEGURA E REORGANIZAÇÃO
-- ============================================================================
create or replace function public.delete_restaurant_table(
  p_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  v_table public.restaurant_tables%rowtype;
begin
  rid := public.require_catalog_admin(p_slug);

  if p_table_number is null or p_table_number < 1 then
    raise exception 'Número de mesa inválido.' using errcode = '22023';
  end if;

  select *
  into v_table
  from public.restaurant_tables
  where restaurant_id = rid
    and table_number = p_table_number
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Mesa % não encontrada.', p_table_number using errcode = '22023';
  end if;

  -- 1. Se houver atendimento aberto, proibir exclusão
  if exists (
    select 1 from public.table_visits
    where restaurant_table_id = v_table.id
      and status = 'open'
  ) then
    raise exception 'Mesa com atendimento ativo. Feche a comanda antes de excluir.'
      using errcode = 'P0001';
  end if;

  -- 2. Exclusão segura: tenta hard delete; se violar integridade referencial com
  -- atendimentos ou sessões históricas já encerradas, aplica arquivamento (soft-delete).
  begin
    delete from public.restaurant_tables where id = v_table.id;
  exception when foreign_key_violation or restrict_violation or sqlstate '23001' or sqlstate '23503' then
    update public.restaurant_tables
    set deleted_at = timezone('utc', now()),
        active = false,
        is_active = false
    where id = v_table.id;
  end;

  -- 3. Promover automaticamente a próxima mesa bloqueada pelo plano para ativa
  perform public.sync_restaurant_tables_to_plan_limit(rid);

  return jsonb_build_object(
    'success', true,
    'tableNumber', p_table_number,
    'tableId', v_table.id
  );
end;
$$;

revoke all on function public.delete_restaurant_table(text, integer) from public, anon, authenticated;
grant execute on function public.delete_restaurant_table(text, integer) to authenticated;

-- ============================================================================
-- 6. RPC public.get_kds_active_items COM PROTEÇÃO DE PLANO (PRO / PREMIUM)
-- ============================================================================
create or replace function public.get_kds_active_items(p_restaurant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest record;
begin
  select id, subscription_plan
  into v_rest
  from public.restaurants
  where slug = p_restaurant_slug
    and active = true;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  if v_rest.subscription_plan = 'basic' then
    raise exception 'O módulo KDS é exclusivo para planos Pro e Premium. Faça upgrade para acessar a esteira de produção.'
      using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'table_tab_id', i.table_tab_id,
          'table_visit_id', i.table_visit_id,
          'restaurant_table_id', i.restaurant_table_id,
          'table_number', t.table_number,
          'table_name', coalesce(t.label, 'Mesa ' || lpad(t.table_number::text, 2, '0')),
          'product_name', i.product_name,
          'quantity', i.quantity,
          'preparation_station', coalesce(i.preparation_station, 'none'),
          'production_status', coalesce(i.production_status, 'pending'),
          'created_at', i.created_at,
          'prep_started_at', i.prep_started_at,
          'prep_ready_at', i.prep_ready_at,
          'prep_delivered_at', i.prep_delivered_at
        )
        order by i.created_at asc
      )
      from public.table_tab_items as i
      join public.table_tabs as tab on tab.id = i.table_tab_id and tab.status = 'open'
      join public.table_visits as v on v.id = i.table_visit_id and v.status = 'open'
      join public.restaurant_tables as t on t.id = i.restaurant_table_id and t.deleted_at is null
      where i.restaurant_id = v_rest.id
        and i.status = 'active'
        and i.production_status in ('pending', 'preparing', 'ready')
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.get_kds_active_items(text) from public, anon, authenticated;
grant execute on function public.get_kds_active_items(text) to authenticated;

-- ============================================================================
-- 7. ATUALIZAR update_tab_item_production_status COM TRAVA DE PLANO
-- ============================================================================
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
  item_restaurant_id uuid;
  target_table_id uuid;
  target_visit_id uuid;
  target_tab_id uuid;
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

notify pgrst, 'reload schema';

commit;
