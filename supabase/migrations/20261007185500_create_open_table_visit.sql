begin;

create function public.open_table_visit(
  p_restaurant_slug text,
  p_table_number integer
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
begin
  current_user_id := auth.uid();

  if current_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Entre com sua conta para atender uma mesa.';
  end if;

  if p_table_number is null
    or p_table_number < 1
    or p_table_number > 999
  then
    raise exception using
      errcode = '22023',
      message = 'Número de mesa inválido.';
  end if;

  -- Manter o restaurante ativo durante a operação.
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

  -- Identificar o funcionário pela sessão.
  -- O navegador não escolhe o responsável.
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

  -- Serializar operações de abertura para esta mesa.
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
    and visit.status = 'open'
  for update;

  if found then
    if target_visit.assigned_member_id is null then
      update public.table_visits
      set assigned_member_id = target_member_id
      where id = target_visit.id
      returning * into target_visit;

    elsif target_visit.assigned_member_id <> target_member_id then
      raise exception using
        errcode = '42501',
        message = 'Esta mesa já está sendo atendida por outro funcionário.';
    end if;

    return target_visit;
  end if;

  insert into public.table_visits (
    restaurant_id,
    restaurant_table_id,
    assigned_member_id
  )
  values (
    target_restaurant_id,
    target_table_id,
    target_member_id
  )
  returning * into target_visit;

  return target_visit;
end;
$$;

revoke all privileges
  on function public.open_table_visit(text, integer)
  from public, anon, authenticated;

grant execute
  on function public.open_table_visit(text, integer)
  to authenticated;

commit;