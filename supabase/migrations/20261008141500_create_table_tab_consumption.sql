begin;

-- Catálogo mínimo. As mídias continuam no catálogo local nesta etapa.
create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  catalog_key text not null,
  name text not null,
  slug text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  constraint menu_categories_valid_text check (
    char_length(btrim(catalog_key)) > 0 and char_length(btrim(name)) > 0
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint menu_categories_key_unique unique (restaurant_id, catalog_key),
  constraint menu_categories_slug_unique unique (restaurant_id, slug),
  constraint menu_categories_id_restaurant_unique unique (id, restaurant_id)
);

create table public.menu_products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  category_id uuid not null,
  catalog_key text not null,
  slug text not null,
  name text not null,
  short_description text not null default '',
  description text not null default '',
  price_in_cents integer not null,
  available boolean not null default true,
  featured boolean not null default false,
  sort_order integer not null default 0,
  constraint menu_products_valid_text check (
    char_length(btrim(catalog_key)) > 0 and char_length(btrim(name)) > 0
    and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint menu_products_valid_price check (price_in_cents >= 0),
  constraint menu_products_category_same_restaurant
    foreign key (category_id, restaurant_id)
    references public.menu_categories(id, restaurant_id) on delete restrict,
  constraint menu_products_key_unique unique (restaurant_id, catalog_key),
  constraint menu_products_slug_unique unique (restaurant_id, slug),
  constraint menu_products_id_restaurant_unique unique (id, restaurant_id)
);

create index menu_products_category_idx on public.menu_products(category_id);

create table public.table_tab_items (
  id uuid primary key,
  restaurant_id uuid not null,
  restaurant_table_id uuid not null,
  table_visit_id uuid not null,
  table_tab_id uuid not null,
  product_id uuid not null,
  product_name text not null,
  unit_price_in_cents integer not null,
  quantity integer not null,
  line_total_in_cents bigint generated always as
    (unit_price_in_cents::bigint * quantity::bigint) stored,
  status text not null default 'active',
  added_by_member_id uuid not null,
  created_at timestamptz not null default now(),
  cancelled_by_member_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text,
  constraint table_tab_items_valid_name check (char_length(btrim(product_name)) > 0),
  constraint table_tab_items_valid_price check (unit_price_in_cents >= 0),
  constraint table_tab_items_valid_quantity check (quantity between 1 and 99),
  constraint table_tab_items_valid_status check (status in ('active', 'cancelled')),
  constraint table_tab_items_valid_cancellation check (
    (status = 'active' and cancelled_by_member_id is null
      and cancelled_at is null and cancellation_reason is null)
    or
    (status = 'cancelled' and cancelled_by_member_id is not null
      and cancelled_at is not null and cancelled_at >= created_at
      and cancellation_reason is not null
      and char_length(btrim(cancellation_reason)) between 3 and 300)
  ),
  constraint table_tab_items_tab_same_visit
    foreign key (table_tab_id, table_visit_id, restaurant_id, restaurant_table_id)
    references public.table_tabs(id, table_visit_id, restaurant_id, restaurant_table_id)
    on delete restrict,
  constraint table_tab_items_product_same_restaurant
    foreign key (product_id, restaurant_id)
    references public.menu_products(id, restaurant_id) on delete restrict,
  constraint table_tab_items_author_same_restaurant
    foreign key (added_by_member_id, restaurant_id)
    references public.restaurant_members(id, restaurant_id) on delete restrict,
  constraint table_tab_items_canceller_same_restaurant
    foreign key (cancelled_by_member_id, restaurant_id)
    references public.restaurant_members(id, restaurant_id) on delete restrict
);

create index table_tab_items_tab_created_idx
  on public.table_tab_items(table_tab_id, created_at, id);

-- Proteção adicional dos registros, inclusive contra escritas internas incorretas.
create function public.validate_table_tab_item_write()
returns trigger language plpgsql security definer set search_path = '' as $$
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
    then
      raise exception using errcode = '22023', message = 'Cancele o lançamento e registre outro para corrigir o consumo.';
    end if;
    if new.status <> 'cancelled' then
      raise exception using errcode = '22023', message = 'A única alteração permitida é cancelar o lançamento.';
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
  elsif new.cancelled_by_member_id is distinct from target_visit.assigned_member_id then
    raise exception using errcode = '22023', message = 'Responsável pelo cancelamento inválido.';
  end if;
  return new;
end;
$$;

create trigger table_tab_items_validate_write
before insert or update on public.table_tab_items for each row
execute function public.validate_table_tab_item_write();

create function public.add_table_tab_item(
  p_restaurant_slug text, p_table_tab_id uuid, p_product_id uuid,
  p_quantity integer, p_item_id uuid
)
returns public.table_tab_items language plpgsql security definer set search_path = '' as $$
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
    product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at
  ) values (
    p_item_id, target_visit.restaurant_id, target_visit.restaurant_table_id,
    target_visit.id, target_tab.id, target_product.id, target_product.name,
    target_product.price_in_cents, p_quantity, target_visit.assigned_member_id,
    greatest(clock_timestamp(), target_tab.created_at)
  ) returning * into target_item;
  return target_item;
end;
$$;

create function public.cancel_table_tab_item(
  p_restaurant_slug text, p_item_id uuid, p_reason text
)
returns public.table_tab_items language plpgsql security definer set search_path = '' as $$
declare
  target_visit_id uuid;
  target_tab_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_item public.table_tab_items%rowtype;
  normalized_reason text;
begin
  normalized_reason := btrim(p_reason);
  if p_item_id is null or normalized_reason is null
    or char_length(normalized_reason) not between 3 and 300 then
    raise exception using errcode = '22023', message = 'Informe um motivo entre 3 e 300 caracteres.';
  end if;
  select item.table_visit_id, item.table_tab_id into target_visit_id, target_tab_id
  from public.table_tab_items as item
  join public.restaurants as restaurant on restaurant.id = item.restaurant_id
  where item.id = p_item_id and restaurant.slug = p_restaurant_slug and restaurant.active;
  if not found then
    raise exception using errcode = '22023', message = 'Lançamento não encontrado neste restaurante.';
  end if;
  target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);
  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = target_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste atendimento.';
  end if;
  select item.* into target_item from public.table_tab_items as item
  where item.id = p_item_id and item.table_tab_id = target_tab.id
    and item.restaurant_id = target_visit.restaurant_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Lançamento não encontrado.';
  end if;
  if target_item.status = 'cancelled' then return target_item; end if;
  if target_visit.status <> 'open' or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Não é possível cancelar consumo em uma comanda encerrada.';
  end if;
  update public.table_tab_items set status = 'cancelled',
    cancelled_by_member_id = target_visit.assigned_member_id,
    cancelled_at = greatest(clock_timestamp(), target_item.created_at),
    cancellation_reason = normalized_reason
  where id = target_item.id returning * into target_item;
  return target_item;
end;
$$;

alter table public.menu_categories enable row level security;
alter table public.menu_products enable row level security;
alter table public.table_tab_items enable row level security;
revoke all privileges on table public.menu_categories, public.menu_products, public.table_tab_items
  from public, anon, authenticated;
grant select on table public.menu_categories, public.menu_products, public.table_tab_items to authenticated;

-- O catálogo mínimo é operacional nesta etapa; o cardápio público ainda é local.
create policy menu_categories_read_by_members on public.menu_categories for select to authenticated using (
  not coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false)
  and exists (
    select 1 from public.restaurant_members as member
    join public.restaurants as restaurant on restaurant.id = member.restaurant_id
    where member.restaurant_id = menu_categories.restaurant_id
      and member.user_id = (select auth.uid()) and member.active and restaurant.active
      and member.role in ('admin', 'waiter')
  )
);
create policy menu_products_read_by_members on public.menu_products for select to authenticated using (
  not coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false)
  and exists (
    select 1 from public.restaurant_members as member
    join public.restaurants as restaurant on restaurant.id = member.restaurant_id
    where member.restaurant_id = menu_products.restaurant_id
      and member.user_id = (select auth.uid()) and member.active and restaurant.active
      and member.role in ('admin', 'waiter')
  )
);
-- A visibilidade da comanda já restringe equipe e cliente vinculado.
create policy table_tab_items_read_by_tab_access on public.table_tab_items for select to authenticated using (
  exists (
    select 1 from public.table_tabs as tab
    where tab.id = table_tab_items.table_tab_id
      and tab.table_visit_id = table_tab_items.table_visit_id
      and tab.restaurant_id = table_tab_items.restaurant_id
      and tab.restaurant_table_id = table_tab_items.restaurant_table_id
  )
);

-- Uma consulta retorna lista e total no mesmo snapshot.
-- O JSON evita truncar silenciosamente o total pelo limite de linhas da API.
-- SECURITY INVOKER mantém todas as políticas RLS do usuário chamador.
create function public.get_table_tab_consumption(
  p_restaurant_id uuid, p_table_tab_id uuid
)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', product.id, 'name', product.name, 'price_in_cents', product.price_in_cents
      ) order by product.sort_order, product.id)
      from public.menu_products as product
      join public.menu_categories as category
        on category.id = product.category_id and category.restaurant_id = product.restaurant_id
      where product.restaurant_id = tab.restaurant_id and product.available and category.active
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(to_jsonb(item) order by item.created_at, item.id)
      from public.table_tab_items as item
      where item.table_tab_id = tab.id and item.restaurant_id = tab.restaurant_id
    ), '[]'::jsonb),
    'totalInCents', coalesce((
      select sum(item.line_total_in_cents)
      from public.table_tab_items as item
      where item.table_tab_id = tab.id and item.restaurant_id = tab.restaurant_id
        and item.status = 'active'
    ), 0)
  )
  from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.restaurant_id = p_restaurant_id;
$$;

revoke all privileges on function public.validate_table_tab_item_write() from public, anon, authenticated;
revoke all privileges on function public.add_table_tab_item(text, uuid, uuid, integer, uuid),
  public.cancel_table_tab_item(text, uuid, text) from public, anon, authenticated;
grant execute on function public.add_table_tab_item(text, uuid, uuid, integer, uuid),
  public.cancel_table_tab_item(text, uuid, text) to authenticated;
revoke all privileges on function public.get_table_tab_consumption(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_table_tab_consumption(uuid, uuid) to authenticated;

-- Carga inicial extraída do arquivo src/data/menu.ts enviado pelo usuário.
-- ON CONFLICT DO NOTHING evita sobrescrever alterações posteriores no banco.
do $$
declare
  noma_id uuid;
begin
  select id into noma_id from public.restaurants where slug = 'noma' and active;
  if not found then
    raise exception 'Restaurante NOMA ativo não encontrado. A migração não foi aplicada.';
  end if;

  insert into public.menu_categories (restaurant_id, catalog_key, name, slug, sort_order)
  values
    (noma_id, 'noma-pratos', 'Pratos', 'pratos', 1),
    (noma_id, 'noma-bebidas', 'Bebidas', 'bebidas', 2),
    (noma_id, 'noma-sobremesas', 'Sobremesas', 'sobremesas', 3)
  on conflict (restaurant_id, catalog_key) do nothing;

  insert into public.menu_products (
    restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured, sort_order
  )
  select noma_id, category.id, source.catalog_key, source.slug, source.name,
    source.short_description, source.description, source.price_in_cents,
    true, source.featured, source.sort_order
  from (values
    ('noma-pratos', 'noma-risoto', 'risoto-de-cogumelos', 'Risoto de cogumelos',
      'Arroz arbóreo, cogumelos e parmesão.',
      'Arroz arbóreo com mix de cogumelos e finalização com queijo parmesão.', 5800, true, 1),
    ('noma-pratos', 'noma-burguer', 'burguer-da-casa', 'Búrguer da casa',
      'Brioche, queijo e molho da casa.',
      'Hambúrguer de carne no pão brioche, com queijo e molho da casa.', 4200, false, 2),
    ('noma-bebidas', 'noma-agua', 'agua-com-gas', 'Água com gás',
      'Garrafa de 500 ml.', 'Água mineral com gás, servida em garrafa de 500 ml.', 800, false, 3),
    ('noma-sobremesas', 'noma-brownie', 'brownie-com-sorvete', 'Brownie com sorvete',
      'Chocolate e sorvete de baunilha.',
      'Brownie de chocolate acompanhado de uma bola de sorvete de baunilha.', 2600, false, 4)
  ) as source(category_key, catalog_key, slug, name, short_description, description,
    price_in_cents, featured, sort_order)
  join public.menu_categories as category
    on category.restaurant_id = noma_id and category.catalog_key = source.category_key
  on conflict (restaurant_id, catalog_key) do nothing;
end;
$$;

commit;
