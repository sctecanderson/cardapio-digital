begin;

-- ============================================================================
-- REFINO STAFF PARTE 2: NOME DE ATENDIMENTO DO GARÇOM E PROJEÇÃO SEGURA
-- 1. Coluna display_name na tabela public.restaurant_members.
-- 2. RPC update_own_staff_display_name para o funcionário definir seu nome.
-- 3. Atualização de get_guest_table_tab_context para projetar assignedWaiterName.
-- 4. Atualização de get_waiter_request_state para projetar waiter_name.
-- ============================================================================

-- 1. COLUNA display_name EM public.restaurant_members
alter table public.restaurant_members
  add column if not exists display_name text null;

alter table public.restaurant_members
  drop constraint if exists restaurant_members_display_name_check;

alter table public.restaurant_members
  add constraint restaurant_members_display_name_check
  check (display_name is null or (char_length(btrim(display_name)) between 2 and 40));

-- 2. RPC PARA O FUNCIONÁRIO ATUALIZAR O PRÓPRIO NOME
create or replace function public.update_own_staff_display_name(
  p_restaurant_slug text,
  p_display_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_restaurant_id uuid;
  v_trimmed text;
  v_new_name text;
begin
  v_user_id := auth.uid();
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Acesso negado. Apenas funcionários autenticados podem alterar seu nome.';
  end if;

  if p_restaurant_slug is null or length(btrim(p_restaurant_slug)) = 0 then
    raise exception using errcode = '22023', message = 'Restaurante inválido.';
  end if;

  select r.id into v_restaurant_id
  from public.restaurants as r
  where r.slug = p_restaurant_slug and r.active = true;

  if v_restaurant_id is null then
    raise exception using errcode = '22023', message = 'Restaurante não encontrado.';
  end if;

  -- Higienização e validação
  if p_display_name is null then
    v_trimmed := null;
  else
    v_trimmed := btrim(p_display_name);
    if length(v_trimmed) = 0 then
      v_trimmed := null;
    elsif length(v_trimmed) < 2 or length(v_trimmed) > 40 then
      raise exception using errcode = '22023', message = 'O nome de atendimento deve conter entre 2 e 40 caracteres.';
    end if;
  end if;

  update public.restaurant_members as m
  set display_name = v_trimmed
  where m.user_id = v_user_id
    and m.restaurant_id = v_restaurant_id
    and m.active = true
  returning m.display_name into v_new_name;

  if not found then
    raise exception using errcode = '42501', message = 'Vínculo de membro ativo não encontrado neste restaurante.';
  end if;

  return v_new_name;
end;
$$;

revoke all on function public.update_own_staff_display_name(text, text) from public, anon, authenticated;
grant execute on function public.update_own_staff_display_name(text, text) to authenticated;

-- 3. PROJEÇÃO SEGURA DO NOME DO GARÇOM NA RPC get_guest_table_tab_context
create or replace function public.get_guest_table_tab_context(
  p_restaurant_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_restaurant_id uuid;
  v_table_id uuid;
  v_session record;
  v_visit_status text;
  v_waiter_name text;
  v_tab record;
  v_items jsonb;
  v_total bigint;
begin
  v_user_id := auth.uid();
  if v_user_id is null or not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return null;
  end if;

  if p_restaurant_slug is null or length(btrim(p_restaurant_slug)) = 0 then
    return null;
  end if;

  if p_table_number is null or p_table_number < 1 or p_table_number > 999 then
    return null;
  end if;

  -- 1. Validar restaurante ativo
  select r.id into v_restaurant_id
  from public.restaurants as r
  where r.slug = p_restaurant_slug and r.active = true;

  if v_restaurant_id is null then
    return null;
  end if;

  -- 2. Validar mesa ativa
  select rt.id into v_table_id
  from public.restaurant_tables as rt
  where rt.restaurant_id = v_restaurant_id
    and rt.table_number = p_table_number
    and rt.active = true;

  if v_table_id is null then
    return null;
  end if;

  -- 3. Obter a sessão mais recente do usuário nesta mesa deste restaurante
  select
    gs.id,
    gs.restaurant_id,
    gs.restaurant_table_id,
    gs.status,
    gs.table_visit_id,
    gs.created_at,
    gs.expires_at
  into v_session
  from public.guest_sessions as gs
  where gs.user_id = v_user_id
    and gs.restaurant_id = v_restaurant_id
    and gs.restaurant_table_id = v_table_id
  order by gs.created_at desc
  limit 1;

  if v_session.id is null then
    return null;
  end if;

  -- 4. Tratar expiração temporal
  if v_session.status = 'expired' or v_session.expires_at <= now() then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'expired',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb,
      'assignedWaiterName', null
    );
  end if;

  -- 5. Tratar status = 'revoked'
  if v_session.status = 'revoked' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'revoked',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb,
      'assignedWaiterName', null
    );
  end if;

  -- 6. Tratar status = 'pending'
  if v_session.status = 'pending' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'pending',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb,
      'assignedWaiterName', null
    );
  end if;

  if v_session.status <> 'active' then
    return null;
  end if;

  if v_session.table_visit_id is null then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'revoked',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb,
      'assignedWaiterName', null
    );
  end if;

  -- Obter status do atendimento e nome de exibição do garçom atribuído
  select v.status, m.display_name
  into v_visit_status, v_waiter_name
  from public.table_visits as v
  left join public.restaurant_members as m on m.id = v.assigned_member_id
  where v.id = v_session.table_visit_id
    and v.restaurant_id = v_restaurant_id
    and v.restaurant_table_id = v_table_id;

  if v_visit_status is null or v_visit_status <> 'open' then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'revoked',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb,
      'assignedWaiterName', null
    );
  end if;

  -- 7. Obter a comanda vinculada
  select
    tt.id as table_tab_id,
    tt.status as tab_status,
    tt.label as tab_label
  into v_tab
  from public.table_tab_guests as ttg
  join public.table_tabs as tt
    on tt.id = ttg.table_tab_id
   and tt.table_visit_id = v_session.table_visit_id
   and tt.restaurant_id = v_restaurant_id
   and tt.restaurant_table_id = v_table_id
  where ttg.guest_session_id = v_session.id
    and ttg.restaurant_id = v_restaurant_id
    and ttg.restaurant_table_id = v_table_id
    and ttg.table_visit_id = v_session.table_visit_id
  limit 1;

  if v_tab.table_tab_id is null then
    return jsonb_build_object(
      'session_id', v_session.id,
      'restaurant_id', v_session.restaurant_id,
      'restaurant_table_id', v_session.restaurant_table_id,
      'status', 'active',
      'table_visit_id', v_session.table_visit_id,
      'table_tab_id', null,
      'tab_status', null,
      'tab_label', null,
      'created_at', v_session.created_at,
      'expires_at', v_session.expires_at,
      'totalInCents', 0,
      'items', '[]'::jsonb,
      'assignedWaiterName', v_waiter_name
    );
  end if;

  -- 8. Coletar itens da comanda com todos os campos de KDS explicitamente
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'id', i.id,
        'restaurant_id', i.restaurant_id,
        'restaurant_table_id', i.restaurant_table_id,
        'table_visit_id', i.table_visit_id,
        'table_tab_id', i.table_tab_id,
        'product_id', i.product_id,
        'product_name', i.product_name,
        'unit_price_in_cents', i.unit_price_in_cents,
        'quantity', i.quantity,
        'line_total_in_cents', i.line_total_in_cents,
        'status', i.status,
        'added_by_member_id', i.added_by_member_id,
        'created_at', i.created_at,
        'cancelled_by_member_id', i.cancelled_by_member_id,
        'cancelled_at', i.cancelled_at,
        'cancellation_reason', i.cancellation_reason,
        'production_status', coalesce(i.production_status, 'pending'),
        'preparation_station', coalesce(i.preparation_station, 'kitchen'),
        'prep_started_at', i.prep_started_at,
        'prep_ready_at', i.prep_ready_at,
        'prep_delivered_at', i.prep_delivered_at
      ) order by i.created_at, i.id
    ), '[]'::jsonb),
    coalesce(sum(i.line_total_in_cents) filter (where i.status = 'active'), 0)
  into v_items, v_total
  from public.table_tab_items as i
  where i.table_tab_id = v_tab.table_tab_id
    and i.restaurant_id = v_restaurant_id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'restaurant_id', v_session.restaurant_id,
    'restaurant_table_id', v_session.restaurant_table_id,
    'status', 'active',
    'table_visit_id', v_session.table_visit_id,
    'table_tab_id', v_tab.table_tab_id,
    'tab_status', v_tab.tab_status,
    'tab_label', v_tab.tab_label,
    'created_at', v_session.created_at,
    'expires_at', v_session.expires_at,
    'totalInCents', coalesce(v_total, 0),
    'items', coalesce(v_items, '[]'::jsonb),
    'assignedWaiterName', v_waiter_name
  );
end;
$$;

revoke all on function public.get_guest_table_tab_context(text, integer) from public, anon, authenticated;
grant execute on function public.get_guest_table_tab_context(text, integer) to authenticated;

-- 4. ATUALIZAÇÃO DA RPC get_waiter_request_state PARA PROJETAR waiter_name
create or replace function public.get_waiter_request_state(
  p_restaurant_slug text,
  p_table_number integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_session public.guest_sessions%rowtype;
  target_request public.service_requests%rowtype;
  v_waiter_name text;
begin
  -- Contas da equipe não recebem o estado de um cliente.
  if auth.uid() is null
    or not coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    return jsonb_build_object(
      'guest_session_id', null,
      'request', null
    );
  end if;

  target_session := public.get_guest_session(
    p_restaurant_slug,
    p_table_number
  );

  if target_session.id is null then
    return jsonb_build_object(
      'guest_session_id', null,
      'request', null
    );
  end if;

  select request.*
  into target_request
  from public.service_requests as request
  join public.service_request_guests as link
    on link.service_request_id = request.id
  where link.guest_session_id = target_session.id
    and request.restaurant_id = target_session.restaurant_id
    and request.restaurant_table_id = target_session.restaurant_table_id
    and request.request_type = 'waiter'
    and request.status in ('pending', 'attended')
  order by request.created_at desc, request.id desc
  limit 1;

  if target_request.resolved_by_member_id is not null then
    select m.display_name into v_waiter_name
    from public.restaurant_members as m
    where m.id = target_request.resolved_by_member_id;
  end if;

  return jsonb_build_object(
    'guest_session_id', target_session.id,
    'request',
      case
        when target_request.id is null then null
        else to_jsonb(target_request) || jsonb_build_object('waiter_name', v_waiter_name)
      end
  );
end;
$$;

revoke all privileges
  on function public.get_waiter_request_state(text, integer)
  from public, anon, authenticated;

grant execute
  on function public.get_waiter_request_state(text, integer)
  to authenticated;

commit;
