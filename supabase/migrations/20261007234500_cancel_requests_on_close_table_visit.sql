begin;

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

  if target_visit.assigned_member_id
    is distinct from target_member_id
  then
    raise exception using
      errcode = '42501',
      message = 'Somente o responsável pode encerrar este atendimento.';
  end if;

  -- Uma chamada repetida não modifica a próxima ocupação.
  if target_visit.status = 'closed' then
    return target_visit;
  end if;

  checked_at := greatest(
    clock_timestamp(),
    target_visit.opened_at
  );

  update public.guest_sessions
  set status = 'revoked'
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status in ('pending', 'active');

  -- Cancelar chamados pendentes, inclusive os criados
  -- antes de a equipe assumir a mesa.
  update public.service_requests
  set
    status = 'cancelled',
    resolved_at = greatest(checked_at, created_at),
    resolved_by_member_id = target_member_id
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status = 'pending';

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

commit;