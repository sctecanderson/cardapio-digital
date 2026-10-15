-- ============================================================================
-- BLOCO 16: ENDURECIMENTO DE SEGURANÇA E CORREÇÃO DE VULNERABILIDADES (RLS & RPCs)
-- ============================================================================

begin;

-- ============================================================================
-- 1. HARDENING DE RLS: restaurant_tables_read_public
-- Garante que visitantes e clientes nunca consigam selecionar mesas de
-- restaurantes suspensos ou inativos diretamente via API pública.
-- ============================================================================
drop policy if exists restaurant_tables_read_public on public.restaurant_tables;

create policy restaurant_tables_read_public
  on public.restaurant_tables
  for select
  to anon, authenticated
  using (
    (coalesce(is_active, active, true) = true)
    and deleted_at is null
    and exists (
      select 1
      from public.restaurants as r
      where r.id = restaurant_tables.restaurant_id
        and r.active = true
    )
  );

-- ============================================================================
-- 2. HARDENING DE AUTORIZAÇÃO: sync_restaurant_tables_to_plan_limit
-- Restringe a execução exclusivamente a administradores da plataforma
-- ou administradores ativos do próprio restaurante alvo.
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
  -- Trava de segurança: apenas Platform Admin ou Admin do Restaurante
  if not (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = (select auth.uid())
        and m.active = true
        and m.role = 'admin'
    )
  ) then
    raise exception 'Acesso não autorizado para sincronizar cotas de mesas.' using errcode = '42501';
  end if;

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
-- 3. HARDENING DE AUTORIZAÇÃO: get_kds_active_items
-- Garante que apenas funcionários ativos do restaurante (admin/garçom)
-- ou administradores da plataforma possam visualizar itens da esteira de produção.
-- ============================================================================
create or replace function public.get_kds_active_items(p_restaurant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest record;
  current_user_id uuid;
begin
  current_user_id := auth.uid();
  if current_user_id is null
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe para visualizar o KDS.';
  end if;

  select id, subscription_plan
  into v_rest
  from public.restaurants
  where slug = p_restaurant_slug
    and active = true;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  -- Validação de plano comercial para o KDS
  if v_rest.subscription_plan = 'basic' then
    raise exception 'O módulo KDS é exclusivo para planos Pro e Premium. Faça upgrade para acessar a esteira de produção.'
      using errcode = '42501';
  end if;

  -- Trava de segurança: apenas membros da equipe ou platform admin
  if not (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      where member.restaurant_id = v_rest.id
        and member.user_id = current_user_id
        and member.active = true
        and member.role in ('admin', 'waiter')
    )
  ) then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso aos pedidos deste restaurante.';
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

revoke all on function public.get_kds_active_items(text) from public, anon;
grant execute on function public.get_kds_active_items(text) to authenticated;

commit;
