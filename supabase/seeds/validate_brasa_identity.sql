-- OPCIONAL: ambiente de demonstração, sem alterar produtos, preços ou permissões do NOMA.
begin;
insert into public.restaurants(slug,name,subtitle,theme_primary,theme_background,theme_text,description)
values('brasa','BRASA','Burger House','#8B252A','#FFF8EF','#25201D','Burgers preparados na brasa.')
on conflict(slug) do nothing;
insert into public.restaurant_tables(restaurant_id,table_number)
select id,7 from public.restaurants where slug='brasa' on conflict(restaurant_id,table_number) do nothing;
insert into public.menu_categories(restaurant_id,catalog_key,name,slug,sort_order,active)
select id,'brasa-burgers','Búrgueres','burgueres',10,true from public.restaurants where slug='brasa'
on conflict(restaurant_id,slug) do nothing;
insert into public.menu_products(restaurant_id,category_id,catalog_key,slug,name,short_description,description,price_in_cents,available,featured,sort_order)
select r.id,c.id,'brasa-duplo','brasa-duplo','Brasa Duplo','Duas carnes, cheddar e molho da casa.',
 'Pão brioche com dois hambúrgueres, queijo cheddar e molho da casa.',4200,true,true,10
from public.restaurants r join public.menu_categories c on c.restaurant_id=r.id and c.slug='burgueres'
where r.slug='brasa' on conflict(restaurant_id,slug) do nothing;
commit;
