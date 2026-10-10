begin;
alter table public.menu_categories add column revision integer not null default 1;
alter table public.menu_products add column revision integer not null default 1;

-- Toda alteração incrementa a versão, inclusive edições feitas no Table Editor.
create function public.bump_catalog_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.revision := old.revision + 1;
  return new;
end;
$$;
revoke all on function public.bump_catalog_revision() from public, anon, authenticated;
create trigger menu_categories_revision before update on public.menu_categories
  for each row execute function public.bump_catalog_revision();
create trigger menu_products_revision before update on public.menu_products
  for each row execute function public.bump_catalog_revision();

create function public.require_catalog_admin(p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare target_restaurant_id uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean, false) then
    raise exception using errcode='42501', message='Entre com uma conta de administrador.';
  end if;
  select r.id into target_restaurant_id from public.restaurants r
    where r.slug=p_slug and r.active for share;
  if not found then raise exception using errcode='42501', message='Restaurante indisponível.'; end if;
  perform m.id from public.restaurant_members m where m.restaurant_id=target_restaurant_id
    and m.user_id=auth.uid() and m.active and m.role='admin' for share;
  if not found then raise exception using errcode='42501', message='Acesso exclusivo do administrador deste restaurante.'; end if;
  return target_restaurant_id;
end;
$$;
revoke all on function public.require_catalog_admin(text) from public, anon, authenticated;

create function public.get_admin_catalog(p_slug text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  rid:=public.require_catalog_admin(p_slug);
  return jsonb_build_object(
    'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.id)
      from public.menu_categories c where c.restaurant_id=rid),'[]'::jsonb),
    'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.sort_order,p.id)
      from public.menu_products p where p.restaurant_id=rid),'[]'::jsonb));
end;
$$;

create function public.save_menu_category(p_slug text, p_id uuid, p_revision integer, p_values jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare rid uuid; old_row public.menu_categories%rowtype; v public.menu_categories%rowtype;
begin
  rid:=public.require_catalog_admin(p_slug);
  select * into v from jsonb_populate_record(null::public.menu_categories,p_values);
  if p_id is null or p_revision is null or p_revision<0 or v.name is null
    or char_length(btrim(v.name)) not between 1 and 100 or v.slug is null
    or char_length(v.slug)>120 or v.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or v.sort_order is null or v.sort_order not between 0 and 9999 or v.active is null then
    raise exception using errcode='22023',message='Confira nome, endereço, ordem e visibilidade da categoria.';
  end if;
  select * into old_row from public.menu_categories where id=p_id for update;
  if found then
    if old_row.restaurant_id<>rid then raise exception using errcode='42501',message='Categoria de outro restaurante.'; end if;
    if old_row.revision<>p_revision then raise exception using errcode='40001',message='Esta categoria foi alterada. Atualize a lista e abra a edição novamente.'; end if;
    update public.menu_categories set name=btrim(v.name), sort_order=v.sort_order,
      active=v.active, revision=revision+1 where id=p_id;
  else
    if p_revision<>0 then raise exception using errcode='22023',message='Categoria não encontrada. Atualize a lista.'; end if;
    insert into public.menu_categories(id,restaurant_id,catalog_key,name,slug,sort_order,active)
      values(p_id,rid,p_id::text,btrim(v.name),v.slug,v.sort_order,v.active);
  end if;
  return p_id;
end;
$$;

create function public.save_menu_product(p_slug text, p_id uuid, p_revision integer, p_values jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare rid uuid; old_row public.menu_products%rowtype; v public.menu_products%rowtype;
begin
  rid:=public.require_catalog_admin(p_slug);
  select * into v from jsonb_populate_record(null::public.menu_products,p_values);
  if p_id is null or p_revision is null or p_revision<0 or v.name is null
    or char_length(btrim(v.name)) not between 1 and 120 or v.slug is null
    or char_length(v.slug)>120 or v.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or v.short_description is null or char_length(v.short_description)>240
    or v.description is null or char_length(v.description)>5000
    or char_length(coalesce(v.dietary_information,''))>1000
    or v.price_in_cents is null or v.price_in_cents not between 0 and 99999999
    or v.sort_order is null or v.sort_order not between 0 and 9999
    or v.available is null or v.featured is null then
    raise exception using errcode='22023',message='Confira os campos do produto, o preço e a ordem.';
  end if;
  perform id from public.menu_categories where id=v.category_id and restaurant_id=rid for share;
  if not found then raise exception using errcode='22023',message='Selecione uma categoria deste restaurante.'; end if;
  select * into old_row from public.menu_products where id=p_id for update;
  if found then
    if old_row.restaurant_id<>rid then raise exception using errcode='42501',message='Produto de outro restaurante.'; end if;
    if old_row.revision<>p_revision then raise exception using errcode='40001',message='Este produto foi alterado. Atualize a lista e abra a edição novamente.'; end if;
    update public.menu_products set category_id=v.category_id,name=btrim(v.name),
      short_description=btrim(v.short_description),description=btrim(v.description),
      price_in_cents=v.price_in_cents,available=v.available,featured=v.featured,
      sort_order=v.sort_order,dietary_information=nullif(btrim(v.dietary_information),''),
      revision=revision+1 where id=p_id;
  else
    if p_revision<>0 then raise exception using errcode='22023',message='Produto não encontrado. Atualize a lista.'; end if;
    insert into public.menu_products(id,restaurant_id,category_id,catalog_key,slug,name,
      short_description,description,price_in_cents,available,featured,sort_order,dietary_information)
    values(p_id,rid,v.category_id,p_id::text,v.slug,btrim(v.name),btrim(v.short_description),
      btrim(v.description),v.price_in_cents,v.available,v.featured,v.sort_order,nullif(btrim(v.dietary_information),''));
  end if;
  return p_id;
end;
$$;
revoke all on function public.get_admin_catalog(text) from public,anon,authenticated;
revoke all on function public.save_menu_category(text,uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.save_menu_product(text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.get_admin_catalog(text) to authenticated;
grant execute on function public.save_menu_category(text,uuid,integer,jsonb) to authenticated;
grant execute on function public.save_menu_product(text,uuid,integer,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
