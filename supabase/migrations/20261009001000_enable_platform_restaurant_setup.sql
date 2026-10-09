begin;

-- Permite que um administrador da Elozi assuma a configuração
-- de um restaurante ativo.
create function public.assume_platform_restaurant_setup(
  p_restaurant_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  member_id uuid;
begin
  current_user_id := public.require_platform_admin();

  perform restaurant.id
  from public.restaurants as restaurant
  where restaurant.id = p_restaurant_id
    and restaurant.active = true
  for share;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Restaurante não encontrado ou desativado.';
  end if;

  insert into public.restaurant_members (
    restaurant_id,
    user_id,
    role,
    active
  )
  values (
    p_restaurant_id,
    current_user_id,
    'admin',
    true
  )
  on conflict (restaurant_id, user_id)
  do update set
    role = 'admin',
    active = true
  returning id into member_id;

  return member_id;
end;
$$;

revoke all
  on function public.assume_platform_restaurant_setup(uuid)
  from public, anon, authenticated;

grant execute
  on function public.assume_platform_restaurant_setup(uuid)
  to authenticated;

-- Atualiza o cadastro existente para incluir o vínculo
-- do administrador que realiza a configuração.
create or replace function public.create_platform_restaurant(
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
  else
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
  end if;

  -- Se o vínculo falhar, o cadastro novo também é desfeito.
  perform public.assume_platform_restaurant_setup(p_id);

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

revoke all
  on function public.create_platform_restaurant(uuid, text, text)
  from public, anon, authenticated;

grant execute
  on function public.create_platform_restaurant(uuid, text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;