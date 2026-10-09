begin;

create function public.create_platform_restaurant(
  p_id uuid,
  p_name text,
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_name text;
  normalized_slug text;
  existing_restaurant public.restaurants%rowtype;
begin
  perform public.require_platform_admin();

  normalized_name := btrim(p_name);
  normalized_slug := lower(btrim(p_slug));

  if p_id is null
    or normalized_name is null
    or char_length(normalized_name) not between 1 and 120
    or normalized_slug is null
    or char_length(normalized_slug) not between 3 and 80
    or normalized_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  then
    raise exception using
      errcode = '22023',
      message = 'Informe nome e endereço válidos para o restaurante.';
  end if;

  if normalized_slug in (
    'plataforma', 'admin', 'api', 'auth'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Esse endereço está reservado. Escolha outro.';
  end if;

  -- Permite repetir uma requisição sem duplicar o cadastro.
  select *
  into existing_restaurant
  from public.restaurants
  where id = p_id
  for share;

  if found then
    if existing_restaurant.slug <> normalized_slug
      or existing_restaurant.name <> normalized_name
    then
      raise exception using
        errcode = '22023',
        message = 'Este cadastro já existe com outros dados.';
    end if;

    return jsonb_build_object(
      'id', existing_restaurant.id,
      'name', existing_restaurant.name,
      'slug', existing_restaurant.slug
    );
  end if;

  insert into public.restaurants (
    id,
    name,
    slug,
    subtitle,
    active
  )
  values (
    p_id,
    normalized_name,
    normalized_slug,
    '',
    true
  );

  return jsonb_build_object(
    'id', p_id,
    'name', normalized_name,
    'slug', normalized_slug
  );

exception
  when unique_violation then
    raise exception using
      errcode = '22023',
      message = 'Esse cadastro ou endereço já existe. Atualize a lista.';
end;
$$;

create function public.list_platform_restaurants()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.require_platform_admin();

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', restaurant.id,
          'name', restaurant.name,
          'slug', restaurant.slug,
          'active', restaurant.active,
          'createdAt', restaurant.created_at,
          'adminCount', (
            select count(*)
            from public.restaurant_members as member
            where member.restaurant_id = restaurant.id
              and member.role = 'admin'
              and member.active = true
          )
        )
        order by restaurant.created_at desc, restaurant.id
      )
      from public.restaurants as restaurant
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all
  on function public.create_platform_restaurant(uuid, text, text)
  from public, anon, authenticated;

revoke all
  on function public.list_platform_restaurants()
  from public, anon, authenticated;

grant execute
  on function public.create_platform_restaurant(uuid, text, text)
  to authenticated;

grant execute
  on function public.list_platform_restaurants()
  to authenticated;

notify pgrst, 'reload schema';

commit;