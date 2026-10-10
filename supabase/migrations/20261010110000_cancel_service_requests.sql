begin;

-- ============================================================================
-- 1. RPC: cancel_waiter_request
-- Permite que um cliente anônimo cancele sua solicitação de garçom.
-- Se houver outros clientes na mesma mesa vinculados a este chamado pendente,
-- apenas o vínculo do cliente solicitante é removido.
-- O chamado da mesa só é marcado como 'cancelled' se não restar nenhum cliente vinculado.
-- Se o chamado já tiver sido atendido pela equipe, a operação é rejeitada.
-- ============================================================================
create function public.cancel_waiter_request(
  p_restaurant_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_table_id uuid;
  target_session public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  linked_guest_row public.service_request_guests%rowtype;
  remaining_guests_count integer;
  cancellation_mode text;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Utilize uma sessão de cliente para cancelar o chamado.';
  end if;

  if p_table_number is null
    or p_table_number < 1
    or p_table_number > 999
  then
    raise exception using
      errcode = '22023',
      message = 'Informe um número de mesa válido.';
  end if;

  -- 1. Ordem de bloqueio: Restaurante (FOR SHARE)
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

  -- 2. Ordem de bloqueio: Mesa (FOR UPDATE)
  select restaurant_table.id
  into target_table_id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
    and restaurant_table.active = true
  for update;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Mesa inexistente ou indisponível.';
  end if;

  -- 3. Identificar e validar a sessão do cliente chamador
  select guest.*
  into target_session
  from public.guest_sessions as guest
  where guest.restaurant_id = target_restaurant_id
    and guest.restaurant_table_id = target_table_id
    and guest.user_id = current_user_id
    and guest.status in ('pending', 'active')
    and guest.expires_at > clock_timestamp()
  order by guest.created_at desc
  limit 1
  for update;

  if target_session.id is null then
    raise exception using
      errcode = '42501',
      message = 'Você não possui uma sessão ativa nesta mesa.';
  end if;

  -- 4. Ordem de bloqueio: Chamado pendente da mesa (FOR UPDATE)
  select request.*
  into target_request
  from public.service_requests as request
  where request.restaurant_id = target_restaurant_id
    and request.restaurant_table_id = target_table_id
    and request.request_type = 'waiter'
    and request.status = 'pending'
  for update;

  if not found then
    -- Verificar se já foi atendido recentemente para fornecer mensagem precisa
    select request.*
    into target_request
    from public.service_requests as request
    where request.restaurant_id = target_restaurant_id
      and request.restaurant_table_id = target_table_id
      and request.request_type = 'waiter'
    order by request.created_at desc
    limit 1;

    if target_request.status = 'attended' then
      raise exception using
        errcode = '22023',
        message = 'Este chamado já foi atendido pela equipe e não pode ser cancelado.';
    end if;

    raise exception using
      errcode = '22023',
      message = 'Não há solicitação de garçom pendente para esta mesa.';
  end if;

  -- 5. Ordem de bloqueio: Vínculo do cliente com este chamado (FOR UPDATE)
  select link.*
  into linked_guest_row
  from public.service_request_guests as link
  where link.service_request_id = target_request.id
    and link.guest_session_id = target_session.id
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Você não possui solicitação vinculada a este chamado.';
  end if;

  -- Remover o vínculo deste cliente
  delete from public.service_request_guests
  where service_request_id = target_request.id
    and guest_session_id = target_session.id;

  -- Conferir se ainda restam outros clientes ativos da mesa vinculados ao mesmo chamado
  select count(*)::integer
  into remaining_guests_count
  from public.service_request_guests
  where service_request_id = target_request.id;

  if remaining_guests_count > 0 then
    -- Outros clientes da mesa ainda aguardam atendimento: chamado permanece pendente
    cancellation_mode := 'unlinked';
  else
    -- Nenhum cliente restante: cancela atomicamente o chamado global da mesa
    update public.service_requests
    set
      status = 'cancelled',
      resolved_at = clock_timestamp()
    where id = target_request.id
    returning * into target_request;

    cancellation_mode := 'cancelled';
  end if;

  return jsonb_build_object(
    'status', cancellation_mode,
    'request_id', target_request.id,
    'remaining_guests', remaining_guests_count
  );
end;
$$;

-- ============================================================================
-- 2. RPC: cancel_table_tab_bill
-- Permite que um cliente vinculado a uma comanda cancele a solicitação de conta pendente.
-- Cancela a solicitação de conta pendente daquela comanda específica.
-- Rejeita se a comanda já tiver sido atendida ou fechada.
-- ============================================================================
create function public.cancel_table_tab_bill(
  p_restaurant_slug text,
  p_table_tab_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_table_id uuid;
  target_visit_id uuid;
  target_tab public.table_tabs%rowtype;
  target_guest public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Utilize seu acesso de cliente para cancelar o pedido de conta.';
  end if;

  if p_table_tab_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe a comanda.';
  end if;

  -- 1. Restaurante (FOR SHARE)
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

  -- 2. Identificar comanda e mesa
  select tab.restaurant_table_id, tab.table_visit_id
  into target_table_id, target_visit_id
  from public.table_tabs as tab
  where tab.id = p_table_tab_id
    and tab.restaurant_id = target_restaurant_id;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Comanda indisponível para este acesso.';
  end if;

  -- 3. Mesa (FOR UPDATE)
  perform restaurant_table.id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id
    and restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.active = true
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Mesa indisponível.';
  end if;

  -- 4. Comanda (FOR UPDATE)
  select tab.*
  into target_tab
  from public.table_tabs as tab
  where tab.id = p_table_tab_id
    and tab.table_visit_id = target_visit_id
    and tab.restaurant_id = target_restaurant_id
    and tab.restaurant_table_id = target_table_id
  for update;

  if not found or target_tab.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Esta comanda não está aberta.';
  end if;

  -- 5. Validar que o cliente autor possui presença ativa vinculada a esta comanda
  select guest.*
  into target_guest
  from public.guest_sessions as guest
  join public.table_tab_guests as linked_guest
    on linked_guest.guest_session_id = guest.id
    and linked_guest.table_visit_id = guest.table_visit_id
    and linked_guest.restaurant_id = guest.restaurant_id
    and linked_guest.restaurant_table_id = guest.restaurant_table_id
  where linked_guest.table_tab_id = target_tab.id
    and guest.restaurant_id = target_restaurant_id
    and guest.restaurant_table_id = target_table_id
    and guest.table_visit_id = target_visit_id
    and guest.user_id = current_user_id
    and guest.status = 'active'
    and guest.expires_at > clock_timestamp()
  for update of guest, linked_guest;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Sua presença precisa estar confirmada e vinculada a esta comanda.';
  end if;

  -- 6. Chamado de conta pendente desta comanda (FOR UPDATE)
  select request.*
  into target_request
  from public.service_requests as request
  where request.table_tab_id = target_tab.id
    and request.restaurant_id = target_restaurant_id
    and request.request_type = 'bill'
    and request.status = 'pending'
  for update;

  if not found then
    -- Se já foi atendida recentemente pela equipe:
    select request.*
    into target_request
    from public.service_requests as request
    where request.table_tab_id = target_tab.id
      and request.restaurant_id = target_restaurant_id
      and request.request_type = 'bill'
    order by request.created_at desc
    limit 1;

    if target_request.status = 'attended' then
      raise exception using
        errcode = '22023',
        message = 'A solicitação de conta já foi atendida pela equipe.';
    end if;

    raise exception using
      errcode = '22023',
      message = 'Não há solicitação de conta pendente para esta comanda.';
  end if;

  -- Cancelar a solicitação
  update public.service_requests
  set
    status = 'cancelled',
    resolved_at = clock_timestamp()
  where id = target_request.id
  returning * into target_request;

  return jsonb_build_object(
    'status', 'cancelled',
    'request_id', target_request.id,
    'table_tab_id', target_tab.id
  );
end;
$$;

-- Permissões
revoke all privileges
  on function public.cancel_waiter_request(text, integer),
  public.cancel_table_tab_bill(text, uuid)
  from public, anon, authenticated;

grant execute
  on function public.cancel_waiter_request(text, integer),
  public.cancel_table_tab_bill(text, uuid)
  to authenticated;

notify pgrst, 'reload schema';

commit;
