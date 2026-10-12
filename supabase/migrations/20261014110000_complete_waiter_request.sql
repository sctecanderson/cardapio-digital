begin;

-- 1. Atualizar constraint de status da tabela service_requests para permitir 'completed'
alter table public.service_requests
  drop constraint if exists service_requests_valid_status;

alter table public.service_requests
  add constraint service_requests_valid_status
    check (status in ('pending', 'attended', 'completed', 'cancelled'));

-- 2. Atualizar constraint de validação da resolução para permitir 'completed'
alter table public.service_requests
  drop constraint if exists service_requests_valid_resolution;

alter table public.service_requests
  add constraint service_requests_valid_resolution
    check (
      (
        status = 'pending'
        and resolved_at is null
        and resolved_by_member_id is null
      )
      or
      (
        status in ('attended', 'completed')
        and resolved_at is not null
        and resolved_by_member_id is not null
        and resolved_at >= created_at
      )
      or
      (
        status = 'cancelled'
        and resolved_at is not null
        and resolved_at >= created_at
      )
    );

-- 3. Nova RPC: complete_waiter_request
-- Permite que o funcionário responsável (ou um administrador) encerre o chamado de garçom em atendimento.
-- Garante que outro garçom não possa concluir um atendimento alheio.
-- Preserva resolved_by_member_id original ou registra a conclusão pelo administrador autorizado.
create or replace function public.complete_waiter_request(
  p_restaurant_slug text,
  p_service_request_id uuid
)
returns public.service_requests
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
  target_request public.service_requests%rowtype;
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

  if p_service_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe o chamado que deseja concluir.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if target_member_id is null then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select request.restaurant_table_id
  into target_table_id
  from public.service_requests as request
  where request.id = p_service_request_id
    and request.restaurant_id = target_restaurant_id;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Chamado não encontrado neste restaurante.';
  end if;

  -- Serializar operações da mesa
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

  select request.*
  into target_request
  from public.service_requests as request
  where request.id = p_service_request_id
    and request.restaurant_id = target_restaurant_id
    and request.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Chamado não encontrado.';
  end if;

  if target_request.request_type <> 'waiter' then
    raise exception using
      errcode = '22023',
      message = 'Esta ação conclui somente chamadas de garçom.';
  end if;

  if target_request.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Este chamado foi cancelado.';
  end if;

  -- Idempotência: se já estiver concluído, retorna o registro
  if target_request.status = 'completed' then
    return target_request;
  end if;

  if target_request.status <> 'attended' then
    raise exception using
      errcode = '22023',
      message = 'Apenas chamados em atendimento podem ser concluídos.';
  end if;

  -- REGRA DE AUTORIZAÇÃO: O responsável pelo atendimento pode concluir.
  -- Administrador ativo pode realizar conclusão excepcional.
  -- Outro garçom não pode concluir atendimento alheio.
  if target_request.resolved_by_member_id is not null
    and target_request.resolved_by_member_id <> target_member_id
    and target_member_role <> 'admin'
  then
    raise exception using
      errcode = '42501',
      message = 'Somente o funcionário responsável ou um administrador pode concluir este atendimento.';
  end if;

  update public.service_requests
  set
    status = 'completed',
    resolved_at = greatest(clock_timestamp(), created_at),
    resolved_by_member_id = coalesce(target_request.resolved_by_member_id, target_member_id)
  where id = target_request.id
  returning * into target_request;

  return target_request;
end;
$$;

revoke all privileges
  on function public.complete_waiter_request(text, uuid)
  from public, anon, authenticated;

grant execute
  on function public.complete_waiter_request(text, uuid)
  to authenticated;

-- 4. Nova RPC: dismiss_table_service_requests (Encerramento excepcional controlado de chamados da mesa)
-- Permite que um administrador ou funcionário responsável encerre chamados ativos (pending ou attended) de uma mesa específica,
-- registrando o encerramento como 'cancelled' de maneira rastreável e idempotente.
create or replace function public.dismiss_table_service_requests(
  p_restaurant_slug text,
  p_table_number integer
)
returns integer
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
  dismissed_count integer := 0;
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

  if p_table_number is null or p_table_number < 1 or p_table_number > 999 then
    raise exception using
      errcode = '22023',
      message = 'Informe um número de mesa válido.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if target_member_id is null then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select restaurant_table.id
  into target_table_id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
  for update;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Mesa não encontrada neste restaurante.';
  end if;

  -- Se for garçom comum (não admin), só pode encerrar chamados de mesas sob seu atendimento ou não vinculadas
  if target_member_role <> 'admin' then
    if exists (
      select 1
      from public.table_visits as visit
      where visit.restaurant_id = target_restaurant_id
        and visit.restaurant_table_id = target_table_id
        and visit.status = 'open'
        and visit.assigned_member_id is distinct from target_member_id
    ) then
      raise exception using
        errcode = '42501',
        message = 'Apenas o funcionário responsável pela mesa ou um administrador pode encerrar os chamados desta mesa.';
    end if;
  end if;

  -- Atualizar todos os chamados ativos (pending ou attended) desta mesa para cancelled
  with updated as (
    update public.service_requests
    set
      status = 'cancelled',
      resolved_at = greatest(clock_timestamp(), created_at),
      resolved_by_member_id = coalesce(resolved_by_member_id, target_member_id)
    where restaurant_id = target_restaurant_id
      and restaurant_table_id = target_table_id
      and status in ('pending', 'attended')
    returning id
  )
  select count(*)::integer into dismissed_count from updated;

  return dismissed_count;
end;
$$;

revoke all privileges
  on function public.dismiss_table_service_requests(text, integer)
  from public, anon, authenticated;

grant execute
  on function public.dismiss_table_service_requests(text, integer)
  to authenticated;

-- 5. Atualizar close_table_visit para cancelar TODOS os chamados ativos (pending E attended) ao fechar a mesa
-- Preserva a regra rígida de exigir que todas as comandas estejam fechadas!
create or replace function public.close_table_visit(
  p_restaurant_slug text,
  p_table_visit_id uuid
)
returns public.table_visits
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
  target_visit public.table_visits%rowtype;
  checked_at timestamptz;
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

  if p_table_visit_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe o atendimento que deseja encerrar.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if target_member_id is null then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select visit.restaurant_table_id
  into target_table_id
  from public.table_visits as visit
  where visit.id = p_table_visit_id
    and visit.restaurant_id = target_restaurant_id;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Atendimento não encontrado neste restaurante.';
  end if;

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

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.id = p_table_visit_id
    and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Atendimento não encontrado.';
  end if;

  -- O responsável ou um admin podem encerrar o atendimento
  if target_visit.assigned_member_id is distinct from target_member_id
    and target_member_role <> 'admin'
  then
    raise exception using
      errcode = '42501',
      message = 'Somente o responsável ou um administrador pode encerrar este atendimento.';
  end if;

  -- Uma chamada repetida não modifica a próxima ocupação.
  if target_visit.status = 'closed' then
    return target_visit;
  end if;

  -- REGRA RÍGIDA: Só pode encerrar a mesa se TODAS as comandas estiverem fechadas!
  if exists (
    select 1
    from public.table_tabs as tab
    where tab.table_visit_id = target_visit.id
      and tab.status = 'open'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.';
  end if;

  checked_at := greatest(
    clock_timestamp(),
    target_visit.opened_at
  );

  -- 1. Revogar as sessões de clientes ativas ou pendentes desta mesa
  update public.guest_sessions
  set status = 'revoked'
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status in ('pending', 'active');

  -- 2. Cancelar todos os chamados e pedidos de conta ainda abertos (pending e attended) desta mesa
  update public.service_requests
  set
    status = 'cancelled',
    resolved_at = greatest(checked_at, created_at),
    resolved_by_member_id = coalesce(resolved_by_member_id, target_member_id)
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status in ('pending', 'attended');

  -- 3. Encerrar o atendimento da mesa
  update public.table_visits
  set
    status = 'closed',
    closed_at = checked_at
  where id = target_visit.id
  returning * into target_visit;

  return target_visit;
end;
$$;

revoke all privileges
  on function public.close_table_visit(text, uuid)
  from public, anon, authenticated;

grant execute
  on function public.close_table_visit(text, uuid)
  to authenticated;

-- 6. Atualizar get_waiter_request_state para buscar apenas chamados ativos ('pending' ou 'attended')
create or replace function public.get_waiter_request_state(
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
  target_session public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
begin
  if auth.uid() is null
    or not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    return jsonb_build_object(
      'guest_session_id', null,
      'request', null
    );
  end if;

  target_session := public.get_guest_session(
    p_restaurant_slug,
    p_table_number
  );

  if target_session.id is null then
    return jsonb_build_object(
      'guest_session_id', null,
      'request', null
    );
  end if;

  select request.*
  into target_request
  from public.service_requests as request
  join public.service_request_guests as link
    on link.service_request_id = request.id
  where link.guest_session_id = target_session.id
    and request.restaurant_id = target_session.restaurant_id
    and request.restaurant_table_id =
      target_session.restaurant_table_id
    and request.request_type = 'waiter'
    and request.status in ('pending', 'attended')
  order by request.created_at desc, request.id desc
  limit 1;

  return jsonb_build_object(
    'guest_session_id', target_session.id,
    'request',
      case
        when target_request.id is null then null
        else to_jsonb(target_request)
      end
  );
end;
$$;

revoke all privileges
  on function public.get_waiter_request_state(text, integer)
  from public, anon, authenticated;

grant execute
  on function public.get_waiter_request_state(text, integer)
  to authenticated;

notify pgrst, 'reload schema';

commit;
