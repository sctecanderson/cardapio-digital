begin;

create function public.attend_waiter_request(
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
  target_table_id uuid;
  target_request public.service_requests%rowtype;
  target_visit public.table_visits%rowtype;
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
      message = 'Informe o chamado que deseja atender.';
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

  select member.id
  into target_member_id
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

  -- Serializar as operações da mesa.
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
      message = 'Esta ação atende somente chamadas de garçom.';
  end if;

  if target_request.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Este chamado foi cancelado. Atualize a fila.';
  end if;

  -- Repetir uma ação já concluída pelo mesmo funcionário
  -- não abre outro atendimento.
  if target_request.status = 'attended' then
    if target_request.resolved_by_member_id
      is distinct from target_member_id
    then
      raise exception using
        errcode = '42501',
        message = 'Este chamado já foi atendido por outro funcionário.';
    end if;

    return target_request;
  end if;

  -- Uma chamada vinculada a um atendimento antigo
  -- não pode ser transferida para uma nova ocupação.
  if target_request.table_visit_id is not null then
    select visit.*
    into target_visit
    from public.table_visits as visit
    where visit.id = target_request.table_visit_id
      and visit.restaurant_id = target_restaurant_id
      and visit.restaurant_table_id = target_table_id
    for update;

    if not found then
      raise exception using
        errcode = '22023',
        message = 'Atendimento vinculado ao chamado não encontrado.';
    end if;

    if target_visit.status <> 'open' then
      raise exception using
        errcode = '22023',
        message = 'O atendimento deste chamado já foi encerrado.';
    end if;
  end if;

  -- A função existente valida a disponibilidade da mesa
  -- e impede assumir um atendimento de outro funcionário.
  select visit.*
  into target_visit
  from public.open_table_visit(
    p_restaurant_slug,
    (
      select restaurant_table.table_number::integer
      from public.restaurant_tables as restaurant_table
      where restaurant_table.id = target_table_id
    )
  ) as visit;

  update public.service_requests
  set
    table_visit_id = target_visit.id,
    status = 'attended',
    resolved_at = greatest(clock_timestamp(), created_at),
    resolved_by_member_id = target_member_id
  where id = target_request.id
  returning * into target_request;

  return target_request;
end;
$$;

revoke all privileges
  on function public.attend_waiter_request(text, uuid)
  from public, anon, authenticated;

grant execute
  on function public.attend_waiter_request(text, uuid)
  to authenticated;

commit;
