begin;

-- ============================================================================
-- 1. EXTENSÃO DA TABELA public.restaurants
-- Permite configuração do percentual da taxa de serviço (0% a 30%)
-- e do fuso horário IANA (padrão 'America/Sao_Paulo').
-- Validação segura de timezone compatível com PostgreSQL.
-- ============================================================================
alter table public.restaurants
  add column if not exists service_fee_percent numeric not null default 10,
  add column if not exists timezone text not null default 'America/Sao_Paulo';

alter table public.restaurants
  drop constraint if exists restaurants_service_fee_range,
  add constraint restaurants_service_fee_range
    check (service_fee_percent >= 0 and service_fee_percent <= 30),
  drop constraint if exists restaurants_timezone_not_empty,
  add constraint restaurants_timezone_not_empty
    check (length(btrim(timezone)) > 0);

-- ============================================================================
-- 2. EXTENSÃO DA TABELA public.service_requests
-- Armazena a manifestação explícita do cliente quanto à taxa de serviço
-- ao solicitar a conta.
-- ============================================================================
alter table public.service_requests
  add column if not exists include_service_fee boolean;

-- ============================================================================
-- 3. EXTENSÃO DA TABELA public.table_tabs
-- Snapshot contábil imutável persistido no momento do fechamento.
-- ============================================================================
alter table public.table_tabs
  add column if not exists subtotal_in_cents integer,
  add column if not exists service_fee_percent numeric,
  add column if not exists service_fee_in_cents integer,
  add column if not exists total_in_cents integer,
  add column if not exists service_fee_accepted boolean;

alter table public.table_tabs
  drop constraint if exists table_tabs_financial_snapshot_check,
  add constraint table_tabs_financial_snapshot_check
    check (
      (
        status = 'open'
        and subtotal_in_cents is null
        and service_fee_percent is null
        and service_fee_in_cents is null
        and total_in_cents is null
        and service_fee_accepted is null
      )
      or
      (
        status = 'closed'
        and (
          -- Comandas históricas pré-existentes sem snapshot: todos os 5 campos devem ser nulos
          (
            subtotal_in_cents is null
            and service_fee_percent is null
            and service_fee_in_cents is null
            and total_in_cents is null
            and service_fee_accepted is null
          )
          or
          -- Comandas com snapshot contábil: todos os 5 campos devem estar preenchidos e válidos
          (
            subtotal_in_cents is not null
            and subtotal_in_cents >= 0
            and service_fee_percent is not null
            and service_fee_percent >= 0
            and service_fee_percent <= 30
            and service_fee_in_cents is not null
            and service_fee_in_cents >= 0
            and total_in_cents is not null
            and total_in_cents = subtotal_in_cents + service_fee_in_cents
            and service_fee_accepted is not null
          )
        )
      )
    );

-- ============================================================================
-- 4. ATUALIZAÇÃO DA RPC PÚBLICA get_public_restaurant
-- Expõe serviceFeePercent e timezone para clientes e garçons.
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
    'timezone', r.timezone
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public, anon, authenticated;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

-- ============================================================================
-- 5. ATUALIZAÇÃO DA RPC request_table_tab_bill
-- Suporta o parâmetro p_include_service_fee (com default false para retrocompatibilidade).
-- O cliente escolhe explicitamente se prefere incluir ou não a taxa sugerida.
-- ============================================================================
drop function if exists public.request_table_tab_bill(text, uuid);

create or replace function public.request_table_tab_bill(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_include_service_fee boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_table_id uuid;
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_guest public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  rate_limit public.guest_service_request_limits%rowtype;
  checked_at timestamptz;
  retry_after_seconds integer;
begin
  current_user_id := auth.uid();
  if current_user_id is null or not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Utilize seu acesso de cliente para pedir a conta.';
  end if;
  if p_table_tab_id is null then
    raise exception using errcode = '22023', message = 'Informe a comanda.';
  end if;

  -- 1. Restaurante (FOR SHARE)
  select restaurant.id into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug and restaurant.active for share;
  if not found then
    raise exception using errcode = '42501', message = 'Restaurante indisponível.';
  end if;

  -- 2. Mesa e Visita
  select tab.restaurant_table_id, tab.table_visit_id
  into target_table_id, target_visit_id
  from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.restaurant_id = target_restaurant_id;
  if not found then
    raise exception using errcode = '42501', message = 'Comanda indisponível para este acesso.';
  end if;

  -- 3. Mesa (FOR UPDATE)
  perform restaurant_table.id from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id and restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.active for update;
  if not found then
    raise exception using errcode = '22023', message = 'Mesa indisponível.';
  end if;

  -- 4. Rate Limiter (5 por minuto compartilhado)
  insert into public.guest_service_request_limits(user_id) values (current_user_id)
  on conflict (user_id) do nothing;
  select limiter.* into rate_limit from public.guest_service_request_limits as limiter
  where limiter.user_id = current_user_id for update;
  checked_at := clock_timestamp();
  if rate_limit.window_started_at + interval '1 minute' <= checked_at then
    update public.guest_service_request_limits set window_started_at = checked_at, attempts = 0
    where user_id = current_user_id returning * into rate_limit;
  end if;
  if rate_limit.attempts >= 5 then
    retry_after_seconds := greatest(1, ceil(extract(epoch from (
      rate_limit.window_started_at + interval '1 minute' - checked_at
    )))::integer);
    return jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', retry_after_seconds);
  end if;
  update public.guest_service_request_limits set attempts = attempts + 1 where user_id = current_user_id;

  -- 5. Atendimento (FOR UPDATE)
  select visit.* into target_visit from public.table_visits as visit
  where visit.id = target_visit_id and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id for update;
  if not found or target_visit.status <> 'open' then
    raise exception using errcode = '22023', message = 'O atendimento desta mesa já foi encerrado.';
  end if;

  -- 6. Comanda (FOR UPDATE)
  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_restaurant_id and tab.restaurant_table_id = target_table_id for update;
  if not found or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Esta comanda não está aberta.';
  end if;

  -- 7. Validar vínculo da sessão do cliente
  select guest.* into target_guest from public.guest_sessions as guest
  join public.table_tab_guests as linked_guest on linked_guest.guest_session_id = guest.id
    and linked_guest.table_visit_id = guest.table_visit_id
    and linked_guest.restaurant_id = guest.restaurant_id
    and linked_guest.restaurant_table_id = guest.restaurant_table_id
  where linked_guest.table_tab_id = target_tab.id
    and guest.restaurant_id = target_restaurant_id and guest.restaurant_table_id = target_table_id
    and guest.table_visit_id = target_visit.id and guest.user_id = current_user_id
    and guest.status = 'active' and guest.expires_at > clock_timestamp()
  for update of guest, linked_guest;
  if not found then
    raise exception using errcode = '42501', message = 'Sua presença precisa estar confirmada e vinculada a esta comanda.';
  end if;

  -- 8. Chamado existente ou novo
  select request.* into target_request from public.service_requests as request
  where request.table_tab_id = target_tab.id and request.restaurant_id = target_restaurant_id
    and request.request_type = 'bill' and request.status = 'pending' for update;

  if found then
    -- A solicitação pendente já existe para a comanda: preserva a preferência do solicitante original
    -- sem permitir que outro participante sobrescreva include_service_fee.
    return jsonb_build_object('status', 'existing', 'request', to_jsonb(target_request));
  end if;

  insert into public.service_requests(
    restaurant_id, restaurant_table_id, table_visit_id, table_tab_id, request_type, include_service_fee, created_at
  ) values (
    target_restaurant_id, target_table_id, target_visit.id, target_tab.id, 'bill', coalesce(p_include_service_fee, false), clock_timestamp()
  ) returning * into target_request;

  return jsonb_build_object('status', 'created', 'request', to_jsonb(target_request));
end;
$$;

revoke all on function public.request_table_tab_bill(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.request_table_tab_bill(text, uuid, boolean) to authenticated;

-- ============================================================================
-- 6. ATUALIZAÇÃO DA RPC close_table_tab COM SNAPSHOT CONTÁBIL DEFINITIVO
-- Exige confirmação explícita da equipe (p_final_service_fee_accepted) se a taxa
-- do restaurante for maior que 0%. Se a taxa configurada for 0%, fecha sem cobrança.
-- A preferência registrada no pedido de conta é puramente informativa.
-- Recalcula subtotal e taxa no servidor exclusivamente sobre itens com status='active'.
-- Persiste snapshot imutável em table_tabs.
-- ============================================================================
drop function if exists public.close_table_tab(text, uuid);

create or replace function public.close_table_tab(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_final_service_fee_accepted boolean default null
)
returns public.table_tabs
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_restaurant_id uuid;
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  restaurant_fee_pct numeric;
  calculated_subtotal integer;
  applied_fee_pct numeric;
  calculated_fee integer;
  calculated_total integer;
  final_fee_accepted boolean;
begin
  if p_table_tab_id is null then
    raise exception using errcode = '22023', message = 'Informe a comanda que deseja encerrar.';
  end if;

  select tab.table_visit_id, restaurant.id, restaurant.service_fee_percent
  into target_visit_id, target_restaurant_id, restaurant_fee_pct
  from public.table_tabs as tab
  join public.restaurants as restaurant on restaurant.id = tab.restaurant_id
  where tab.id = p_table_tab_id
    and restaurant.slug = p_restaurant_slug
    and restaurant.active = true;

  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste restaurante.';
  end if;

  target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id
    and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste atendimento.';
  end if;

  -- Se já estiver encerrada, retorna idempotente sem alterar snapshot
  if target_tab.status = 'closed' then
    return target_tab;
  end if;

  if target_visit.status <> 'open' then
    raise exception using errcode = '22023', message = 'Este atendimento já foi encerrado.';
  end if;

  -- 1. Calcular subtotal real no servidor (itens com status='active')
  select coalesce(sum(i.line_total_in_cents), 0)::integer
  into calculated_subtotal
  from public.table_tab_items as i
  where i.table_tab_id = target_tab.id
    and i.restaurant_id = target_restaurant_id
    and i.status = 'active';

  -- 2. Decisão final da taxa:
  -- A preferência do cliente registrada no pedido de conta é puramente informativa.
  -- Se o restaurante opera com taxa de serviço maior que 0%, a equipe deve obrigatoriamente
  -- confirmar se a taxa foi aceita (true) ou dispensada (false) pelo cliente no momento do acerto.
  if restaurant_fee_pct > 0 then
    if p_final_service_fee_accepted is null then
      raise exception using errcode = '22023', message = 'Informe se a taxa de serviço foi aceita pelo cliente antes de fechar a comanda.';
    end if;
    final_fee_accepted := p_final_service_fee_accepted;
    if final_fee_accepted then
      applied_fee_pct := restaurant_fee_pct;
      calculated_fee := round(calculated_subtotal * (applied_fee_pct / 100.0))::integer;
    else
      applied_fee_pct := 0;
      calculated_fee := 0;
    end if;
  else
    final_fee_accepted := false;
    applied_fee_pct := 0;
    calculated_fee := 0;
  end if;

  calculated_total := calculated_subtotal + calculated_fee;

  -- 4. Persistir snapshot imutável de fechamento
  update public.table_tabs
  set
    status = 'closed',
    closed_by_member_id = target_visit.assigned_member_id,
    closed_at = greatest(clock_timestamp(), target_tab.created_at),
    subtotal_in_cents = calculated_subtotal,
    service_fee_percent = applied_fee_pct,
    service_fee_in_cents = calculated_fee,
    total_in_cents = calculated_total,
    service_fee_accepted = final_fee_accepted
  where id = target_tab.id
  returning * into target_tab;

  return target_tab;
end;
$$;

revoke all on function public.close_table_tab(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.close_table_tab(text, uuid, boolean) to authenticated;

-- ============================================================================
-- 7. ATUALIZAÇÃO DA RPC save_restaurant_identity
-- Permite que o administrador configure service_fee_percent (0 a 30) e timezone.
-- ============================================================================
create or replace function public.save_restaurant_identity(
  p_slug text,
  p_revision integer,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.restaurants%rowtype;
  v public.restaurants%rowtype;
  field text;
  media jsonb;
  path text;
  primary_l numeric;
  text_l numeric;
  bg_l numeric;
  v_fee numeric;
  v_tz text;
begin
  rid := public.require_catalog_admin(p_slug);
  select * into old_row from public.restaurants where id = rid for update;
  if p_revision is distinct from old_row.revision then
    raise exception using errcode = '40001', message = 'A identidade foi alterada. Recarregue antes de editar novamente.';
  end if;
  select * into v from jsonb_populate_record(null::public.restaurants, p_values);
  if v.name is null or char_length(btrim(v.name)) not between 1 and 120
  or v.subtitle is null or char_length(v.subtitle) > 120
  or v.description is null or char_length(v.description) > 1000
  or v.address is null or char_length(v.address) > 300
  or v.phone is null or char_length(v.phone) > 40
  or v.opening_hours is null or char_length(v.opening_hours) > 500 then
    raise exception using errcode = '22023', message = 'Confira os dados e os limites dos campos.';
  end if;

  if p_values ? 'service_fee_percent' then
    v_fee := (p_values->>'service_fee_percent')::numeric;
    if v_fee is null or v_fee < 0 or v_fee > 30 then
      raise exception using errcode = '22023', message = 'A taxa de serviço deve estar entre 0% e 30%.';
    end if;
  else
    v_fee := old_row.service_fee_percent;
  end if;

  if p_values ? 'timezone' then
    v_tz := btrim(p_values->>'timezone');
    if v_tz is null or length(v_tz) = 0 then
      raise exception using errcode = '22023', message = 'Informe um fuso horário válido.';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_timezone_names where name = v_tz
    ) then
      raise exception using errcode = '22023', message = 'Fuso horário não reconhecido pelo sistema.';
    end if;
  else
    v_tz := old_row.timezone;
  end if;

  primary_l := public.hex_luminance(v.theme_primary);
  bg_l := public.hex_luminance(v.theme_background);
  text_l := public.hex_luminance(v.theme_text);
  if primary_l is null or bg_l is null or text_l is null or 1.05 / (primary_l + 0.05) < 4.5
  or (greatest(bg_l, text_l) + 0.05) / (least(bg_l, text_l) + 0.05) < 4.5 or 1.05 / (text_l + 0.05) < 4.5 then
    raise exception using errcode = '22023', message = 'Ajuste as cores: texto, cards e botões precisam de contraste mínimo de 4,5:1.';
  end if;

  foreach field in array array['logo', 'cover'] loop
    if not (p_values ? field) then
      raise exception using errcode = '22023', message = 'Informe logo e capa.';
    end if;
    media := p_values->field;
    if media is not null and media <> 'null'::jsonb then
      path := media->>'storagePath';
      if jsonb_typeof(media) is distinct from 'object' or path is null
      or path !~ ('^' || rid::text || '/identity/[0-9a-f-]{36}\.webp$')
      or jsonb_typeof(media->'url') is distinct from 'string'
      or media->>'url' !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/restaurant-images/'
      or right(media->>'url', char_length(path) + 1) <> '/' || path then
        raise exception using errcode = '22023', message = 'Envie logo e capa pelo painel deste restaurante.';
      end if;
      perform id from storage.objects where bucket_id = 'restaurant-images' and name = path for share;
      if not found then
        raise exception using errcode = '22023', message = 'A imagem ainda não foi enviada.';
      end if;
      media := jsonb_build_object('url', media->>'url', 'storagePath', path);
    end if;
    if field = 'logo' then v.logo := nullif(media, 'null'::jsonb); else v.cover := nullif(media, 'null'::jsonb); end if;
  end loop;

  update public.restaurants set
    name = btrim(v.name),
    subtitle = btrim(v.subtitle),
    description = btrim(v.description),
    address = btrim(v.address),
    phone = btrim(v.phone),
    opening_hours = btrim(v.opening_hours),
    theme_primary = upper(v.theme_primary),
    theme_background = upper(v.theme_background),
    theme_text = upper(v.theme_text),
    logo = v.logo,
    cover = v.cover,
    service_fee_percent = v_fee,
    timezone = v_tz
  where id = rid;

  return public.get_public_restaurant(p_slug);
end;
$$;

revoke all on function public.save_restaurant_identity(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_restaurant_identity(text, integer, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
