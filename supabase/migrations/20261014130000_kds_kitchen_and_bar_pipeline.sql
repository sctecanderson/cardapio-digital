begin;

-- ============================================================================
-- 1. EXTENSÃO DA TABELA public.menu_products: ESTAÇÃO DE PREPARO
-- preparation_station: text check ('kitchen', 'bar', 'none') default 'kitchen'
-- Retrocompatível com itens já cadastrados.
-- 'none' é utilizado para itens sem preparo físico (ex.: águas, refrigerantes em lata).
-- ============================================================================
alter table public.menu_products
  add column if not exists preparation_station text default 'kitchen';

alter table public.menu_products
  drop constraint if exists menu_products_preparation_station_check,
  add constraint menu_products_preparation_station_check
    check (preparation_station in ('kitchen', 'bar', 'none'));

update public.menu_products
set preparation_station = 'kitchen'
where preparation_station is null;

alter table public.menu_products
  alter column preparation_station set not null,
  alter column preparation_station set default 'kitchen';

-- ============================================================================
-- 2. EXTENSÃO DA TABELA public.table_tab_items: CICLO DE VIDA DE PRODUÇÃO (KDS)
-- production_status: text check ('pending', 'preparing', 'ready', 'delivered') default 'pending'
-- preparation_station: text check ('kitchen', 'bar', 'none') default 'kitchen'
-- prep_started_at, prep_ready_at, prep_delivered_at: timestamptz null
-- prepared_by_member_id: uuid null references public.restaurant_members(id) on delete set null
-- ============================================================================
alter table public.table_tab_items
  add column if not exists production_status text not null default 'pending',
  add column if not exists preparation_station text not null default 'kitchen',
  add column if not exists prep_started_at timestamptz null,
  add column if not exists prep_ready_at timestamptz null,
  add column if not exists prep_delivered_at timestamptz null,
  add column if not exists prepared_by_member_id uuid null references public.restaurant_members(id) on delete set null;

alter table public.table_tab_items
  drop constraint if exists table_tab_items_production_status_check,
  add constraint table_tab_items_production_status_check
    check (production_status in ('pending', 'preparing', 'ready', 'delivered'));

alter table public.table_tab_items
  drop constraint if exists table_tab_items_preparation_station_check,
  add constraint table_tab_items_preparation_station_check
    check (preparation_station in ('kitchen', 'bar', 'none'));

-- ============================================================================
-- 3. RETROCOMPATIBILIDADE: INICIALIZAÇÃO DE ITENS HISTÓRICOS EM COMANDAS FECHADAS
-- Itens de comandas fechadas (status = 'closed') são tratados como 'delivered'
-- para não poluir telas operacionais do KDS.
-- ============================================================================
alter table public.table_tab_items disable trigger table_tab_items_validate_write;

update public.table_tab_items
set
  production_status = 'delivered',
  prep_delivered_at = coalesce(cancelled_at, created_at)
where table_tab_id in (
  select id from public.table_tabs where status = 'closed'
);

alter table public.table_tab_items enable trigger table_tab_items_validate_write;

-- ============================================================================
-- 4. ATUALIZAÇÃO DO TRIGGER DE VALIDAÇÃO: public.validate_table_tab_item_write
-- Permite transições de ciclo de vida de produção (production_status, timestamps,
-- prepared_by_member_id) enquanto a comanda estiver aberta, protegendo
-- estritamente contra alterações em campos imutáveis (financeiros/estruturais),
-- contra alterações em itens cancelados e comandas encerradas.
-- ============================================================================
create or replace function public.validate_table_tab_item_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_product public.menu_products%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if old.status = 'cancelled' then
      raise exception using errcode = '22023', message = 'Um lançamento cancelado não pode ser alterado.';
    end if;

    if new.id is distinct from old.id
      or new.restaurant_id is distinct from old.restaurant_id
      or new.restaurant_table_id is distinct from old.restaurant_table_id
      or new.table_visit_id is distinct from old.table_visit_id
      or new.table_tab_id is distinct from old.table_tab_id
      or new.product_id is distinct from old.product_id
      or new.product_name is distinct from old.product_name
      or new.unit_price_in_cents is distinct from old.unit_price_in_cents
      or new.quantity is distinct from old.quantity
      or new.added_by_member_id is distinct from old.added_by_member_id
      or new.created_at is distinct from old.created_at
      or new.preparation_station is distinct from old.preparation_station
    then
      raise exception using errcode = '22023', message = 'Cancele o lançamento e registre outro para corrigir o consumo.';
    end if;

    if new.status <> 'cancelled' and new.status <> old.status then
      raise exception using errcode = '22023', message = 'A única alteração permitida é cancelar o lançamento ou atualizar a produção.';
    end if;

    if new.status = 'active' then
      if new.cancelled_at is not null
        or new.cancelled_by_member_id is not null
        or new.cancellation_reason is not null
      then
        raise exception using errcode = '22023', message = 'Dados de cancelamento inválidos.';
      end if;
    end if;
  end if;

  perform restaurant_table.id from public.restaurant_tables as restaurant_table
  where restaurant_table.id = new.restaurant_table_id
    and restaurant_table.restaurant_id = new.restaurant_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Mesa não encontrada.';
  end if;

  select visit.* into target_visit from public.table_visits as visit
  where visit.id = new.table_visit_id and visit.restaurant_id = new.restaurant_id
    and visit.restaurant_table_id = new.restaurant_table_id for update;
  if not found or target_visit.status <> 'open' then
    raise exception using errcode = '22023', message = 'O atendimento precisa estar aberto.';
  end if;

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = new.table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = new.restaurant_id
    and tab.restaurant_table_id = new.restaurant_table_id for update;
  if not found or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'A comanda precisa estar aberta.';
  end if;

  if TG_OP = 'INSERT' then
    if new.status <> 'active' or new.added_by_member_id is distinct from target_visit.assigned_member_id then
      raise exception using errcode = '22023', message = 'Lançamento inválido para este atendimento.';
    end if;
    select product.* into target_product from public.menu_products as product
    where product.id = new.product_id and product.restaurant_id = new.restaurant_id for share;
    if not found or not target_product.available then
      raise exception using errcode = '22023', message = 'Produto indisponível.';
    end if;
    if new.product_name is distinct from target_product.name
      or new.unit_price_in_cents is distinct from target_product.price_in_cents
    then
      raise exception using errcode = '22023', message = 'O nome e o preço devem corresponder ao catálogo do servidor.';
    end if;
  elsif new.status = 'cancelled' then
    if new.cancelled_by_member_id is distinct from target_visit.assigned_member_id then
      raise exception using errcode = '22023', message = 'Responsável pelo cancelamento inválido.';
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 5. ATUALIZAÇÃO DA RPC public.add_table_tab_item
-- Copia preparation_station de public.menu_products para public.table_tab_items.
-- ============================================================================
create or replace function public.add_table_tab_item(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_item_id uuid
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_product public.menu_products%rowtype;
  target_item public.table_tab_items%rowtype;
begin
  if p_table_tab_id is null or p_product_id is null or p_item_id is null
    or p_quantity is null or p_quantity not between 1 and 99 then
    raise exception using errcode = '22023', message = 'Selecione o produto e uma quantidade entre 1 e 99.';
  end if;

  select tab.table_visit_id into target_visit_id from public.table_tabs as tab
  join public.restaurants as restaurant on restaurant.id = tab.restaurant_id
  where tab.id = p_table_tab_id and restaurant.slug = p_restaurant_slug and restaurant.active;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste restaurante.';
  end if;

  target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste atendimento.';
  end if;

  -- Repetir o mesmo ID e os mesmos dados não duplica o consumo.
  select item.* into target_item from public.table_tab_items as item
  where item.id = p_item_id for update;
  if found then
    if target_item.table_tab_id = target_tab.id
      and target_item.restaurant_id = target_visit.restaurant_id
      and target_item.product_id = p_product_id and target_item.quantity = p_quantity
      and target_item.added_by_member_id = target_visit.assigned_member_id then
      return target_item;
    end if;
    raise exception using errcode = '22023', message = 'Identificador de lançamento já utilizado. Atualize a comanda.';
  end if;

  if target_visit.status <> 'open' or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Não é possível registrar consumo em uma comanda encerrada.';
  end if;

  select product.* into target_product from public.menu_products as product
  where product.id = p_product_id and product.restaurant_id = target_visit.restaurant_id for share;
  if not found or not target_product.available then
    raise exception using errcode = '22023', message = 'Produto indisponível neste restaurante.';
  end if;

  perform category.id from public.menu_categories as category
  where category.id = target_product.category_id and category.restaurant_id = target_visit.restaurant_id
    and category.active for share;
  if not found then
    raise exception using errcode = '22023', message = 'A categoria deste produto está indisponível.';
  end if;

  insert into public.table_tab_items (
    id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
    product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
    preparation_station
  ) values (
    p_item_id, target_visit.restaurant_id, target_visit.restaurant_table_id,
    target_visit.id, target_tab.id, target_product.id, target_product.name,
    target_product.price_in_cents, p_quantity, target_visit.assigned_member_id,
    greatest(clock_timestamp(), target_tab.created_at),
    coalesce(target_product.preparation_station, 'kitchen')
  ) returning * into target_item;

  return target_item;
end;
$$;

revoke all privileges on function public.add_table_tab_item(text, uuid, uuid, integer, uuid) from public, anon, authenticated;
grant execute on function public.add_table_tab_item(text, uuid, uuid, integer, uuid) to authenticated;

-- ============================================================================
-- 6. RPC DE PRODUÇÃO KDS: public.update_tab_item_production_status
-- Permite que membros ativos ('admin', 'waiter') atualizem o estado de produção
-- de itens da comanda seguindo rigorosamente a máquina de estados, locks em ordem
-- canônica e proteção multi-tenant.
-- ============================================================================
create or replace function public.update_tab_item_production_status(
  p_restaurant_slug text,
  p_item_id uuid,
  p_target_status text
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_member_role text;
  item_restaurant_id uuid;
  target_table_id uuid;
  target_visit_id uuid;
  target_tab_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_item public.table_tab_items%rowtype;
begin
  current_user_id := auth.uid();
  if current_user_id is null
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_item_id is null or p_target_status is null or btrim(p_target_status) = '' then
    raise exception using
      errcode = '22023',
      message = 'Informe o item e o estado de produção desejado.';
  end if;

  if p_target_status not in ('pending', 'preparing', 'ready', 'delivered') then
    raise exception using
      errcode = '22023',
      message = 'Estado de produção inválido.';
  end if;

  -- 1. Restaurante ativo com bloqueio compartilhado (FOR SHARE)
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

  -- 2. Membro da equipe com vínculo ativo e papel permitido (FOR SHARE)
  select member.id, member.role
  into target_member_id, target_member_role
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

  -- Localizar o item de comanda para validação multi-tenant e mapeamento estrutural
  select
    item.restaurant_id,
    item.restaurant_table_id,
    item.table_visit_id,
    item.table_tab_id
  into
    item_restaurant_id,
    target_table_id,
    target_visit_id,
    target_tab_id
  from public.table_tab_items as item
  where item.id = p_item_id;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Item de comanda não encontrado.';
  end if;

  if item_restaurant_id <> target_restaurant_id then
    raise exception using
      errcode = '42501',
      message = 'Item pertence a outro restaurante.';
  end if;

  -- 3. Mesa da visita (FOR UPDATE)
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

  -- 4. Atendimento / Visita (FOR UPDATE)
  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.id = target_visit_id
    and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Atendimento não encontrado.';
  end if;

  -- 5. Comanda (FOR UPDATE)
  select tab.*
  into target_tab
  from public.table_tabs as tab
  where tab.id = target_tab_id
    and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_restaurant_id
    and tab.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Comanda não encontrada neste atendimento.';
  end if;

  -- 6. Item de comanda (FOR UPDATE)
  select item.*
  into target_item
  from public.table_tab_items as item
  where item.id = p_item_id
    and item.table_tab_id = target_tab.id
    and item.restaurant_id = target_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Item não encontrado nesta comanda.';
  end if;

  -- Integridade de comanda encerrada e visita
  if target_tab.status = 'closed' or target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Não é possível alterar a produção de itens em uma comanda encerrada.';
  end if;

  -- Integridade de item cancelado
  if target_item.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Não é possível alterar a produção de um item cancelado.';
  end if;

  -- Máquina de estados de produção
  if target_item.production_status = 'pending' and p_target_status = 'preparing' then
    update public.table_tab_items
    set
      production_status = 'preparing',
      prep_started_at = coalesce(prep_started_at, clock_timestamp()),
      prepared_by_member_id = coalesce(prepared_by_member_id, target_member_id)
    where id = target_item.id
    returning * into target_item;

  elsif target_item.production_status = 'preparing' and p_target_status = 'ready' then
    update public.table_tab_items
    set
      production_status = 'ready',
      prep_ready_at = coalesce(prep_ready_at, clock_timestamp())
    where id = target_item.id
    returning * into target_item;

  elsif target_item.production_status = 'ready' and p_target_status = 'delivered' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, clock_timestamp())
    where id = target_item.id
    returning * into target_item;

  elsif target_item.production_status = 'pending' and p_target_status = 'delivered' and target_item.preparation_station = 'none' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, clock_timestamp()),
      prepared_by_member_id = coalesce(prepared_by_member_id, target_member_id)
    where id = target_item.id
    returning * into target_item;

  else
    raise exception using
      errcode = '22023',
      message = format('Transição de produção inválida: de %s para %s.', target_item.production_status, p_target_status);
  end if;

  return target_item;
end;
$$;

revoke all privileges on function public.update_tab_item_production_status(text, uuid, text) from public, anon, authenticated;
grant execute on function public.update_tab_item_production_status(text, uuid, text) to authenticated;

notify pgrst, 'reload schema';

commit;
