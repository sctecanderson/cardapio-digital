begin;

insert into public.restaurants (
  slug,
  name,
  subtitle
)
values
  ('noma', 'NOMA', 'Kitchen & Bar'),
  ('brasa', 'BRASA', 'Burger House')
on conflict (slug) do nothing;

insert into public.restaurant_tables (
  restaurant_id,
  table_number
)
select
  id,
  7
from public.restaurants
where slug in ('noma', 'brasa')
on conflict (restaurant_id, table_number) do nothing;

commit;