begin;

-- ============================================================================
-- 1. NOVAS COLUNAS DE PLANOS SAAS EM public.restaurants
-- ============================================================================
alter table public.restaurants
  add column if not exists subscription_plan text not null default 'basic' check (subscription_plan in ('basic', 'pro', 'premium')),
  add column if not exists monthly_price_cents integer not null default 9900 check (monthly_price_cents >= 0),
  add column if not exists max_tables integer not null default 10 check (max_tables between 1 and 500);

-- ============================================================================
-- 2. HELPER is_platform_admin
-- ============================================================================
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins as administrator
    where administrator.user_id = auth.uid()
      and administrator.active = true
  );
$$;

revoke all on function public.is_platform_admin() from public, anon, authenticated;
grant execute on function public.is_platform_admin() to authenticated;

-- ============================================================================
-- 3. ATUALIZAÇÃO DA RPC list_platform_restaurants COM CAMPOS DE PLANO E MESAS
-- ============================================================================
create or replace function public.list_platform_restaurants()
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
          'archivedAt', restaurant.archived_at,
          'createdAt', restaurant.created_at,
          'adminCount', (
            select count(*)
            from public.restaurant_members as member
            where member.restaurant_id = restaurant.id
              and member.role = 'admin'
              and member.active = true
          ),
          'subscriptionPlan', restaurant.subscription_plan,
          'subscription_plan', restaurant.subscription_plan,
          'monthlyPriceCents', restaurant.monthly_price_cents,
          'monthly_price_cents', restaurant.monthly_price_cents,
          'maxTables', restaurant.max_tables,
          'max_tables', restaurant.max_tables,
          'activeTablesCount', (
            select count(*)
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
          ),
          'active_tables_count', (
            select count(*)
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
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

revoke all on function public.list_platform_restaurants() from public, anon, authenticated;
grant execute on function public.list_platform_restaurants() to authenticated;

-- ============================================================================
-- 4. RPC update_restaurant_saas_plan (EXCLUSIVA PARA SUPERADMIN)
-- ============================================================================
create or replace function public.update_restaurant_saas_plan(
  p_restaurant_id uuid,
  p_plan text,
  p_monthly_price_cents integer default null,
  p_max_tables integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan text;
  v_price integer;
  v_max_tables integer;
  v_updated record;
begin
  perform public.require_platform_admin();

  if p_restaurant_id is null then
    raise exception 'Restaurante não informado.' using errcode = '22023';
  end if;

  v_plan := lower(btrim(p_plan));
  if v_plan not in ('basic', 'pro', 'premium') then
    raise exception 'Plano inválido. Escolha entre basic, pro ou premium.' using errcode = '22023';
  end if;

  -- Se p_monthly_price_cents ou p_max_tables não forem informados, aplique os padrões do plano:
  -- basic: 9900 (R$ 99,00) e 10 mesas
  -- pro: 14900 (R$ 149,00) e 25 mesas
  -- premium: 19900 (R$ 199,00) e 100 mesas
  if p_monthly_price_cents is not null then
    if p_monthly_price_cents < 0 then
      raise exception 'Valor mensal não pode ser negativo.' using errcode = '22023';
    end if;
    v_price := p_monthly_price_cents;
  else
    if v_plan = 'basic' then
      v_price := 9900;
    elsif v_plan = 'pro' then
      v_price := 14900;
    else
      v_price := 19900;
    end if;
  end if;

  if p_max_tables is not null then
    if p_max_tables not between 1 and 500 then
      raise exception 'Limite de mesas deve ser entre 1 e 500.' using errcode = '22023';
    end if;
    v_max_tables := p_max_tables;
  else
    if v_plan = 'basic' then
      v_max_tables := 10;
    elsif v_plan = 'pro' then
      v_max_tables := 25;
    else
      v_max_tables := 100;
    end if;
  end if;

  update public.restaurants
  set
    subscription_plan = v_plan,
    monthly_price_cents = v_price,
    max_tables = v_max_tables
  where id = p_restaurant_id
  returning * into v_updated;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'id', v_updated.id,
    'name', v_updated.name,
    'slug', v_updated.slug,
    'active', v_updated.active,
    'archivedAt', v_updated.archived_at,
    'subscriptionPlan', v_updated.subscription_plan,
    'subscription_plan', v_updated.subscription_plan,
    'monthlyPriceCents', v_updated.monthly_price_cents,
    'monthly_price_cents', v_updated.monthly_price_cents,
    'maxTables', v_updated.max_tables,
    'max_tables', v_updated.max_tables,
    'activeTablesCount', (
      select count(*)
      from public.restaurant_tables as t
      where t.restaurant_id = v_updated.id
    ),
    'active_tables_count', (
      select count(*)
      from public.restaurant_tables as t
      where t.restaurant_id = v_updated.id
    )
  );
end;
$$;

revoke all on function public.update_restaurant_saas_plan(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.update_restaurant_saas_plan(uuid, text, integer, integer) to authenticated;

-- ============================================================================
-- 5. TRIGGER DE ENFORCEMENT DE LIMITE DE MESAS POR PLANO (BEFORE INSERT)
-- ============================================================================
create or replace function public.enforce_restaurant_tables_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_tables integer;
  v_count integer;
begin
  -- Se o número da mesa já existe para o restaurante, não é uma nova mesa (ex: on conflict do update/nothing)
  if exists (
    select 1
    from public.restaurant_tables as existing_table
    where existing_table.restaurant_id = new.restaurant_id
      and existing_table.table_number = new.table_number
  ) then
    return new;
  end if;

  select r.max_tables
  into v_max_tables
  from public.restaurants as r
  where r.id = new.restaurant_id
  for update;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  select count(*)
  into v_count
  from public.restaurant_tables
  where restaurant_id = new.restaurant_id;

  if v_count >= v_max_tables then
    raise exception 'Limite de % mesas do plano atual atingido. Solicite o upgrade do plano à administração da plataforma.', v_max_tables
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_restaurant_tables_plan_limit on public.restaurant_tables;
create trigger trg_enforce_restaurant_tables_plan_limit
  before insert on public.restaurant_tables
  for each row
  execute function public.enforce_restaurant_tables_plan_limit();

-- View de compatibilidade com dining_tables
create or replace view public.dining_tables as
  select * from public.restaurant_tables;

notify pgrst, 'reload schema';

commit;
