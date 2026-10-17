begin;

-- ============================================================================
-- 1. TABELA public.subscription_invoices
-- ============================================================================
create table if not exists public.subscription_invoices (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  plan_id text not null check (plan_id in ('basic', 'pro', 'premium')),
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly', 'yearly')),
  payment_method text not null check (payment_method in ('pix', 'credit_card', 'debit_card')),
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'refunded')),
  pix_qr_code_payload text,
  pix_expires_at timestamptz,
  card_brand text,
  card_last4 text,
  external_reference text unique,
  paid_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_subscription_invoices_restaurant_id
  on public.subscription_invoices(restaurant_id);

create index if not exists idx_subscription_invoices_status
  on public.subscription_invoices(status);

create index if not exists idx_subscription_invoices_created_at
  on public.subscription_invoices(created_at desc);

-- ============================================================================
-- 2. TABELA public.restaurant_payment_methods
-- ============================================================================
create table if not exists public.restaurant_payment_methods (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  method_type text not null check (method_type in ('credit_card', 'debit_card', 'pix')),
  holder_name text,
  card_brand text,
  card_last4 text,
  exp_month integer check (exp_month between 1 and 12),
  exp_year integer check (exp_year >= 2024),
  gateway_token text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_restaurant_payment_methods_restaurant_id
  on public.restaurant_payment_methods(restaurant_id);

-- 2.1 Configuração de PIX da Plataforma em platform_settings (Chave PIX / Banco Inter PJ)
alter table public.platform_settings
  add column if not exists pix_key text not null default '67594410000189',
  add column if not exists pix_receiver_name text not null default 'ELOZI TECNOLOGIA',
  add column if not exists pix_receiver_city text not null default 'SAO PAULO';

update public.platform_settings
set pix_key = '67594410000189',
    pix_receiver_name = 'ELOZI TECNOLOGIA',
    pix_receiver_city = 'SAO PAULO'
where id = 'default';

-- ============================================================================
-- 3. RLS EM subscription_invoices E restaurant_payment_methods
-- ============================================================================
alter table public.subscription_invoices enable row level security;
alter table public.restaurant_payment_methods enable row level security;

-- Policies para subscription_invoices
drop policy if exists subscription_invoices_select on public.subscription_invoices;
create policy subscription_invoices_select
  on public.subscription_invoices
  for select
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = subscription_invoices.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

drop policy if exists subscription_invoices_insert on public.subscription_invoices;
create policy subscription_invoices_insert
  on public.subscription_invoices
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = subscription_invoices.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

drop policy if exists subscription_invoices_update on public.subscription_invoices;
create policy subscription_invoices_update
  on public.subscription_invoices
  for update
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = subscription_invoices.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

-- Policies para restaurant_payment_methods
drop policy if exists restaurant_payment_methods_select on public.restaurant_payment_methods;
create policy restaurant_payment_methods_select
  on public.restaurant_payment_methods
  for select
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = restaurant_payment_methods.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

drop policy if exists restaurant_payment_methods_insert on public.restaurant_payment_methods;
create policy restaurant_payment_methods_insert
  on public.restaurant_payment_methods
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = restaurant_payment_methods.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

drop policy if exists restaurant_payment_methods_update on public.restaurant_payment_methods;
create policy restaurant_payment_methods_update
  on public.restaurant_payment_methods
  for update
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = restaurant_payment_methods.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

drop policy if exists restaurant_payment_methods_delete on public.restaurant_payment_methods;
create policy restaurant_payment_methods_delete
  on public.restaurant_payment_methods
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = restaurant_payment_methods.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  );

revoke all on public.subscription_invoices from public, anon;
grant select, insert, update on public.subscription_invoices to authenticated;

revoke all on public.restaurant_payment_methods from public, anon;
grant select, insert, update, delete on public.restaurant_payment_methods to authenticated;

-- ============================================================================
-- 3.1 FUNÇÃO AUXILIAR: pix_crc16 (Cálculo CRC16-CCITT para PIX EMV)
-- ============================================================================
create or replace function public.pix_crc16(p_str text)
returns text
language plpgsql
immutable
as $$
declare
  v_crc integer := 65535; -- 0xFFFF
  v_len integer := length(p_str);
  v_byte integer;
  i integer;
  j integer;
begin
  for i in 1..v_len loop
    v_byte := ascii(substring(p_str from i for 1));
    v_crc := v_crc # (v_byte << 8);
    for j in 1..8 loop
      if (v_crc & 32768) <> 0 then
        v_crc := ((v_crc << 1) # 4129) & 65535; -- 0x1021
      else
        v_crc := (v_crc << 1) & 65535;
      end if;
    end loop;
  end loop;
  return upper(lpad(to_hex(v_crc), 4, '0'));
end;
$$;

-- ============================================================================
-- 4. RPC public.create_subscription_checkout
-- ============================================================================
create or replace function public.create_subscription_checkout(
  p_restaurant_id uuid,
  p_target_plan text,
  p_billing_cycle text,
  p_payment_method text,
  p_card_data jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant record;
  v_settings record;
  v_unit_price integer;
  v_target_max_tables integer;
  v_amount_cents integer;
  v_invoice_id uuid;
  v_pix_payload text;
  v_pix_expires_at timestamptz;
  v_card_brand text;
  v_card_last4 text;
  v_holder_name text;
  v_exp_month integer;
  v_exp_year integer;
  v_base_time timestamptz;
  v_cycle_interval interval;
  v_cycle_days integer;
  v_new_expires_at timestamptz;
  v_actor_email text;
begin
  -- 1. Validação de autorização
  if not (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  ) then
    raise exception 'Apenas administradores do restaurante podem alterar ou renovar assinaturas.' using errcode = '42501';
  end if;

  -- 2. Validação dos parâmetros
  if p_target_plan not in ('basic', 'pro', 'premium') then
    raise exception 'Plano inválido: %', p_target_plan using errcode = '22023';
  end if;

  if p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'Ciclo de faturamento inválido: %', p_billing_cycle using errcode = '22023';
  end if;

  if p_payment_method not in ('pix', 'credit_card', 'debit_card') then
    raise exception 'Meio de pagamento inválido: %', p_payment_method using errcode = '22023';
  end if;

  -- 3. Buscar restaurante
  select
    id, name, slug, subscription_plan, subscription_expires_at, max_tables, monthly_price_cents, active
  into v_restaurant
  from public.restaurants
  where id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  -- 4. Buscar tabela de preços oficiais do servidor (NUNCA confiar no front)
  select
    coalesce(basic_price_cents, 9900) as basic_price_cents,
    coalesce(basic_max_tables, 10) as basic_max_tables,
    coalesce(pro_price_cents, 14900) as pro_price_cents,
    coalesce(pro_max_tables, 25) as pro_max_tables,
    coalesce(premium_price_cents, 19900) as premium_price_cents,
    coalesce(premium_max_tables, 100) as premium_max_tables,
    coalesce(pix_key, '67594410000189') as pix_key,
    coalesce(pix_receiver_name, 'ELOZI TECNOLOGIA') as pix_receiver_name,
    coalesce(pix_receiver_city, 'SAO PAULO') as pix_receiver_city
  into v_settings
  from public.platform_settings
  where id = 'default';

  if not found then
    v_settings := row(9900, 10, 14900, 25, 19900, 100, '67594410000189', 'ELOZI TECNOLOGIA', 'SAO PAULO');
  end if;

  if p_target_plan = 'basic' then
    v_unit_price := v_settings.basic_price_cents;
    v_target_max_tables := v_settings.basic_max_tables;
  elsif p_target_plan = 'pro' then
    v_unit_price := v_settings.pro_price_cents;
    v_target_max_tables := v_settings.pro_max_tables;
  else
    v_unit_price := v_settings.premium_price_cents;
    v_target_max_tables := v_settings.premium_max_tables;
  end if;

  -- Preço anual dá 2 meses de bônus (10 meses em vez de 12)
  if p_billing_cycle = 'yearly' then
    v_amount_cents := v_unit_price * 10;
    v_cycle_interval := interval '365 days';
    v_cycle_days := 365;
  else
    v_amount_cents := v_unit_price;
    v_cycle_interval := interval '30 days';
    v_cycle_days := 30;
  end if;

  v_invoice_id := gen_random_uuid();

  -- 5. Fluxo PIX Oficial (Compatível Banco Central & Banco Inter PJ)
  if p_payment_method = 'pix' then
    v_pix_expires_at := timezone('utc', now()) + interval '30 minutes';
    declare
      v_amount_str text;
      v_pix_key_clean text;
      v_merchant_info text;
      v_txid text;
      v_additional_data text;
      v_rec_name text;
      v_rec_city text;
      v_payload_raw text;
    begin
      v_amount_str := to_char(v_amount_cents::numeric / 100.0, 'FM999990.00');
      v_pix_key_clean := regexp_replace(coalesce(v_settings.pix_key, '67594410000189'), '\D', '', 'g');

      -- Subtag 00 (GUI) + Subtag 01 (Chave CNPJ)
      v_merchant_info := '0014br.gov.bcb.pix' || '01' || lpad(length(v_pix_key_clean)::text, 2, '0') || v_pix_key_clean;

      -- Tag 59 (Nome) e Tag 60 (Cidade)
      v_rec_name := upper(substring(regexp_replace(coalesce(v_settings.pix_receiver_name, 'ELOZI TECNOLOGIA'), '[^a-zA-Z0-9 ]', '', 'g') from 1 for 25));
      if length(v_rec_name) = 0 then
        v_rec_name := 'ELOZI TECNOLOGIA';
      end if;

      v_rec_city := upper(substring(regexp_replace(coalesce(v_settings.pix_receiver_city, 'SAO PAULO'), '[^a-zA-Z0-9 ]', '', 'g') from 1 for 15));
      if length(v_rec_city) = 0 then
        v_rec_city := 'SAO PAULO';
      end if;

      -- Tag 62 (Campo Adicional com txid para conciliação no extrato do Banco Inter)
      v_txid := 'ELOZI' || upper(substring(replace(v_invoice_id::text, '-', '') from 1 for 15));
      v_additional_data := '05' || lpad(length(v_txid)::text, 2, '0') || v_txid;

      -- Concatenação do BR Code EMV sem CRC16
      v_payload_raw := '000201' ||
                       '26' || lpad(length(v_merchant_info)::text, 2, '0') || v_merchant_info ||
                       '52040000' ||
                       '5303986' ||
                       '54' || lpad(length(v_amount_str)::text, 2, '0') || v_amount_str ||
                       '5802BR' ||
                       '59' || lpad(length(v_rec_name)::text, 2, '0') || v_rec_name ||
                       '60' || lpad(length(v_rec_city)::text, 2, '0') || v_rec_city ||
                       '62' || lpad(length(v_additional_data)::text, 2, '0') || v_additional_data ||
                       '6304';

      -- Cálculo do CRC16 oficial CCITT-FALSE
      v_pix_payload := v_payload_raw || public.pix_crc16(v_payload_raw);
    end;

    insert into public.subscription_invoices (
      id,
      restaurant_id,
      plan_id,
      billing_cycle,
      payment_method,
      amount_cents,
      status,
      pix_qr_code_payload,
      pix_expires_at,
      external_reference,
      created_by
    ) values (
      v_invoice_id,
      p_restaurant_id,
      p_target_plan,
      p_billing_cycle,
      'pix',
      v_amount_cents,
      'pending',
      v_pix_payload,
      v_pix_expires_at,
      'pix_' || v_invoice_id::text,
      auth.uid()
    );

    return jsonb_build_object(
      'success', true,
      'invoice_id', v_invoice_id,
      'status', 'pending',
      'amount_cents', v_amount_cents,
      'plan_id', p_target_plan,
      'billing_cycle', p_billing_cycle,
      'payment_method', 'pix',
      'pix_qr_code_payload', v_pix_payload,
      'pix_expires_at', v_pix_expires_at
    );
  end if;

  -- 6. Fluxo Cartão de Crédito / Débito (Aprovação Imediata / Tokenizada)
  v_holder_name := nullif(btrim(coalesce(p_card_data->>'holder_name', '')), '');
  v_card_brand := lower(coalesce(nullif(btrim(p_card_data->>'card_brand'), ''), 'visa'));
  v_card_last4 := coalesce(nullif(btrim(p_card_data->>'card_last4'), ''), '4242');
  v_exp_month := coalesce((p_card_data->>'exp_month')::int, 12);
  v_exp_year := coalesce((p_card_data->>'exp_year')::int, 2030);

  if p_card_data is not null and (p_card_data->>'save_card')::boolean is true then
    insert into public.restaurant_payment_methods (
      restaurant_id,
      method_type,
      holder_name,
      card_brand,
      card_last4,
      exp_month,
      exp_year,
      gateway_token,
      is_default
    ) values (
      p_restaurant_id,
      p_payment_method,
      v_holder_name,
      v_card_brand,
      v_card_last4,
      v_exp_month,
      v_exp_year,
      'tok_' || replace(gen_random_uuid()::text, '-', ''),
      true
    );
  end if;

  -- Inserir fatura paga
  insert into public.subscription_invoices (
    id,
    restaurant_id,
    plan_id,
    billing_cycle,
    payment_method,
    amount_cents,
    status,
    card_brand,
    card_last4,
    external_reference,
    paid_at,
    created_by
  ) values (
    v_invoice_id,
    p_restaurant_id,
    p_target_plan,
    p_billing_cycle,
    p_payment_method,
    v_amount_cents,
    'paid',
    v_card_brand,
    v_card_last4,
    'card_' || v_invoice_id::text,
    timezone('utc', now()),
    auth.uid()
  );

  -- Atualização atômica do plano e renovação do ciclo da assinatura
  v_base_time := greatest(timezone('utc', now()), coalesce(v_restaurant.subscription_expires_at, timezone('utc', now())));
  v_new_expires_at := v_base_time + v_cycle_interval;

  update public.restaurants
  set
    subscription_plan = p_target_plan,
    max_tables = v_target_max_tables,
    monthly_price_cents = v_unit_price,
    billing_cycle_days = v_cycle_days,
    subscription_expires_at = v_new_expires_at,
    active = true
  where id = p_restaurant_id;

  -- Registro de auditoria
  select email into v_actor_email from auth.users where id = auth.uid();
  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    case when p_target_plan <> v_restaurant.subscription_plan then 'plan_changed' else 'cycle_renewed' end,
    p_restaurant_id,
    v_restaurant.name,
    coalesce(v_actor_email, 'admin'),
    jsonb_build_object(
      'invoice_id', v_invoice_id,
      'payment_method', p_payment_method,
      'plan_id', p_target_plan,
      'billing_cycle', p_billing_cycle,
      'amount_cents', v_amount_cents,
      'new_expires_at', v_new_expires_at
    )
  );

  return jsonb_build_object(
    'success', true,
    'invoice_id', v_invoice_id,
    'status', 'paid',
    'paid_at', timezone('utc', now()),
    'amount_cents', v_amount_cents,
    'plan_id', p_target_plan,
    'billing_cycle', p_billing_cycle,
    'payment_method', p_payment_method,
    'subscription_expires_at', v_new_expires_at,
    'max_tables', v_target_max_tables
  );
end;
$$;

revoke all on function public.create_subscription_checkout(uuid, text, text, text, jsonb) from public, anon;
grant execute on function public.create_subscription_checkout(uuid, text, text, text, jsonb) to authenticated;

-- ============================================================================
-- 5. RPC public.confirm_subscription_invoice_payment
-- ============================================================================
create or replace function public.confirm_subscription_invoice_payment(
  p_invoice_id uuid,
  p_external_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice record;
  v_restaurant record;
  v_settings record;
  v_unit_price integer;
  v_target_max_tables integer;
  v_base_time timestamptz;
  v_cycle_interval interval;
  v_cycle_days integer;
  v_new_expires_at timestamptz;
  v_actor_email text;
begin
  -- 1. Bloqueio pessimista da linha para idempotência
  select * into v_invoice
  from public.subscription_invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'Fatura % não encontrada.', p_invoice_id using errcode = '22023';
  end if;

  -- 2. Permissão: admin do restaurante ou platform_admin
  if not (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = v_invoice.restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  ) then
    raise exception 'Apenas administradores do restaurante podem confirmar faturas.' using errcode = '42501';
  end if;

  -- 3. Idempotência: se já estiver paga, retornar sucesso sem adicionar dias novamente
  if v_invoice.status = 'paid' then
    select subscription_expires_at, max_tables into v_restaurant
    from public.restaurants where id = v_invoice.restaurant_id;

    return jsonb_build_object(
      'success', true,
      'already_paid', true,
      'invoice_id', v_invoice.id,
      'status', 'paid',
      'paid_at', v_invoice.paid_at,
      'subscription_expires_at', v_restaurant.subscription_expires_at,
      'plan_id', v_invoice.plan_id
    );
  end if;

  if v_invoice.status in ('failed', 'expired', 'refunded') then
    raise exception 'A fatura não pode ser confirmada pois seu estado atual é "%".', v_invoice.status using errcode = '22023';
  end if;

  -- 4. Buscar restaurante
  select id, name, subscription_plan, subscription_expires_at, max_tables into v_restaurant
  from public.restaurants
  where id = v_invoice.restaurant_id;

  -- 5. Catálogo de limites
  select
    coalesce(basic_price_cents, 9900) as basic_price_cents,
    coalesce(basic_max_tables, 10) as basic_max_tables,
    coalesce(pro_price_cents, 14900) as pro_price_cents,
    coalesce(pro_max_tables, 25) as pro_max_tables,
    coalesce(premium_price_cents, 19900) as premium_price_cents,
    coalesce(premium_max_tables, 100) as premium_max_tables
  into v_settings
  from public.platform_settings
  where id = 'default';

  if not found then
    v_settings := row(9900, 10, 14900, 25, 19900, 100);
  end if;

  if v_invoice.plan_id = 'basic' then
    v_unit_price := v_settings.basic_price_cents;
    v_target_max_tables := v_settings.basic_max_tables;
  elsif v_invoice.plan_id = 'pro' then
    v_unit_price := v_settings.pro_price_cents;
    v_target_max_tables := v_settings.pro_max_tables;
  else
    v_unit_price := v_settings.premium_price_cents;
    v_target_max_tables := v_settings.premium_max_tables;
  end if;

  if v_invoice.billing_cycle = 'yearly' then
    v_cycle_interval := interval '365 days';
    v_cycle_days := 365;
  else
    v_cycle_interval := interval '30 days';
    v_cycle_days := 30;
  end if;

  -- 6. Atualizar fatura para 'paid'
  update public.subscription_invoices
  set
    status = 'paid',
    paid_at = timezone('utc', now()),
    external_reference = coalesce(p_external_reference, external_reference)
  where id = p_invoice_id;

  -- 7. Atualização atômica do plano e ciclo
  v_base_time := greatest(timezone('utc', now()), coalesce(v_restaurant.subscription_expires_at, timezone('utc', now())));
  v_new_expires_at := v_base_time + v_cycle_interval;

  update public.restaurants
  set
    subscription_plan = v_invoice.plan_id,
    max_tables = v_target_max_tables,
    monthly_price_cents = v_unit_price,
    billing_cycle_days = v_cycle_days,
    subscription_expires_at = v_new_expires_at,
    active = true
  where id = v_invoice.restaurant_id;

  -- 8. Auditoria
  select email into v_actor_email from auth.users where id = auth.uid();
  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    case when v_invoice.plan_id <> v_restaurant.subscription_plan then 'plan_changed' else 'cycle_renewed' end,
    v_invoice.restaurant_id,
    v_restaurant.name,
    coalesce(v_actor_email, 'admin'),
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'payment_method', v_invoice.payment_method,
      'plan_id', v_invoice.plan_id,
      'billing_cycle', v_invoice.billing_cycle,
      'amount_cents', v_invoice.amount_cents,
      'new_expires_at', v_new_expires_at
    )
  );

  return jsonb_build_object(
    'success', true,
    'already_paid', false,
    'invoice_id', v_invoice.id,
    'status', 'paid',
    'paid_at', timezone('utc', now()),
    'subscription_expires_at', v_new_expires_at,
    'plan_id', v_invoice.plan_id,
    'max_tables', v_target_max_tables
  );
end;
$$;

revoke all on function public.confirm_subscription_invoice_payment(uuid, text) from public, anon;
grant execute on function public.confirm_subscription_invoice_payment(uuid, text) to authenticated;

-- ============================================================================
-- 6. RPC public.get_restaurant_billing_summary
-- ============================================================================
create or replace function public.get_restaurant_billing_summary(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant record;
  v_settings record;
  v_tables_count integer;
  v_products_count integer;
  v_invoices jsonb;
  v_methods jsonb;
begin
  -- 1. Permissão: admin do restaurante ou platform_admin
  if not (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  ) then
    raise exception 'Acesso não autorizado ao faturamento do restaurante.' using errcode = '42501';
  end if;

  -- 2. Dados do restaurante
  select
    r.id,
    r.name,
    r.slug,
    r.subscription_plan,
    r.subscription_started_at,
    r.subscription_expires_at,
    r.billing_cycle_days,
    coalesce(r.max_tables, 10) as max_tables,
    coalesce(r.monthly_price_cents, 9900) as monthly_price_cents,
    r.active
  into v_restaurant
  from public.restaurants as r
  where r.id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  -- 3. Uso atual de recursos
  select count(*) into v_tables_count
  from public.restaurant_tables
  where restaurant_id = p_restaurant_id and active = true;

  select count(*) into v_products_count
  from public.menu_products
  where restaurant_id = p_restaurant_id;

  -- 4. Catálogo oficial
  select
    coalesce(basic_price_cents, 9900) as basic_price_cents,
    coalesce(basic_max_tables, 10) as basic_max_tables,
    coalesce(pro_price_cents, 14900) as pro_price_cents,
    coalesce(pro_max_tables, 25) as pro_max_tables,
    coalesce(premium_price_cents, 19900) as premium_price_cents,
    coalesce(premium_max_tables, 100) as premium_max_tables
  into v_settings
  from public.platform_settings
  where id = 'default';

  if not found then
    v_settings := row(9900, 10, 14900, 25, 19900, 100);
  end if;

  -- 5. Histórico de faturas (últimas 25)
  select coalesce(jsonb_agg(inv_row), '[]'::jsonb)
  into v_invoices
  from (
    select
      inv.id,
      inv.plan_id,
      inv.billing_cycle,
      inv.payment_method,
      inv.amount_cents,
      inv.status,
      inv.card_brand,
      inv.card_last4,
      inv.pix_qr_code_payload,
      inv.pix_expires_at,
      inv.paid_at,
      inv.created_at
    from public.subscription_invoices as inv
    where inv.restaurant_id = p_restaurant_id
    order by inv.created_at desc
    limit 25
  ) as inv_row;

  -- 6. Meios de pagamento salvos
  select coalesce(jsonb_agg(pm_row), '[]'::jsonb)
  into v_methods
  from (
    select
      pm.id,
      pm.method_type,
      pm.holder_name,
      pm.card_brand,
      pm.card_last4,
      pm.exp_month,
      pm.exp_year,
      pm.is_default,
      pm.created_at
    from public.restaurant_payment_methods as pm
    where pm.restaurant_id = p_restaurant_id
    order by pm.created_at desc
  ) as pm_row;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'subscription_plan', v_restaurant.subscription_plan,
      'subscription_started_at', v_restaurant.subscription_started_at,
      'subscription_expires_at', v_restaurant.subscription_expires_at,
      'billing_cycle_days', v_restaurant.billing_cycle_days,
      'max_tables', v_restaurant.max_tables,
      'monthly_price_cents', v_restaurant.monthly_price_cents,
      'active', v_restaurant.active,
      'billing_status', public.get_restaurant_billing_status(v_restaurant.subscription_expires_at),
      'days_remaining', ceil(extract(epoch from (v_restaurant.subscription_expires_at - timezone('utc', now()))) / 86400.0)::int
    ),
    'usage', jsonb_build_object(
      'tables_count', v_tables_count,
      'products_count', v_products_count
    ),
    'catalog', jsonb_build_object(
      'basic', jsonb_build_object(
        'plan_id', 'basic',
        'name', 'Plano Básico',
        'monthly_price_cents', v_settings.basic_price_cents,
        'yearly_price_cents', v_settings.basic_price_cents * 10,
        'max_tables', v_settings.basic_max_tables,
        'features', jsonb_build_array('Cardápio Digital com QR Code', 'Pedidos em tempo real nas mesas', 'Até 10 mesas simultâneas', 'Suporte padrão via e-mail')
      ),
      'pro', jsonb_build_object(
        'plan_id', 'pro',
        'name', 'Plano Profissional',
        'monthly_price_cents', v_settings.pro_price_cents,
        'yearly_price_cents', v_settings.pro_price_cents * 10,
        'max_tables', v_settings.pro_max_tables,
        'features', jsonb_build_array('Tudo do Básico', 'KDS Completo (Cozinha e Bar)', 'Gestão de Estoque e Insumos', 'Até 25 mesas simultâneas', 'Alertas sonoros para garçons')
      ),
      'premium', jsonb_build_object(
        'plan_id', 'premium',
        'name', 'Plano Premium Enterprise',
        'monthly_price_cents', v_settings.premium_price_cents,
        'yearly_price_cents', v_settings.premium_price_cents * 10,
        'max_tables', v_settings.premium_max_tables,
        'features', jsonb_build_array('Tudo do Profissional', 'Até 100 mesas simultâneas', 'Comentários e Avaliações Públicas', 'Auditoria e Governança Avançada', 'Suporte prioritário VIP')
      )
    ),
    'invoices', v_invoices,
    'payment_methods', v_methods
  );
end;
$$;

revoke all on function public.get_restaurant_billing_summary(uuid) from public, anon;
grant execute on function public.get_restaurant_billing_summary(uuid) to authenticated;

-- ============================================================================
-- 7. RPC public.delete_restaurant_payment_method
-- ============================================================================
create or replace function public.delete_restaurant_payment_method(
  p_restaurant_id uuid,
  p_method_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = auth.uid()
        and m.active = true
        and m.role = 'admin'
    ) or public.is_platform_admin()
  ) then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;

  delete from public.restaurant_payment_methods
  where id = p_method_id and restaurant_id = p_restaurant_id;

  return true;
end;
$$;

revoke all on function public.delete_restaurant_payment_method(uuid, uuid) from public, anon;
grant execute on function public.delete_restaurant_payment_method(uuid, uuid) to authenticated;

commit;
