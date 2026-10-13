begin;

create function public.get_waiter_request_state(
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
  -- Contas da equipe não recebem o estado de um cliente.
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

  -- Reutilizar a consulta que valida usuário, restaurante,
  -- mesa, validade da sessão e atendimento vinculado.
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

commit;