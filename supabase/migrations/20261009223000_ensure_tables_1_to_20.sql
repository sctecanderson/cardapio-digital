begin;

-- Garante que os restaurantes ativos tenham as mesas de 1 a 20 disponíveis no salão
insert into public.restaurant_tables (
  restaurant_id,
  table_number,
  label,
  active
)
select
  r.id,
  g.num,
  'Mesa ' || lpad(g.num::text, 2, '0'),
  true
from public.restaurants r
cross join generate_series(1, 20) as g(num)
where r.active = true
on conflict (restaurant_id, table_number) do update
set active = true;

commit;
