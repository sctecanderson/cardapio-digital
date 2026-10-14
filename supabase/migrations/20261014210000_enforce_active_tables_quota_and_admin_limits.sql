begin;

-- ============================================================================
-- 1. ADICIONAR COLUNA is_active EM public.restaurant_tables E SINCRONIZAR
-- ============================================================================
alter table public.restaurant_tables
  add column if not exists is_active boolean;

update public.restaurant_tables
set is_active = active
where is_active is null;

alter table public.restaurant_tables
  alter column is_active set default true,
  alter column is_active set not null;

-- ============================================================================
-- 2. FUNÇÃO AUXILIAR: public.sync_restaurant_tables_to_plan_limit
-- ============================================================================
create or replace function public.sync_restaurant_tables_to_plan_limit(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_tables integer;
  v_deactivated_count integer := 0;
  v_activated_count integer := 0;
  v_table record;
  v_count integer := 0;
begin
  if p_restaurant_id is null then
    return jsonb_build_object('success', false, 'error', 'ID do restaurante não informado.');
  end if;

  select max_tables into v_max_tables
  from public.restaurants
  where id = p_restaurant_id;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  -- Definir flag para pular a trigger de cota durante a reorganização atômica
  perform set_config('app.skip_plan_limit_check', 'true', true);

  -- 1. Obter todas as mesas ordenando:
  --    Primeiro as que possuem visita/comanda aberta no momento, depois por table_number ASC
  for v_table in
    select
      t.id,
      t.table_number,
      t.active,
      t.is_active,
      exists (
        select 1
        from public.table_visits as v
        where v.restaurant_table_id = t.id
          and v.status = 'open'
      ) as has_open_visit
    from public.restaurant_tables as t
    where t.restaurant_id = p_restaurant_id
    order by
      case when exists (
        select 1
        from public.table_visits as v
        where v.restaurant_table_id = t.id
          and v.status = 'open'
      ) then 0 else 1 end asc,
      t.table_number asc
  loop
    v_count := v_count + 1;

    if v_count <= v_max_tables then
      -- Deve permanecer ou ser ativada
      if not (v_table.active = true and v_table.is_active = true) then
        update public.restaurant_tables
        set active = true, is_active = true
        where id = v_table.id;
        v_activated_count := v_activated_count + 1;
      end if;
    else
      -- Excedente além de max_tables:
      -- Desativar se NÃO tiver visita aberta ativa no instante
      if not v_table.has_open_visit then
        if (v_table.active = true or v_table.is_active = true) then
          update public.restaurant_tables
          set active = false, is_active = false
          where id = v_table.id;
          v_deactivated_count := v_deactivated_count + 1;
        end if;
      end if;
    end if;
  end loop;

  -- Restaurar flag
  perform set_config('app.skip_plan_limit_check', 'false', true);

  return jsonb_build_object(
    'success', true,
    'maxTables', v_max_tables,
    'activatedCount', v_activated_count,
    'deactivatedCount', v_deactivated_count
  );
end;
$$;

revoke all on function public.sync_restaurant_tables_to_plan_limit(uuid) from public, anon;
grant execute on function public.sync_restaurant_tables_to_plan_limit(uuid) to authenticated;

-- ============================================================================
-- 3. TRIGGER DE ENFORCEMENT DE LIMITE DE MESAS (INSERT OU UPDATE OF active, is_active)
-- ============================================================================
create or replace function public.enforce_restaurant_tables_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_tables integer;
  v_active_count integer;
  v_becoming_active boolean := false;
begin
  -- Se estivermos em reorganização atômica pelo sistema, pular verificação
  if current_setting('app.skip_plan_limit_check', true) = 'true' then
    return NEW;
  end if;

  -- Harmonizar active e is_active
  if TG_OP = 'UPDATE' then
    if NEW.is_active is distinct from OLD.is_active then
      NEW.active := NEW.is_active;
    elsif NEW.active is distinct from OLD.active then
      NEW.is_active := NEW.active;
    end if;
    v_becoming_active := (coalesce(NEW.is_active, NEW.active, false) = true and coalesce(OLD.is_active, OLD.active, false) = false);
  else -- INSERT
    if NEW.is_active is null and NEW.active is not null then
      NEW.is_active := NEW.active;
    elsif NEW.active is null and NEW.is_active is not null then
      NEW.active := NEW.is_active;
    elsif NEW.is_active is null and NEW.active is null then
      NEW.is_active := true;
      NEW.active := true;
    else
      NEW.active := NEW.is_active;
    end if;
    v_becoming_active := (coalesce(NEW.is_active, NEW.active, false) = true);
  end if;

  -- Se a mesa não estiver ficando ativa, permitir sem validar cota
  if not v_becoming_active then
    return NEW;
  end if;

  -- Obter cota máxima de mesas do plano do restaurante
  select r.max_tables
  into v_max_tables
  from public.restaurants as r
  where r.id = NEW.restaurant_id
  for update;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  -- Contar mesas ativas existentes (excluindo a própria linha se for update)
  select count(*)
  into v_active_count
  from public.restaurant_tables
  where restaurant_id = NEW.restaurant_id
    and (is_active = true or active = true)
    and (TG_OP = 'INSERT' or id <> NEW.id);

  if v_active_count >= v_max_tables then
    raise exception 'Limite de % mesas ativas do plano atual atingido. Faça upgrade do plano para liberar mais mesas.', v_max_tables
      using errcode = 'P0001';
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_restaurant_tables_plan_limit on public.restaurant_tables;
create trigger trg_enforce_restaurant_tables_plan_limit
  before insert or update of active, is_active on public.restaurant_tables
  for each row
  execute function public.enforce_restaurant_tables_plan_limit();

-- ============================================================================
-- 4. ATUALIZAÇÃO DA RPC update_restaurant_saas_plan COM SYNC DE MESAS
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

  -- SINCRONIZAÇÃO AUTOMÁTICA DE MESAS AO LIMITE DO PLANO (BLOCO 11.5)
  perform public.sync_restaurant_tables_to_plan_limit(p_restaurant_id);

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
    'days_remaining', ceil(extract(epoch from (v_updated.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int
  );
end;
$$;

revoke all on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) to authenticated;

-- ============================================================================
-- 5. ATUALIZAR update_platform_plan_catalog COM SYNC DE MESAS DOS RESTAURANTES
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

    -- Sincronizar mesas de todos os restaurantes atualizados
    for r in select id from public.restaurants loop
      perform public.sync_restaurant_tables_to_plan_limit(r.id);
    end loop;
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
-- 6. ATUALIZAÇÃO DA RPC get_public_restaurant (COM PLANO, LIMITE E VIGÊNCIA)
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
    'maxTables', r.max_tables,
    'max_tables', r.max_tables,
    'subscriptionExpiresAt', r.subscription_expires_at,
    'subscription_expires_at', r.subscription_expires_at
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public, anon, authenticated;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

-- ============================================================================
-- 7. ATUALIZAÇÃO DA RPC get_admin_tables (COM STATUS isLockedByPlan)
-- ============================================================================
create or replace function public.get_admin_tables(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  v_max_tables integer;
  v_active_count integer;
begin
  rid := public.require_catalog_admin(p_slug);

  select max_tables into v_max_tables
  from public.restaurants
  where id = rid;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  select count(*) into v_active_count
  from public.restaurant_tables
  where restaurant_id = rid
    and (active = true or is_active = true);

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'tableNumber', t.table_number,
          'label', t.label,
          'active', (t.active and t.is_active),
          'isActive', (t.active and t.is_active),
          'is_active', (t.active and t.is_active),
          'isLockedByPlan', (
            (not (t.active and t.is_active)) and (
              t.table_number > v_max_tables or v_active_count >= v_max_tables
            )
          ),
          'revision', t.revision,
          'visitId', v.id,
          'tabCount', (select count(*) from public.table_tabs tab where tab.table_visit_id = v.id and tab.status = 'open'),
          'totalInCents', coalesce((select sum(i.line_total_in_cents) from public.table_tab_items i where i.table_visit_id = v.id and i.status = 'active'), 0),
          'billPending', exists(select 1 from public.service_requests sr where sr.table_visit_id = v.id and sr.request_type = 'bill' and sr.status = 'pending')
        )
        order by t.table_number
      )
      from public.restaurant_tables as t
      left join public.table_visits as v on v.restaurant_table_id = t.id and v.status = 'open'
      where t.restaurant_id = rid
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.get_admin_tables(text) from public, anon, authenticated;
grant execute on function public.get_admin_tables(text) to authenticated;

-- ============================================================================
-- 8. ATUALIZAÇÃO DA RPC save_restaurant_table
-- ============================================================================
create or replace function public.save_restaurant_table(
  p_slug text,
  p_id uuid,
  p_revision integer,
  p_number integer,
  p_label text,
  p_active boolean
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.restaurant_tables%rowtype;
begin
  rid := public.require_catalog_admin(p_slug);
  if p_id is null or p_revision is null or p_revision < 0 or p_number is null or p_number not between 1 and 999
  or p_label is null or char_length(btrim(p_label)) > 80 or p_active is null then
    raise exception using errcode = '22023', message = 'Informe mesa de 1 a 999 e identificação de até 80 caracteres.';
  end if;

  select * into old_row from public.restaurant_tables where id = p_id for update;
  if found then
    if old_row.restaurant_id <> rid then
      raise exception using errcode = '42501', message = 'Mesa de outro restaurante.';
    end if;
    if old_row.revision <> p_revision then
      raise exception using errcode = '40001', message = 'Mesa alterada. Recarregue antes de editar.';
    end if;
    if not p_active and exists (select 1 from public.table_visits v where v.restaurant_table_id = p_id and v.status = 'open') then
      raise exception using errcode = '22023', message = 'Encerre o atendimento antes de desativar esta mesa.';
    end if;
    if p_number <> old_row.table_number and exists (select 1 from public.table_visits v where v.restaurant_table_id = p_id) then
      raise exception using errcode = '22023', message = 'Uma mesa com histórico mantém seu número. Edite a identificação ou cadastre outra mesa.';
    end if;

    update public.restaurant_tables
    set table_number = p_number,
        label = btrim(p_label),
        active = p_active,
        is_active = p_active
    where id = p_id;
  else
    if p_revision <> 0 then
      raise exception using errcode = '22023', message = 'Mesa não encontrada.';
    end if;

    insert into public.restaurant_tables(id, restaurant_id, table_number, label, active, is_active)
    values (p_id, rid, p_number, btrim(p_label), p_active, p_active);
  end if;

  return p_id;
exception
  when unique_violation then
    raise exception using errcode = '22023', message = 'Já existe uma mesa com este número, inclusive entre as desativadas.';
end;
$$;

revoke all on function public.save_restaurant_table(text, uuid, integer, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.save_restaurant_table(text, uuid, integer, integer, text, boolean) to authenticated;

-- ============================================================================
-- 9. TRAVA OPERACIONAL EM open_table_visit (RESPEITO A is_active E max_tables)
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
  select restaurant.id, restaurant.max_tables
  into target_restaurant_id, v_max_tables
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
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

  -- Serializar operações de abertura para esta mesa (exige ativa em active e is_active).
  select restaurant_table.id
  into target_table_id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
    and (restaurant_table.active = true and restaurant_table.is_active = true)
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
        errcode = '42501',
        message = 'Esta mesa já está sendo atendida por outro funcionário.';
    end if;

    return target_visit;
  end if;

  insert into public.table_visits (
    restaurant_id,
    restaurant_table_id,
    assigned_member_id
  )
  values (
    target_restaurant_id,
    target_table_id,
    target_member_id
  )
  returning * into target_visit;

  return target_visit;
end;
$$;

revoke all on function public.open_table_visit(text, integer) from public, anon, authenticated;
grant execute on function public.open_table_visit(text, integer) to authenticated;

-- ============================================================================
-- 10. SINCRONIZAR TODAS AS MESAS EXISTENTES AO LIMITE DO SEU PLANO ATUAL
-- ============================================================================
do $$
declare
  r record;
begin
  for r in select id from public.restaurants loop
    perform public.sync_restaurant_tables_to_plan_limit(r.id);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

commit;
