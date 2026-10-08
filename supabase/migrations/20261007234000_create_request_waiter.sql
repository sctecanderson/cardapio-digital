begin;

create function public.request_waiter(
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
  target_visit_id uuid;
  target_session public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  rate_limit public.guest_service_request_limits%rowtype;
  checked_at timestamptz;
  retry_after_seconds integer;
  request_result text;
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
      message = 'Utilize uma sessão de cliente para chamar o garçom.';
  end if;

  if p_table_number is null
    or p_table_number < 1
    or p_table_number > 999
  then
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

  -- Serializar as operações desta mesa.
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

  insert into public.guest_service_request_limits (user_id)
  values (current_user_id)
  on conflict (user_id) do nothing;

  select limiter.*
  into rate_limit
  from public.guest_service_request_limits as limiter
  where limiter.user_id = current_user_id
  for update;

  checked_at := clock_timestamp();

  if rate_limit.window_started_at + interval '1 minute'
    <= checked_at
  then
    update public.guest_service_request_limits
    set
      window_started_at = checked_at,
      attempts = 0
    where user_id = current_user_id
    returning * into rate_limit;
  end if;

  if rate_limit.attempts >= 5 then
    retry_after_seconds := greatest(
      1,
      ceil(
        extract(epoch from (
          rate_limit.window_started_at
          + interval '1 minute'
          - checked_at
        ))
      )::integer
    );

    return jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', retry_after_seconds
    );
  end if;

  update public.guest_service_request_limits
  set attempts = attempts + 1
  where user_id = current_user_id;

  -- Criar ou recuperar a sessão do próprio cliente.
  -- Esta operação não gera código nem confirma presença.
  target_session := public.start_guest_session(
    p_restaurant_slug,
    p_table_number
  );

  -- A chamada inicial pode existir sem atendimento aberto.
  select visit.id
  into target_visit_id
  from public.table_visits as visit
  where visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id
    and visit.status = 'open'
  for update;

  -- Reutilizar o chamado pendente da mesa, se existir.
  select request.*
  into target_request
  from public.service_requests as request
  where request.restaurant_id = target_restaurant_id
    and request.restaurant_table_id = target_table_id
    and request.request_type = 'waiter'
    and request.status = 'pending'
  for update;

  if found then
    request_result := 'existing';

    -- Vincular a chamada inicial ao atendimento,
    -- caso ele tenha sido aberto posteriormente.
    if target_request.table_visit_id is null
      and target_visit_id is not null
    then
      update public.service_requests
      set table_visit_id = target_visit_id
      where id = target_request.id
      returning * into target_request;
    end if;
  else
    insert into public.service_requests (
      restaurant_id,
      restaurant_table_id,
      table_visit_id,
      request_type,
      created_at
    )
    values (
      target_restaurant_id,
      target_table_id,
      target_visit_id,
      'waiter',
      clock_timestamp()
    )
    returning * into target_request;

    request_result := 'created';
  end if;

  -- Cada cliente acompanha o chamado por seu próprio vínculo.
  insert into public.service_request_guests (
    service_request_id,
    guest_session_id,
    restaurant_id,
    restaurant_table_id
  )
  values (
    target_request.id,
    target_session.id,
    target_restaurant_id,
    target_table_id
  )
  on conflict (service_request_id, guest_session_id)
  do nothing;

  return jsonb_build_object(
    'status', request_result,
    'guest_session_id', target_session.id,
    'request', to_jsonb(target_request)
  );
end;
$$;

revoke all privileges
  on function public.request_waiter(text, integer)
  from public, anon, authenticated;

grant execute
  on function public.request_waiter(text, integer)
  to authenticated;

commit;