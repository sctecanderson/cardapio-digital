begin;

-- Recupera de forma atômica e segura no servidor o contexto da comanda
-- e da sessão do cliente anônimo na mesa e restaurante informados.
create or replace function public.get_guest_table_tab_session(
  p_restaurant_slug text,
  p_table_number integer
)
returns table (
  session_id uuid,
  restaurant_id uuid,
  restaurant_table_id uuid,
  status text,
  table_visit_id uuid,
  table_tab_id uuid,
  tab_status text,
  tab_label text,
  created_at timestamptz,
  expires_at timestamptz
)
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
  v_tab record;
begin
  v_user_id := auth.uid();
  if v_user_id is null or not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return;
  end if;

  if p_restaurant_slug is null or length(btrim(p_restaurant_slug)) = 0 then
    return;
  end if;

  if p_table_number is null or p_table_number < 1 or p_table_number > 999 then
    return;
  end if;

  -- 1. Validar restaurante ativo
  select r.id into v_restaurant_id
  from public.restaurants as r
  where r.slug = p_restaurant_slug and r.active = true;

  if v_restaurant_id is null then
    return;
  end if;

  -- 2. Validar mesa ativa
  select rt.id into v_table_id
  from public.restaurant_tables as rt
  where rt.restaurant_id = v_restaurant_id
    and rt.table_number = p_table_number
    and rt.active = true;

  if v_table_id is null then
    return;
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
    return;
  end if;

  -- 4. Tratar explicitamente expiração temporal e status = 'expired'
  if v_session.status = 'expired' or v_session.expires_at <= now() then
    return query select
      v_session.id,
      v_session.restaurant_id,
      v_session.restaurant_table_id,
      'expired'::text,
      v_session.table_visit_id,
      null::uuid,
      null::text,
      null::text,
      v_session.created_at,
      v_session.expires_at;
    return;
  end if;

  -- 5. Tratar status = 'revoked'
  if v_session.status = 'revoked' then
    return query select
      v_session.id,
      v_session.restaurant_id,
      v_session.restaurant_table_id,
      'revoked'::text,
      v_session.table_visit_id,
      null::uuid,
      null::text,
      null::text,
      v_session.created_at,
      v_session.expires_at;
    return;
  end if;

  -- 6. Tratar status = 'pending'
  if v_session.status = 'pending' then
    return query select
      v_session.id,
      v_session.restaurant_id,
      v_session.restaurant_table_id,
      'pending'::text,
      v_session.table_visit_id,
      null::uuid,
      null::text,
      null::text,
      v_session.created_at,
      v_session.expires_at;
    return;
  end if;

  -- 7. SOMENTE seguir para atendimento e comanda quando status = 'active'
  if v_session.status <> 'active' then
    return;
  end if;

  -- Sessão ativa DEVE ter atendimento (table_visit_id) e estar aberto
  if v_session.table_visit_id is null then
    return query select
      v_session.id,
      v_session.restaurant_id,
      v_session.restaurant_table_id,
      'revoked'::text,
      v_session.table_visit_id,
      null::uuid,
      null::text,
      null::text,
      v_session.created_at,
      v_session.expires_at;
    return;
  end if;

  select v.status into v_visit_status
  from public.table_visits as v
  where v.id = v_session.table_visit_id
    and v.restaurant_id = v_restaurant_id
    and v.restaurant_table_id = v_table_id;

  if v_visit_status is distinct from 'open' then
    -- Atendimento foi encerrado no salão
    return query select
      v_session.id,
      v_session.restaurant_id,
      v_session.restaurant_table_id,
      'revoked'::text,
      v_session.table_visit_id,
      null::uuid,
      null::text,
      null::text,
      v_session.created_at,
      v_session.expires_at;
    return;
  end if;

  -- 8. Buscar comanda vinculada, validando explicitamente que pertence
  -- ao mesmo atendimento (table_visit_id), restaurante e mesa
  select
    tt.id as tab_id,
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
    and ttg.table_visit_id = v_session.table_visit_id
    and ttg.restaurant_id = v_restaurant_id
    and ttg.restaurant_table_id = v_table_id
  limit 1;

  return query select
    v_session.id,
    v_session.restaurant_id,
    v_session.restaurant_table_id,
    'active'::text,
    v_session.table_visit_id,
    v_tab.tab_id,
    v_tab.tab_status,
    v_tab.tab_label,
    v_session.created_at,
    v_session.expires_at;
end;
$$;

revoke all on function public.get_guest_table_tab_session(text, integer)
from public, anon, authenticated;

grant execute on function public.get_guest_table_tab_session(text, integer)
to authenticated;

commit;
