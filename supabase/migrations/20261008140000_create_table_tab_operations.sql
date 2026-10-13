begin;

-- Função interna compartilhada pelas operações.
-- Valida a equipe e bloqueia os registros na mesma ordem
-- utilizada pelas operações existentes.
create function public.lock_owned_table_visit(
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
      message = 'Informe o atendimento.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if not found then
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

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select visit.restaurant_table_id
  into target_table_id
  from public.table_visits as visit
  where visit.id = p_table_visit_id
    and visit.restaurant_id = target_restaurant_id;

  if not found then
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
      message = 'Somente o responsável pode administrar as comandas deste atendimento.';
  end if;

  return target_visit;
end;
$$;

-- Criar comanda.
-- O navegador deverá gerar p_table_tab_id uma vez por criação
-- e reutilizá-lo se precisar repetir a mesma tentativa.
create function public.create_table_tab(
  p_restaurant_slug text,
  p_table_visit_id uuid,
  p_label text,
  p_table_tab_id uuid
)
returns public.table_tabs
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  normalized_label text;
begin
  normalized_label := btrim(p_label);

  if normalized_label is null
    or char_length(normalized_label) not between 1 and 80
  then
    raise exception using
      errcode = '22023',
      message = 'Informe uma identificação de comanda entre 1 e 80 caracteres.';
  end if;

  if p_table_tab_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe o identificador da nova comanda.';
  end if;

  target_visit := public.lock_owned_table_visit(
    p_restaurant_slug,
    p_table_visit_id
  );

  select tab.*
  into target_tab
  from public.table_tabs as tab
  where tab.id = p_table_tab_id
  for update;

  if found then
    if target_tab.restaurant_id = target_visit.restaurant_id
      and target_tab.restaurant_table_id =
          target_visit.restaurant_table_id
      and target_tab.table_visit_id = target_visit.id
      and target_tab.created_by_member_id =
          target_visit.assigned_member_id
      and target_tab.label = normalized_label
    then
      return target_tab;
    end if;

    raise exception using
      errcode = '22023',
      message = 'Identificador de comanda já utilizado. Atualize a lista antes de tentar novamente.';
  end if;

  if target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Não é possível criar uma comanda em um atendimento encerrado.';
  end if;

  insert into public.table_tabs (
    id,
    restaurant_id,
    restaurant_table_id,
    table_visit_id,
    label,
    created_by_member_id,
    created_at
  )
  values (
    p_table_tab_id,
    target_visit.restaurant_id,
    target_visit.restaurant_table_id,
    target_visit.id,
    normalized_label,
    target_visit.assigned_member_id,
    greatest(clock_timestamp(), target_visit.opened_at)
  )
  returning * into target_tab;

  return target_tab;
end;
$$;

-- Vincular um cliente confirmado a uma comanda aberta.
create function public.link_guest_to_table_tab(
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

    raise exception using
      errcode = '22023',
      message = 'Este cliente já está vinculado a outra comanda.';
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

-- Encerrar somente a comanda selecionada.
-- Não encerra a mesa nem revoga os acessos dos clientes.
create function public.close_table_tab(
  p_restaurant_slug text,
  p_table_tab_id uuid
)
returns public.table_tabs
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
begin
  if p_table_tab_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe a comanda que deseja encerrar.';
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

  -- Uma repetição retorna a comanda já encerrada.
  if target_tab.status = 'closed' then
    return target_tab;
  end if;

  if target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Este atendimento já foi encerrado.';
  end if;

  update public.table_tabs
  set
    status = 'closed',
    closed_by_member_id = target_visit.assigned_member_id,
    closed_at = greatest(clock_timestamp(), target_tab.created_at)
  where id = target_tab.id
  returning * into target_tab;

  return target_tab;
end;
$$;

-- A função de autorização é interna.
revoke all privileges
  on function public.lock_owned_table_visit(text, uuid)
  from public, anon, authenticated;

-- Remover a execução pública concedida por padrão.
revoke all privileges
  on function public.create_table_tab(text, uuid, text, uuid),
              public.link_guest_to_table_tab(text, uuid, uuid),
              public.close_table_tab(text, uuid)
  from public, anon, authenticated;

-- As funções também conferem, internamente,
-- que a sessão pertence a um funcionário autorizado.
grant execute
  on function public.create_table_tab(text, uuid, text, uuid),
              public.link_guest_to_table_tab(text, uuid, uuid),
              public.close_table_tab(text, uuid)
  to authenticated;

commit;