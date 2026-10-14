-- ============================================================================
-- BLOCO 12: GOVERNANÇA OPERACIONAL, PAYWALL DE INADIMPLÊNCIA, AUDITORIA
-- E TRAVAS DE VIGÊNCIA SAAS
-- ============================================================================

begin;

-- ============================================================================
-- 1. FUNÇÃO AUXILIAR DE STATUS DE VIGÊNCIA (BILLING STATUS)
-- ============================================================================
create or replace function public.get_restaurant_billing_status(p_expires_at timestamptz)
returns text
language sql
stable
as $$
  select case
    when p_expires_at is null then 'active'
    when p_expires_at >= timezone('utc', now()) then 'active'
    when p_expires_at >= (timezone('utc', now()) - interval '3 days') then 'grace_period'
    else 'expired'
  end;
$$;

revoke all on function public.get_restaurant_billing_status(timestamptz) from public;
grant execute on function public.get_restaurant_billing_status(timestamptz) to anon, authenticated;

-- ============================================================================
-- 2. TABELA DE AUDITORIA: public.platform_audit_logs
-- ============================================================================
create table if not exists public.platform_audit_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in (
    'plan_changed',
    'cycle_renewed',
    'table_deleted',
    'restaurant_suspended',
    'restaurant_restored',
    'catalog_updated',
    'branding_updated'
  )),
  target_restaurant_id uuid references public.restaurants(id) on delete set null,
  target_restaurant_name text,
  actor_email text not null default 'superadmin',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists platform_audit_logs_created_at_idx
  on public.platform_audit_logs (created_at desc);

create index if not exists platform_audit_logs_target_restaurant_idx
  on public.platform_audit_logs (target_restaurant_id);

-- RLS: Apenas SuperAdmin pode ler; sem deleção (insert/select only)
alter table public.platform_audit_logs enable row level security;

drop policy if exists platform_audit_logs_read on public.platform_audit_logs;
create policy platform_audit_logs_read on public.platform_audit_logs
  for select
  to authenticated
  using (public.is_platform_admin());

drop policy if exists platform_audit_logs_insert on public.platform_audit_logs;
create policy platform_audit_logs_insert on public.platform_audit_logs
  for insert
  to authenticated
  with check (public.is_platform_admin());

revoke all on public.platform_audit_logs from public, anon;
grant select, insert on public.platform_audit_logs to authenticated;

-- ============================================================================
-- 3. RPC public.list_platform_audit_logs
-- ============================================================================
create or replace function public.list_platform_audit_logs(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  perform public.require_platform_admin();

  v_limit := coalesce(p_limit, 50);
  if v_limit < 1 then v_limit := 50; end if;
  if v_limit > 500 then v_limit := 500; end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', l.id,
          'action', l.action,
          'targetRestaurantId', l.target_restaurant_id,
          'target_restaurant_id', l.target_restaurant_id,
          'targetRestaurantName', coalesce(l.target_restaurant_name, r.name, 'Plataforma'),
          'target_restaurant_name', coalesce(l.target_restaurant_name, r.name, 'Plataforma'),
          'actorEmail', l.actor_email,
          'actor_email', l.actor_email,
          'details', l.details,
          'createdAt', l.created_at,
          'created_at', l.created_at
        )
        order by l.created_at desc
      )
      from (
        select *
        from public.platform_audit_logs
        order by created_at desc
        limit v_limit
      ) as l
      left join public.restaurants as r on r.id = l.target_restaurant_id
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.list_platform_audit_logs(integer) from public, anon;
grant execute on function public.list_platform_audit_logs(integer) to authenticated;

-- ============================================================================
-- 4. ATUALIZAR open_table_visit COM TRAVA DE INADIMPLÊNCIA / EXPIRED
-- ============================================================================
create or replace function public.open_table_visit(
  p_restaurant_slug text,
  p_table_number integer
)
returns public.table_visits
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_table_id uuid;
  target_visit public.table_visits%rowtype;
  v_max_tables integer;
  v_subscription_expires_at timestamptz;
begin
  current_user_id := auth.uid();

  if current_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'Entre com sua conta para atender uma mesa.';
  end if;

  if p_table_number is null
    or p_table_number < 1
    or p_table_number > 999
  then
    raise exception using
      errcode = '22023',
      message = 'Número de mesa inválido.';
  end if;

  -- Manter o restaurante ativo durante a operação.
  select
    restaurant.id,
    restaurant.max_tables,
    restaurant.subscription_expires_at
  into
    target_restaurant_id,
    v_max_tables,
    v_subscription_expires_at
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  -- 1.1 Trava de Inadimplência / Expiração:
  -- Se o restaurante estiver vencido há mais de 3 dias (expired), bloquear.
  -- Se estiver dentro da tolerância de até 3 dias (grace_period), permite normalmente.
  if v_subscription_expires_at is not null
     and v_subscription_expires_at < (timezone('utc', now()) - interval '3 days') then
    raise exception using
      errcode = 'P0001',
      message = 'A assinatura deste estabelecimento está suspensa por expiração do ciclo. Entre em contato com a administração da plataforma para regularização.';
  end if;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  if p_table_number > v_max_tables then
    raise exception using
      errcode = 'P0001',
      message = 'Mesa indisponível no plano atual do restaurante.';
  end if;

  -- Identificar o funcionário pela sessão.
  select member.id
  into target_member_id
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if target_member_id is null then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  -- Serializar operações de abertura para esta mesa (exige ativa e não excluída).
  select restaurant_table.id
  into target_table_id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
    and (restaurant_table.active = true and restaurant_table.is_active = true)
    and restaurant_table.deleted_at is null
  for update;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Mesa inexistente ou indisponível.';
  end if;

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.restaurant_table_id = target_table_id
    and visit.status = 'open'
  for update;

  if found then
    if target_visit.assigned_member_id is null then
      update public.table_visits
      set assigned_member_id = target_member_id
      where id = target_visit.id
      returning * into target_visit;

    elsif target_visit.assigned_member_id <> target_member_id then
      raise exception using
        errcode = '22023',
        message = 'A mesa já possui atendimento atribuído a outro colaborador.';
    end if;

    return target_visit;
  end if;

  insert into public.table_visits (
    restaurant_id,
    restaurant_table_id,
    assigned_member_id,
    status
  ) values (
    target_restaurant_id,
    target_table_id,
    target_member_id,
    'open'
  )
  returning * into target_visit;

  return target_visit;
end;
$$;

revoke all on function public.open_table_visit(text, integer) from public, anon;
grant execute on function public.open_table_visit(text, integer) to authenticated;

-- ============================================================================
-- 5. ATUALIZAR update_restaurant_saas_plan COM REGISTRO DE AUDITORIA
-- ============================================================================
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
  v_old record;
  v_cycle_days integer;
  v_started_at timestamptz;
  v_expires_at timestamptz;
  v_updated record;
  v_actor_email text;
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
    r.name,
    r.subscription_plan,
    r.monthly_price_cents,
    r.max_tables,
    r.billing_cycle_days,
    r.subscription_started_at,
    r.subscription_expires_at
  into v_old
  from public.restaurants as r
  where r.id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  -- Buscar catálogo de preços e capacidades padrão
  if v_plan = 'basic' then
    select basic_price_cents, basic_max_tables into v_default_price, v_default_max_tables
    from public.platform_settings where id = 'default';
  elsif v_plan = 'pro' then
    select pro_price_cents, pro_max_tables into v_default_price, v_default_max_tables
    from public.platform_settings where id = 'default';
  else
    select premium_price_cents, premium_max_tables into v_default_price, v_default_max_tables
    from public.platform_settings where id = 'default';
  end if;

  if p_monthly_price_cents is not null then
    if p_monthly_price_cents < 0 then
      raise exception 'Preço mensal não pode ser negativo.' using errcode = '22023';
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

  v_cycle_days := coalesce(p_billing_cycle_days, v_old.billing_cycle_days, 30);
  if v_cycle_days not between 1 and 365 then
    raise exception 'Ciclo de cobrança deve ser entre 1 e 365 dias.' using errcode = '22023';
  end if;

  if p_renew_cycle is true or p_billing_cycle_days is not null then
    v_started_at := timezone('utc', now());
    v_expires_at := timezone('utc', now()) + (v_cycle_days || ' days')::interval;
  else
    v_started_at := coalesce(v_old.subscription_started_at, timezone('utc', now()));
    v_expires_at := coalesce(v_old.subscription_expires_at, timezone('utc', now()) + (v_cycle_days || ' days')::interval);
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

  -- Sincronização automática de mesas ao limite do plano
  perform public.sync_restaurant_tables_to_plan_limit(p_restaurant_id);

  -- Registrar log de auditoria
  v_actor_email := coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), 'superadmin');

  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    case
      when p_renew_cycle is true and v_plan = v_old.subscription_plan then 'cycle_renewed'
      else 'plan_changed'
    end,
    p_restaurant_id,
    v_updated.name,
    v_actor_email,
    jsonb_build_object(
      'previousPlan', v_old.subscription_plan,
      'newPlan', v_updated.subscription_plan,
      'old_plan', v_old.subscription_plan,
      'new_plan', v_updated.subscription_plan,
      'previousPriceCents', v_old.monthly_price_cents,
      'newPriceCents', v_updated.monthly_price_cents,
      'previousMaxTables', v_old.max_tables,
      'newMaxTables', v_updated.max_tables,
      'billingCycleDays', v_updated.billing_cycle_days,
      'renewCycle', coalesce(p_renew_cycle, false)
    )
  );

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
    'activeTablesCount', (
      select count(*)
      from public.restaurant_tables as t
      where t.restaurant_id = v_updated.id
        and (t.active = true or t.is_active = true)
    ),
    'active_tables_count', (
      select count(*)
      from public.restaurant_tables as t
      where t.restaurant_id = v_updated.id
        and (t.active = true or t.is_active = true)
    ),
    'daysRemaining', ceil(extract(epoch from (v_updated.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
    'days_remaining', ceil(extract(epoch from (v_updated.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
    'billingStatus', public.get_restaurant_billing_status(v_updated.subscription_expires_at),
    'billing_status', public.get_restaurant_billing_status(v_updated.subscription_expires_at)
  );
end;
$$;

revoke all on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) from public, anon;
grant execute on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) to authenticated;

-- ============================================================================
-- 6. ATUALIZAR update_platform_plan_catalog COM REGISTRO DE AUDITORIA
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
  r record;
  v_actor_email text;
begin
  perform public.require_platform_admin();

  if p_basic_price_cents is null or p_basic_price_cents < 0 or
     p_pro_price_cents is null or p_pro_price_cents < 0 or
     p_premium_price_cents is null or p_premium_price_cents < 0 then
    raise exception 'Preços dos planos não podem ser negativos ou nulos.' using errcode = '22023';
  end if;

  if p_basic_max_tables is null or p_basic_max_tables not between 1 and 500 or
     p_pro_max_tables is null or p_pro_max_tables not between 1 and 500 or
     p_premium_max_tables is null or p_premium_max_tables not between 1 and 500 then
    raise exception 'Limites de mesas devem ser entre 1 e 500.' using errcode = '22023';
  end if;

  insert into public.platform_settings (
    id,
    basic_price_cents,
    basic_max_tables,
    pro_price_cents,
    pro_max_tables,
    premium_price_cents,
    premium_max_tables,
    updated_at
  ) values (
    'default',
    p_basic_price_cents,
    p_basic_max_tables,
    p_pro_price_cents,
    p_pro_max_tables,
    p_premium_price_cents,
    p_premium_max_tables,
    timezone('utc', now())
  )
  on conflict (id) do update set
    basic_price_cents = excluded.basic_price_cents,
    basic_max_tables = excluded.basic_max_tables,
    pro_price_cents = excluded.pro_price_cents,
    pro_max_tables = excluded.pro_max_tables,
    premium_price_cents = excluded.premium_price_cents,
    premium_max_tables = excluded.premium_max_tables,
    updated_at = timezone('utc', now());

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

    for r in select id from public.restaurants loop
      perform public.sync_restaurant_tables_to_plan_limit(r.id);
    end loop;
  end if;

  -- Registrar log de auditoria
  v_actor_email := coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), 'superadmin');

  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    'catalog_updated',
    null,
    'Catálogo Global',
    v_actor_email,
    jsonb_build_object(
      'basicPriceCents', p_basic_price_cents,
      'basicMaxTables', p_basic_max_tables,
      'proPriceCents', p_pro_price_cents,
      'proMaxTables', p_pro_max_tables,
      'premiumPriceCents', p_premium_price_cents,
      'premiumMaxTables', p_premium_max_tables,
      'syncExistingRestaurants', coalesce(p_sync_existing_restaurants, false),
      'syncedRestaurantsCount', v_synced_count
    )
  );

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

revoke all on function public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean) from public, anon;
grant execute on function public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean) to authenticated;

-- ============================================================================
-- 7. ATUALIZAR delete_restaurant_table COM REGISTRO DE AUDITORIA
-- ============================================================================
create or replace function public.delete_restaurant_table(
  p_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  v_restaurant_name text;
  v_table public.restaurant_tables%rowtype;
  v_actor_email text;
  v_soft_deleted boolean := false;
begin
  rid := public.require_catalog_admin(p_slug);

  select name into v_restaurant_name
  from public.restaurants
  where id = rid;

  if p_table_number is null or p_table_number < 1 then
    raise exception 'Número de mesa inválido.' using errcode = '22023';
  end if;

  select *
  into v_table
  from public.restaurant_tables
  where restaurant_id = rid
    and table_number = p_table_number
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Mesa % não encontrada.', p_table_number using errcode = '22023';
  end if;

  -- 1. Se houver atendimento aberto, proibir exclusão
  if exists (
    select 1 from public.table_visits
    where restaurant_table_id = v_table.id
      and status = 'open'
  ) then
    raise exception 'Mesa com atendimento ativo. Feche a comanda antes de excluir.'
      using errcode = 'P0001';
  end if;

  -- 2. Exclusão segura: tenta hard delete; se violar integridade referencial com
  -- atendimentos ou sessões históricas já encerradas, aplica arquivamento (soft-delete).
  begin
    delete from public.restaurant_tables where id = v_table.id;
  exception when foreign_key_violation or restrict_violation or sqlstate '23001' or sqlstate '23503' then
    update public.restaurant_tables
    set deleted_at = timezone('utc', now()),
        active = false,
        is_active = false
    where id = v_table.id;
    v_soft_deleted := true;
  end;

  -- 3. Promover automaticamente a próxima mesa bloqueada pelo plano para ativa
  perform public.sync_restaurant_tables_to_plan_limit(rid);

  -- 4. Gravar log de auditoria
  v_actor_email := coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), 'admin');

  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    'table_deleted',
    rid,
    v_restaurant_name,
    v_actor_email,
    jsonb_build_object(
      'tableNumber', p_table_number,
      'table_number', p_table_number,
      'tableId', v_table.id,
      'label', v_table.label,
      'softDeleted', v_soft_deleted
    )
  );

  return jsonb_build_object(
    'success', true,
    'tableNumber', p_table_number,
    'tableId', v_table.id
  );
end;
$$;

revoke all on function public.delete_restaurant_table(text, integer) from public, anon;
grant execute on function public.delete_restaurant_table(text, integer) to authenticated;

-- ============================================================================
-- 8. ATUALIZAR list_platform_restaurants COM billingStatus E adminEmails
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
          'adminEmails', coalesce(
            (
              select jsonb_agg(u.email)
              from public.restaurant_members as member
              join auth.users as u on u.id = member.user_id
              where member.restaurant_id = restaurant.id
                and member.role = 'admin'
                and member.active = true
                and u.email is not null
            ),
            '[]'::jsonb
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
              and t.deleted_at is null
              and (t.active = true or t.is_active = true)
          ),
          'active_tables_count', (
            select count(*)
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
              and t.deleted_at is null
              and (t.active = true or t.is_active = true)
          ),
          'subscriptionStartedAt', restaurant.subscription_started_at,
          'subscription_started_at', restaurant.subscription_started_at,
          'subscriptionExpiresAt', restaurant.subscription_expires_at,
          'subscription_expires_at', restaurant.subscription_expires_at,
          'billingCycleDays', restaurant.billing_cycle_days,
          'billing_cycle_days', restaurant.billing_cycle_days,
          'daysRemaining', ceil(extract(epoch from (restaurant.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
          'days_remaining', ceil(extract(epoch from (restaurant.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int,
          'billingStatus', public.get_restaurant_billing_status(restaurant.subscription_expires_at),
          'billing_status', public.get_restaurant_billing_status(restaurant.subscription_expires_at)
        )
        order by restaurant.created_at desc, restaurant.id
      )
      from public.restaurants as restaurant
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.list_platform_restaurants() from public, anon;
grant execute on function public.list_platform_restaurants() to authenticated;

-- ============================================================================
-- 9. ATUALIZAR get_public_restaurant COM billingStatus
-- ============================================================================
create or replace function public.get_public_restaurant(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'slug', r.slug,
    'name', r.name,
    'subtitle', coalesce(r.subtitle, ''),
    'logo', r.logo,
    'cover', r.cover,
    'theme', jsonb_build_object(
      'primary', r.theme_primary,
      'background', r.theme_background,
      'text', r.theme_text
    ),
    'description', r.description,
    'address', r.address,
    'phone', r.phone,
    'openingHours', r.opening_hours,
    'revision', r.revision,
    'serviceFeePercent', r.service_fee_percent,
    'timezone', r.timezone,
    'googleReviewUrl', r.google_review_url,
    'subscriptionPlan', r.subscription_plan,
    'subscription_plan', r.subscription_plan,
    'maxTables', coalesce(r.max_tables, 10),
    'max_tables', coalesce(r.max_tables, 10),
    'subscriptionExpiresAt', r.subscription_expires_at,
    'subscription_expires_at', r.subscription_expires_at,
    'billingStatus', public.get_restaurant_billing_status(r.subscription_expires_at),
    'billing_status', public.get_restaurant_billing_status(r.subscription_expires_at)
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

notify pgrst, 'reload schema';

commit;
