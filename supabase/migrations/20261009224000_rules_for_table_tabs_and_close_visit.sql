begin;

-- 1. Permitir vincular ou reatribuir cliente confirmado a outra comanda do mesmo atendimento
create or replace function public.link_guest_to_table_tab(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_guest_session_id uuid
)
returns public.table_tab_guests
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_guest public.guest_sessions%rowtype;
  target_link public.table_tab_guests%rowtype;
begin
  if p_table_tab_id is null or p_guest_session_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe a comanda e o cliente.';
  end if;

  select tab.table_visit_id
  into target_visit_id
  from public.table_tabs as tab
  join public.restaurants as restaurant
    on restaurant.id = tab.restaurant_id
  where tab.id = p_table_tab_id
    and restaurant.slug = p_restaurant_slug
    and restaurant.active = true;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Comanda não encontrada neste restaurante.';
  end if;

  target_visit := public.lock_owned_table_visit(
    p_restaurant_slug,
    target_visit_id
  );

  if target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Este atendimento já foi encerrado.';
  end if;

  select tab.*
  into target_tab
  from public.table_tabs as tab
  where tab.id = p_table_tab_id
    and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id =
        target_visit.restaurant_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Comanda não encontrada neste atendimento.';
  end if;

  if target_tab.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Não é possível vincular clientes a uma comanda encerrada.';
  end if;

  select guest.*
  into target_guest
  from public.guest_sessions as guest
  where guest.id = p_guest_session_id
    and guest.table_visit_id = target_visit.id
    and guest.restaurant_id = target_visit.restaurant_id
    and guest.restaurant_table_id =
        target_visit.restaurant_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Cliente não encontrado neste atendimento.';
  end if;

  if target_guest.status <> 'active'
    or target_guest.expires_at <= clock_timestamp()
  then
    raise exception using
      errcode = '22023',
      message = 'O cliente precisa ter uma confirmação de presença válida.';
  end if;

  select linked_guest.*
  into target_link
  from public.table_tab_guests as linked_guest
  where linked_guest.guest_session_id = target_guest.id
  for update;

  if found then
    if target_link.table_tab_id = target_tab.id then
      return target_link;
    end if;

    -- Reatribui o cliente à nova comanda no mesmo atendimento
    update public.table_tab_guests
    set table_tab_id = target_tab.id,
        linked_by_member_id = target_visit.assigned_member_id,
        linked_at = greatest(clock_timestamp(), target_guest.confirmed_at)
    where guest_session_id = target_guest.id
    returning * into target_link;

    return target_link;
  end if;

  insert into public.table_tab_guests (
    guest_session_id,
    table_tab_id,
    table_visit_id,
    restaurant_id,
    restaurant_table_id,
    linked_by_member_id,
    linked_at
  )
  values (
    target_guest.id,
    target_tab.id,
    target_visit.id,
    target_visit.restaurant_id,
    target_visit.restaurant_table_id,
    target_visit.assigned_member_id,
    greatest(clock_timestamp(), target_guest.confirmed_at)
  )
  returning * into target_link;

  return target_link;
end;
$$;

-- 2. Regra: Só pode encerrar o atendimento da mesa após todas as comandas estarem fechadas
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

  -- 2. Cancelar chamados e pedidos de conta pendentes
  update public.service_requests
  set
    status = 'cancelled',
    resolved_at = greatest(checked_at, created_at),
    resolved_by_member_id = target_member_id
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status = 'pending';

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

commit;
