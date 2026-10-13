begin;

create function public.confirm_guest_session(
  p_restaurant_slug text,
  p_table_number integer,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_table_id uuid;
  target_visit public.table_visits%rowtype;
  target_session public.guest_sessions%rowtype;
  rate_limit public.staff_confirmation_limits%rowtype;
  checked_at timestamptz;
  retry_after_seconds integer;
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

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.restaurant_table_id = target_table_id
    and visit.restaurant_id = target_restaurant_id
    and visit.status = 'open'
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Assuma a mesa antes de confirmar o cliente.';
  end if;

  if target_visit.assigned_member_id is distinct from target_member_id then
    raise exception using
      errcode = '42501',
      message = 'Somente o responsável pelo atendimento pode confirmar o cliente.';
  end if;

  insert into public.staff_confirmation_limits (member_id)
  values (target_member_id)
  on conflict (member_id) do nothing;

  select limiter.*
  into rate_limit
  from public.staff_confirmation_limits as limiter
  where limiter.member_id = target_member_id
  for update;

  checked_at := clock_timestamp();

  if rate_limit.window_started_at + interval '1 minute' <= checked_at then
    update public.staff_confirmation_limits
    set
      window_started_at = checked_at,
      attempts = 0
    where member_id = target_member_id
    returning * into rate_limit;
  end if;

  if rate_limit.attempts >= 10 then
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

  update public.staff_confirmation_limits
  set attempts = attempts + 1
  where member_id = target_member_id;

  if p_code is null or p_code !~ '^[0-9]{6}$' then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  select guest.*
  into target_session
  from public.guest_sessions as guest
  join public.guest_confirmation_codes as confirmation
    on confirmation.guest_session_id = guest.id
  where guest.restaurant_id = target_restaurant_id
    and guest.restaurant_table_id = target_table_id
    and guest.status = 'pending'
    and guest.expires_at > checked_at
    and confirmation.code = p_code
    and confirmation.consumed_at is null
    and confirmation.expires_at > checked_at
  limit 1
  for update of guest, confirmation;

  if not found then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  -- Reconfere o vencimento após adquirir os bloqueios.
  checked_at := clock_timestamp();

  update public.guest_confirmation_codes
  set consumed_at = checked_at
  where guest_session_id = target_session.id
    and code = p_code
    and consumed_at is null
    and expires_at > checked_at
    and target_session.expires_at > checked_at;

  if not found then
    return jsonb_build_object('status', 'invalid_code');
  end if;

  update public.guest_sessions
  set
    status = 'active',
    table_visit_id = target_visit.id,
    confirmed_by_member_id = target_member_id,
    confirmed_at = checked_at
  where id = target_session.id
  returning * into target_session;

  return jsonb_build_object(
    'status', 'confirmed',
    'guest_session_id', target_session.id,
    'table_visit_id', target_visit.id
  );
end;
$$;

revoke all
on function public.confirm_guest_session(text, integer, text)
from public, anon, authenticated;

grant execute
on function public.confirm_guest_session(text, integer, text)
to authenticated;

commit;