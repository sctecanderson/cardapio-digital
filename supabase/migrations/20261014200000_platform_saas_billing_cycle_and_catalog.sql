begin;

-- ============================================================================
-- 1. CICLO DE VIGÊNCIA DA ASSINATURA EM public.restaurants
-- ============================================================================
alter table public.restaurants
  add column if not exists subscription_started_at timestamptz not null default timezone('utc', now()),
  add column if not exists subscription_expires_at timestamptz not null default (timezone('utc', now()) + interval '30 days'),
  add column if not exists billing_cycle_days integer not null default 30 check (billing_cycle_days between 1 and 365);

-- ============================================================================
-- 2. CATÁLOGO GLOBAL DE PLANOS EDITÁVEL EM public.platform_settings
-- ============================================================================
alter table public.platform_settings
  add column if not exists basic_price_cents integer not null default 9900 check (basic_price_cents >= 0),
  add column if not exists basic_max_tables integer not null default 10 check (basic_max_tables between 1 and 500),
  add column if not exists pro_price_cents integer not null default 14900 check (pro_price_cents >= 0),
  add column if not exists pro_max_tables integer not null default 25 check (pro_max_tables between 1 and 500),
  add column if not exists premium_price_cents integer not null default 19900 check (premium_price_cents >= 0),
  add column if not exists premium_max_tables integer not null default 100 check (premium_max_tables between 1 and 500);

-- Garantir que o registro 'default' possua os valores definidos
update public.platform_settings
set
  basic_price_cents = coalesce(basic_price_cents, 9900),
  basic_max_tables = coalesce(basic_max_tables, 10),
  pro_price_cents = coalesce(pro_price_cents, 14900),
  pro_max_tables = coalesce(pro_max_tables, 25),
  premium_price_cents = coalesce(premium_price_cents, 19900),
  premium_max_tables = coalesce(premium_max_tables, 100)
where id = 'default';

-- ============================================================================
-- 3. RPC public.update_platform_plan_catalog(...)
-- ============================================================================
create or replace function public.update_platform_plan_catalog(
  p_basic_price_cents integer,
  p_basic_max_tables integer,
  p_pro_price_cents integer,
  p_pro_max_tables integer,
  p_premium_price_cents integer,
  p_premium_max_tables integer,
  p_sync_existing_restaurants boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_synced_count integer := 0;
begin
  perform public.require_platform_admin();

  if p_basic_price_cents is null or p_basic_price_cents < 0 or
     p_pro_price_cents is null or p_pro_price_cents < 0 or
     p_premium_price_cents is null or p_premium_price_cents < 0 then
    raise exception 'Preços dos planos não podem ser negativos ou nulos.' using errcode = '22023';
  end if;

  if p_basic_max_tables not between 1 and 500 or
     p_pro_max_tables not between 1 and 500 or
     p_premium_max_tables not between 1 and 500 then
    raise exception 'Limite de mesas deve estar entre 1 e 500.' using errcode = '22023';
  end if;

  update public.platform_settings
  set
    basic_price_cents = p_basic_price_cents,
    basic_max_tables = p_basic_max_tables,
    pro_price_cents = p_pro_price_cents,
    pro_max_tables = p_pro_max_tables,
    premium_price_cents = p_premium_price_cents,
    premium_max_tables = p_premium_max_tables,
    updated_at = timezone('utc', now())
  where id = 'default';

  if p_sync_existing_restaurants is true then
    with updated_basic as (
      update public.restaurants
      set monthly_price_cents = p_basic_price_cents,
          max_tables = p_basic_max_tables
      where subscription_plan = 'basic'
      returning 1
    ),
    updated_pro as (
      update public.restaurants
      set monthly_price_cents = p_pro_price_cents,
          max_tables = p_pro_max_tables
      where subscription_plan = 'pro'
      returning 1
    ),
    updated_premium as (
      update public.restaurants
      set monthly_price_cents = p_premium_price_cents,
          max_tables = p_premium_max_tables
      where subscription_plan = 'premium'
      returning 1
    )
    select (
      (select count(*) from updated_basic) +
      (select count(*) from updated_pro) +
      (select count(*) from updated_premium)
    ) into v_synced_count;
  end if;

  return jsonb_build_object(
    'success', true,
    'basicPriceCents', p_basic_price_cents,
    'basicMaxTables', p_basic_max_tables,
    'proPriceCents', p_pro_price_cents,
    'proMaxTables', p_pro_max_tables,
    'premiumPriceCents', p_premium_price_cents,
    'premiumMaxTables', p_premium_max_tables,
    'syncedRestaurantsCount', v_synced_count
  );
end;
$$;

revoke all on function public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean) to authenticated;

-- ============================================================================
-- 4. ATUALIZAR get_platform_branding() PARA RETORNAR O CATÁLOGO DE PLANOS
-- ============================================================================
create or replace function public.get_platform_branding()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings record;
begin
  select *
  into v_settings
  from public.platform_settings
  where id = 'default';

  if not found then
    return jsonb_build_object(
      'platformName', 'Elozi',
      'platformSubtitle', 'Administração da Plataforma',
      'platformLogoUrl', null,
      'superadminName', 'SuperAdmin',
      'superadminAvatarUrl', null,
      'updatedAt', timezone('utc', now()),
      'basicPriceCents', 9900,
      'basic_price_cents', 9900,
      'basicMaxTables', 10,
      'basic_max_tables', 10,
      'proPriceCents', 14900,
      'pro_price_cents', 14900,
      'proMaxTables', 25,
      'pro_max_tables', 25,
      'premiumPriceCents', 19900,
      'premium_price_cents', 19900,
      'premiumMaxTables', 100,
      'premium_max_tables', 100
    );
  end if;

  return jsonb_build_object(
    'platformName', v_settings.platform_name,
    'platformSubtitle', v_settings.platform_subtitle,
    'platformLogoUrl', v_settings.platform_logo_url,
    'superadminName', v_settings.superadmin_name,
    'superadminAvatarUrl', v_settings.superadmin_avatar_url,
    'updatedAt', v_settings.updated_at,
    'basicPriceCents', coalesce(v_settings.basic_price_cents, 9900),
    'basic_price_cents', coalesce(v_settings.basic_price_cents, 9900),
    'basicMaxTables', coalesce(v_settings.basic_max_tables, 10),
    'basic_max_tables', coalesce(v_settings.basic_max_tables, 10),
    'proPriceCents', coalesce(v_settings.pro_price_cents, 14900),
    'pro_price_cents', coalesce(v_settings.pro_price_cents, 14900),
    'proMaxTables', coalesce(v_settings.pro_max_tables, 25),
    'pro_max_tables', coalesce(v_settings.pro_max_tables, 25),
    'premiumPriceCents', coalesce(v_settings.premium_price_cents, 19900),
    'premium_price_cents', coalesce(v_settings.premium_price_cents, 19900),
    'premiumMaxTables', coalesce(v_settings.premium_max_tables, 100),
    'premium_max_tables', coalesce(v_settings.premium_max_tables, 100)
  );
end;
$$;

revoke all on function public.get_platform_branding() from public, anon, authenticated;
grant execute on function public.get_platform_branding() to authenticated, anon;

-- ============================================================================
-- 5. ATUALIZAR list_platform_restaurants() COM DATAS E DIAS RESTANTES
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
          ),
          'subscriptionStartedAt', restaurant.subscription_started_at,
          'subscription_started_at', restaurant.subscription_started_at,
          'subscriptionExpiresAt', restaurant.subscription_expires_at,
          'subscription_expires_at', restaurant.subscription_expires_at,
          'billingCycleDays', restaurant.billing_cycle_days,
          'billing_cycle_days', restaurant.billing_cycle_days,
          'daysRemaining', ceil(extract(epoch from (restaurant.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
          'days_remaining', ceil(extract(epoch from (restaurant.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int
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
-- 6. ATUALIZAR update_restaurant_saas_plan(...) COM PREÇOS LIVRES E DIAS
-- ============================================================================
drop function if exists public.update_restaurant_saas_plan(uuid, text, integer, integer);

create or replace function public.update_restaurant_saas_plan(
  p_restaurant_id uuid,
  p_plan text,
  p_monthly_price_cents integer default null,
  p_max_tables integer default null,
  p_billing_cycle_days integer default null,
  p_renew_cycle boolean default false
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
  v_default_price integer;
  v_default_max_tables integer;
  v_current_cycle_days integer;
  v_current_started_at timestamptz;
  v_current_expires_at timestamptz;
  v_cycle_days integer;
  v_started_at timestamptz;
  v_expires_at timestamptz;
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

  -- Buscar dados atuais do restaurante
  select
    r.billing_cycle_days,
    r.subscription_started_at,
    r.subscription_expires_at
  into
    v_current_cycle_days,
    v_current_started_at,
    v_current_expires_at
  from public.restaurants as r
  where r.id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = 'P0002';
  end if;

  -- Buscar valores padrão do catálogo global em platform_settings
  select
    case v_plan
      when 'basic' then coalesce(ps.basic_price_cents, 9900)
      when 'pro' then coalesce(ps.pro_price_cents, 14900)
      else coalesce(ps.premium_price_cents, 19900)
    end,
    case v_plan
      when 'basic' then coalesce(ps.basic_max_tables, 10)
      when 'pro' then coalesce(ps.pro_max_tables, 25)
      else coalesce(ps.premium_max_tables, 100)
    end
  into
    v_default_price,
    v_default_max_tables
  from public.platform_settings as ps
  where ps.id = 'default';

  if not found then
    if v_plan = 'basic' then
      v_default_price := 9900;
      v_default_max_tables := 10;
    elsif v_plan = 'pro' then
      v_default_price := 14900;
      v_default_max_tables := 25;
    else
      v_default_price := 19900;
      v_default_max_tables := 100;
    end if;
  end if;

  if p_monthly_price_cents is not null then
    if p_monthly_price_cents < 0 then
      raise exception 'Valor mensal não pode ser negativo.' using errcode = '22023';
    end if;
    v_price := p_monthly_price_cents;
  else
    v_price := v_default_price;
  end if;

  if p_max_tables is not null then
    if p_max_tables not between 1 and 500 then
      raise exception 'Limite de mesas deve ser entre 1 e 500.' using errcode = '22023';
    end if;
    v_max_tables := p_max_tables;
  else
    v_max_tables := v_default_max_tables;
  end if;

  v_cycle_days := coalesce(p_billing_cycle_days, v_current_cycle_days, 30);
  if v_cycle_days not between 1 and 365 then
    raise exception 'Ciclo de cobrança deve ser entre 1 e 365 dias.' using errcode = '22023';
  end if;

  if p_renew_cycle is true or p_billing_cycle_days is not null then
    v_started_at := timezone('utc', now());
    v_expires_at := timezone('utc', now()) + (v_cycle_days || ' days')::interval;
  else
    v_started_at := coalesce(v_current_started_at, timezone('utc', now()));
    v_expires_at := coalesce(v_current_expires_at, timezone('utc', now()) + (v_cycle_days || ' days')::interval);
  end if;

  update public.restaurants
  set
    subscription_plan = v_plan,
    monthly_price_cents = v_price,
    max_tables = v_max_tables,
    billing_cycle_days = v_cycle_days,
    subscription_started_at = v_started_at,
    subscription_expires_at = v_expires_at
  where id = p_restaurant_id
  returning
    id,
    name,
    slug,
    subscription_plan,
    monthly_price_cents,
    max_tables,
    billing_cycle_days,
    subscription_started_at,
    subscription_expires_at
  into v_updated;

  return jsonb_build_object(
    'id', v_updated.id,
    'name', v_updated.name,
    'slug', v_updated.slug,
    'subscriptionPlan', v_updated.subscription_plan,
    'subscription_plan', v_updated.subscription_plan,
    'monthlyPriceCents', v_updated.monthly_price_cents,
    'monthly_price_cents', v_updated.monthly_price_cents,
    'maxTables', v_updated.max_tables,
    'max_tables', v_updated.max_tables,
    'billingCycleDays', v_updated.billing_cycle_days,
    'billing_cycle_days', v_updated.billing_cycle_days,
    'subscriptionStartedAt', v_updated.subscription_started_at,
    'subscription_started_at', v_updated.subscription_started_at,
    'subscriptionExpiresAt', v_updated.subscription_expires_at,
    'subscription_expires_at', v_updated.subscription_expires_at,
    'daysRemaining', ceil(extract(epoch from (v_updated.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
    'days_remaining', ceil(extract(epoch from (v_updated.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
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

revoke all on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) to authenticated;

commit;
