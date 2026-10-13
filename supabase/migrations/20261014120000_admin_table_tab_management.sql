begin;

-- ============================================================================
-- AUTORIZAÇÃO EXPLÍCITA E RESTRITA: RPC public.close_table_tab
-- Permite que um administrador ativo do mesmo restaurante (ou o garçom titular)
-- encerre comandas abertas, calculando a taxa de serviço e persistindo o snapshot.
-- Isso viabiliza o encerramento administrativo da mesa sem conceder permissões
-- indevidas de criação ou modificação de consumo nas outras RPCs.
--
-- Preserva estritamente a ordem canônica de bloqueios do projeto:
-- 1. Restaurante (FOR SHARE)
-- 2. Membro da equipe (FOR SHARE)
-- 3. Mesa da visita (FOR UPDATE)
-- 4. Atendimento / Visita (FOR UPDATE)
-- 5. Comanda (FOR UPDATE)
-- ============================================================================
create or replace function public.close_table_tab(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_final_service_fee_accepted boolean default null
)
returns public.table_tabs
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_member_role text;
  target_table_id uuid;
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  restaurant_fee_pct numeric;
  calculated_subtotal integer;
  applied_fee_pct numeric;
  calculated_fee integer;
  calculated_total integer;
  final_fee_accepted boolean;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_table_tab_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe a comanda que deseja encerrar.';
  end if;

  -- 1. Restaurante ativo com bloqueio compartilhado (FOR SHARE)
  -- Protege a leitura da taxa contra alterações concorrentes durante o fechamento
  select restaurant.id, restaurant.service_fee_percent
  into target_restaurant_id, restaurant_fee_pct
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  -- 2. Membro da equipe com bloqueio compartilhado (FOR SHARE)
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

  -- Localizar comanda e visita associadas ao restaurante
  select tab.restaurant_table_id, tab.table_visit_id
  into target_table_id, target_visit_id
  from public.table_tabs as tab
  where tab.id = p_table_tab_id
    and tab.restaurant_id = target_restaurant_id;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Comanda não encontrada neste restaurante.';
  end if;

  -- 3. Serializar operações da mesa (FOR UPDATE)
  perform restaurant_table.id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id
    and restaurant_table.restaurant_id = target_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Mesa não encontrada.';
  end if;

  -- 4. Serializar atendimento (FOR UPDATE)
  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.id = target_visit_id
    and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Atendimento não encontrado.';
  end if;

  -- Regra de autorização restrita: titular do atendimento OU administrador ativo do mesmo restaurante
  if target_visit.assigned_member_id is distinct from target_member_id
    and target_member_role <> 'admin'
  then
    raise exception using
      errcode = '42501',
      message = 'Somente o responsável ou um administrador pode encerrar esta comanda.';
  end if;

  -- 5. Serializar comanda (FOR UPDATE)
  select tab.*
  into target_tab
  from public.table_tabs as tab
  where tab.id = p_table_tab_id
    and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Comanda não encontrada neste atendimento.';
  end if;

  -- Idempotência estrita: comanda já encerrada retorna o snapshot sem modificação
  if target_tab.status = 'closed' then
    return target_tab;
  end if;

  if target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Este atendimento já foi encerrado.';
  end if;

  -- 1. Calcular subtotal real no servidor (itens ativos)
  select coalesce(sum(i.line_total_in_cents), 0)::integer
  into calculated_subtotal
  from public.table_tab_items as i
  where i.table_tab_id = target_tab.id
    and i.restaurant_id = target_restaurant_id
    and i.status = 'active';

  -- 2. Decisão final da taxa de serviço
  if restaurant_fee_pct > 0 then
    if p_final_service_fee_accepted is null then
      raise exception using
        errcode = '22023',
        message = 'Informe se a taxa de serviço foi aceita pelo cliente antes de fechar a comanda.';
    end if;
    final_fee_accepted := p_final_service_fee_accepted;
    if final_fee_accepted then
      applied_fee_pct := restaurant_fee_pct;
      calculated_fee := round(calculated_subtotal * (applied_fee_pct / 100.0))::integer;
    else
      applied_fee_pct := 0;
      calculated_fee := 0;
    end if;
  else
    final_fee_accepted := false;
    applied_fee_pct := 0;
    calculated_fee := 0;
  end if;

  calculated_total := calculated_subtotal + calculated_fee;

  -- 3. Persistir snapshot contábil imutável
  -- closed_by_member_id registra com precisão quem efetuou o fechamento (garçom responsável ou administrador)
  update public.table_tabs
  set
    status = 'closed',
    closed_by_member_id = target_member_id,
    closed_at = greatest(clock_timestamp(), target_tab.created_at),
    subtotal_in_cents = calculated_subtotal,
    service_fee_percent = applied_fee_pct,
    service_fee_in_cents = calculated_fee,
    total_in_cents = calculated_total,
    service_fee_accepted = final_fee_accepted
  where id = target_tab.id
  returning * into target_tab;

  return target_tab;
end;
$$;

revoke all privileges
  on function public.close_table_tab(text, uuid, boolean)
  from public, anon, authenticated;

grant execute
  on function public.close_table_tab(text, uuid, boolean)
  to authenticated;

commit;
