begin;

-- Atualização definitiva da RPC create_subscription_checkout com compatibilidade total de colunas
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
    raise exception 'Apenas administradores podem gerenciar planos e faturamento.'
      using errcode = '42501';
  end if;

  -- 2. Validação dos argumentos
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

  -- 4. Buscar tabela de preços e dados PIX do servidor
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

commit;
