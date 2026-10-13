begin;

-- Cada comanda pertence a uma ocupação específica da mesa.
create table public.table_tabs (
  id uuid primary key default gen_random_uuid(),

  restaurant_id uuid not null,
  restaurant_table_id uuid not null,
  table_visit_id uuid not null,

  label text not null,
  status text not null default 'open',

  created_by_member_id uuid not null,
  created_at timestamptz not null default now(),

  closed_by_member_id uuid,
  closed_at timestamptz,

  constraint table_tabs_valid_label
    check (
      label = btrim(label)
      and char_length(label) between 1 and 80
    ),

  constraint table_tabs_valid_status
    check (status in ('open', 'closed')),

  constraint table_tabs_valid_closure
    check (
      (
        status = 'open'
        and closed_by_member_id is null
        and closed_at is null
      )
      or
      (
        status = 'closed'
        and closed_by_member_id is not null
        and closed_at is not null
        and closed_at >= created_at
      )
    ),

  constraint table_tabs_visit_same_table
    foreign key (
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
    references public.table_visits (
      id,
      restaurant_id,
      restaurant_table_id
    )
    on delete restrict,

  constraint table_tabs_creator_same_restaurant
    foreign key (created_by_member_id, restaurant_id)
    references public.restaurant_members (id, restaurant_id)
    on delete restrict,

  constraint table_tabs_closer_same_restaurant
    foreign key (closed_by_member_id, restaurant_id)
    references public.restaurant_members (id, restaurant_id)
    on delete restrict,

  constraint table_tabs_id_visit_restaurant_table_unique
    unique (
      id,
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
);

create index table_tabs_visit_status_idx
  on public.table_tabs (table_visit_id, status);

create index table_tabs_restaurant_status_idx
  on public.table_tabs (restaurant_id, status);

-- Permitir um vínculo que também confira o atendimento,
-- além do restaurante e da mesa.
alter table public.guest_sessions
  add constraint guest_sessions_id_visit_restaurant_table_unique
  unique (
    id,
    table_visit_id,
    restaurant_id,
    restaurant_table_id
  );

-- Uma sessão pode estar vinculada a uma única comanda.
-- Uma comanda pode receber várias sessões.
-- Comandas sem vínculos também são permitidas.
create table public.table_tab_guests (
  guest_session_id uuid primary key,

  table_tab_id uuid not null,
  table_visit_id uuid not null,
  restaurant_id uuid not null,
  restaurant_table_id uuid not null,

  linked_by_member_id uuid not null,
  linked_at timestamptz not null default now(),

  constraint table_tab_guests_tab_same_visit
    foreign key (
      table_tab_id,
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
    references public.table_tabs (
      id,
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
    on delete restrict,

  constraint table_tab_guests_session_same_visit
    foreign key (
      guest_session_id,
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
    references public.guest_sessions (
      id,
      table_visit_id,
      restaurant_id,
      restaurant_table_id
    )
    on delete cascade,

  constraint table_tab_guests_member_same_restaurant
    foreign key (linked_by_member_id, restaurant_id)
    references public.restaurant_members (id, restaurant_id)
    on delete restrict
);

create index table_tab_guests_tab_idx
  on public.table_tab_guests (table_tab_id);

create index table_tab_guests_visit_idx
  on public.table_tab_guests (table_visit_id);

-- Validar alterações nas comandas.
-- O bloqueio da mesa segue o padrão das funções existentes.
create function public.validate_table_tab_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit public.table_visits%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if new.id is distinct from old.id
      or new.restaurant_id is distinct from old.restaurant_id
      or new.restaurant_table_id is distinct from old.restaurant_table_id
      or new.table_visit_id is distinct from old.table_visit_id
      or new.created_by_member_id is distinct from old.created_by_member_id
      or new.created_at is distinct from old.created_at
    then
      raise exception using
        errcode = '22023',
        message = 'Não é permitido alterar a origem da comanda.';
    end if;

    if old.status = 'closed' then
      raise exception using
        errcode = '22023',
        message = 'Uma comanda encerrada não pode ser alterada.';
    end if;
  end if;

  perform restaurant_table.id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.id = new.restaurant_table_id
    and restaurant_table.restaurant_id = new.restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Mesa não encontrada para esta comanda.';
  end if;

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.id = new.table_visit_id
    and visit.restaurant_id = new.restaurant_id
    and visit.restaurant_table_id = new.restaurant_table_id
  for update;

  if not found or target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'A comanda precisa pertencer a um atendimento aberto.';
  end if;

  if TG_OP = 'INSERT' and new.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Uma nova comanda deve começar aberta.';
  end if;

  return new;
end;
$$;

create trigger table_tabs_validate_write
before insert or update on public.table_tabs
for each row
execute function public.validate_table_tab_write();

-- Validar o vínculo de um cliente confirmado.
create function public.validate_table_tab_guest_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_guest public.guest_sessions%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if new.guest_session_id is distinct from old.guest_session_id
      or new.restaurant_id is distinct from old.restaurant_id
      or new.restaurant_table_id is distinct from old.restaurant_table_id
      or new.table_visit_id is distinct from old.table_visit_id
    then
      raise exception using
        errcode = '22023',
        message = 'Não é permitido mudar o cliente ou o atendimento deste vínculo.';
    end if;
  end if;

  perform restaurant_table.id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.id = new.restaurant_table_id
    and restaurant_table.restaurant_id = new.restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Mesa não encontrada.';
  end if;

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.id = new.table_visit_id
    and visit.restaurant_id = new.restaurant_id
    and visit.restaurant_table_id = new.restaurant_table_id
  for update;

  if not found or target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'O atendimento precisa estar aberto.';
  end if;

  select tab.*
  into target_tab
  from public.table_tabs as tab
  where tab.id = new.table_tab_id
    and tab.table_visit_id = new.table_visit_id
    and tab.restaurant_id = new.restaurant_id
    and tab.restaurant_table_id = new.restaurant_table_id
  for update;

  if not found or target_tab.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Selecione uma comanda aberta deste atendimento.';
  end if;

  select guest.*
  into target_guest
  from public.guest_sessions as guest
  where guest.id = new.guest_session_id
    and guest.table_visit_id = new.table_visit_id
    and guest.restaurant_id = new.restaurant_id
    and guest.restaurant_table_id = new.restaurant_table_id
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
      message = 'Confirme a presença do cliente antes de vinculá-lo.';
  end if;

  return new;
end;
$$;

create trigger table_tab_guests_validate_write
before insert or update on public.table_tab_guests
for each row
execute function public.validate_table_tab_guest_write();

-- Acrescentar a proteção sem substituir close_table_visit.
-- Se houver comanda aberta, toda a operação de encerramento
-- será revertida, incluindo revogações e cancelamentos.
create function public.prevent_visit_close_with_open_tabs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'open' and new.status = 'closed' then
    perform restaurant_table.id
    from public.restaurant_tables as restaurant_table
    where restaurant_table.id = old.restaurant_table_id
      and restaurant_table.restaurant_id = old.restaurant_id
    for update;

    if exists (
      select 1
      from public.table_tabs as tab
      where tab.table_visit_id = old.id
        and tab.restaurant_id = old.restaurant_id
        and tab.restaurant_table_id = old.restaurant_table_id
        and tab.status = 'open'
    ) then
      raise exception using
        errcode = '22023',
        message = 'Encerre todas as comandas antes de encerrar o atendimento da mesa.';
    end if;
  end if;

  return new;
end;
$$;

create trigger table_visits_check_open_tabs
before update of status on public.table_visits
for each row
execute function public.prevent_visit_close_with_open_tabs();

-- As funções acima são internas, executadas pelos triggers.
revoke all privileges
  on function public.validate_table_tab_write(),
              public.validate_table_tab_guest_write(),
              public.prevent_visit_close_with_open_tabs()
  from public, anon, authenticated;

-- A aplicação terá somente leitura direta.
-- As operações de escrita serão feitas por RPCs autorizadas
-- no próximo bloco.
alter table public.table_tabs enable row level security;
alter table public.table_tab_guests enable row level security;

revoke all privileges
  on table public.table_tabs, public.table_tab_guests
  from public, anon, authenticated;

grant select
  on table public.table_tabs, public.table_tab_guests
  to authenticated;

-- Equipe autenticada e ativa: leitura dentro do restaurante.
create policy table_tabs_read_by_members
  on public.table_tabs
  for select
  to authenticated
  using (
    not coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant
        on restaurant.id = member.restaurant_id
      where member.restaurant_id = table_tabs.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role in ('admin', 'waiter')
        and restaurant.active = true
    )
  );

create policy table_tab_guests_read_by_members
  on public.table_tab_guests
  for select
  to authenticated
  using (
    not coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant
        on restaurant.id = member.restaurant_id
      where member.restaurant_id = table_tab_guests.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role in ('admin', 'waiter')
        and restaurant.active = true
    )
  );

-- Cliente: leitura somente do seu próprio vínculo.
-- Não permite consultar os demais clientes da comanda.
create policy table_tab_guests_read_own
  on public.table_tab_guests
  for select
  to authenticated
  using (
    coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.guest_sessions as guest
      join public.restaurants as restaurant
        on restaurant.id = guest.restaurant_id
      where guest.id = table_tab_guests.guest_session_id
        and guest.table_visit_id = table_tab_guests.table_visit_id
        and guest.restaurant_id = table_tab_guests.restaurant_id
        and guest.restaurant_table_id =
            table_tab_guests.restaurant_table_id
        and guest.user_id = (select auth.uid())
        and guest.status = 'active'
        and guest.expires_at > now()
        and restaurant.active = true
    )
  );

-- A política do vínculo já verifica identidade,
-- confirmação e validade da sessão.
create policy table_tabs_read_by_linked_guest
  on public.table_tabs
  for select
  to authenticated
  using (
    coalesce(
      (select auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
    and exists (
      select 1
      from public.table_tab_guests as linked_guest
      where linked_guest.table_tab_id = table_tabs.id
        and linked_guest.table_visit_id = table_tabs.table_visit_id
        and linked_guest.restaurant_id = table_tabs.restaurant_id
        and linked_guest.restaurant_table_id =
            table_tabs.restaurant_table_id
    )
  );

commit;