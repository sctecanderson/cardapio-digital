begin;

alter table public.service_requests add column table_tab_id uuid;

-- Não atribuir silenciosamente chamados antigos à comanda errada.
do $$
begin
  if exists (select 1 from public.service_requests where request_type = 'bill') then
    raise exception 'Existem pedidos de conta anteriores sem comanda. Revise esses registros antes de aplicar esta migração.';
  end if;
end;
$$;

alter table public.service_requests
  add constraint service_requests_bill_requires_tab check (
    (request_type = 'waiter' and table_tab_id is null)
    or (request_type = 'bill' and table_tab_id is not null and table_visit_id is not null)
  ),
  add constraint service_requests_tab_same_visit
    foreign key (table_tab_id, table_visit_id, restaurant_id, restaurant_table_id)
    references public.table_tabs(id, table_visit_id, restaurant_id, restaurant_table_id)
    on delete restrict;

drop index public.service_requests_one_pending_per_table_type;

create unique index service_requests_one_pending_waiter_per_table
  on public.service_requests(restaurant_table_id)
  where status = 'pending' and request_type = 'waiter';

create unique index service_requests_one_pending_bill_per_tab
  on public.service_requests(table_tab_id)
  where status = 'pending' and request_type = 'bill';

create index service_requests_tab_created_idx
  on public.service_requests(table_tab_id, created_at desc, id desc)
  where table_tab_id is not null;

-- Todos os clientes vinculados à mesma comanda acompanham o mesmo pedido.
-- A política de table_tabs já exige sessão própria, confirmada e válida.
create policy service_requests_read_by_tab_guests
  on public.service_requests for select to authenticated using (
    coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false)
    and request_type = 'bill'
    and exists (
      select 1 from public.table_tabs as tab
      where tab.id = service_requests.table_tab_id
        and tab.table_visit_id = service_requests.table_visit_id
        and tab.restaurant_id = service_requests.restaurant_id
        and tab.restaurant_table_id = service_requests.restaurant_table_id
    )
  );

create function public.request_table_tab_bill(
  p_restaurant_slug text, p_table_tab_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
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

  select restaurant.id into target_restaurant_id from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug and restaurant.active for share;
  if not found then
    raise exception using errcode = '42501', message = 'Restaurante indisponível.';
  end if;

  select tab.restaurant_table_id, tab.table_visit_id into target_table_id, target_visit_id
  from public.table_tabs as tab where tab.id = p_table_tab_id and tab.restaurant_id = target_restaurant_id;
  if not found then
    raise exception using errcode = '42501', message = 'Comanda indisponível para este acesso.';
  end if;

  perform restaurant_table.id from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id and restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.active for update;
  if not found then
    raise exception using errcode = '22023', message = 'Mesa indisponível.';
  end if;

  -- Compartilha a janela de cinco ações por minuto com Chamar garçom.
  -- Ordem de bloqueio compatível: restaurante, mesa, limitador, atendimento.
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

  select visit.* into target_visit from public.table_visits as visit
  where visit.id = target_visit_id and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id for update;
  if not found or target_visit.status <> 'open' then
    raise exception using errcode = '22023', message = 'O atendimento desta mesa já foi encerrado.';
  end if;

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_restaurant_id and tab.restaurant_table_id = target_table_id for update;
  if not found or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Esta comanda não está aberta.';
  end if;

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

  select request.* into target_request from public.service_requests as request
  where request.table_tab_id = target_tab.id and request.restaurant_id = target_restaurant_id
    and request.request_type = 'bill' and request.status = 'pending' for update;
  if found then
    return jsonb_build_object('status', 'existing', 'request', to_jsonb(target_request));
  end if;

  insert into public.service_requests(
    restaurant_id, restaurant_table_id, table_visit_id, table_tab_id, request_type, created_at
  ) values (
    target_restaurant_id, target_table_id, target_visit.id, target_tab.id, 'bill', clock_timestamp()
  ) returning * into target_request;
  return jsonb_build_object('status', 'created', 'request', to_jsonb(target_request));
end;
$$;

create function public.attend_table_tab_bill(
  p_restaurant_slug text, p_service_request_id uuid
)
returns public.service_requests language plpgsql security definer set search_path = '' as $$
declare
  target_visit_id uuid;
  target_tab_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_request public.service_requests%rowtype;
begin
  if p_service_request_id is null then
    raise exception using errcode = '22023', message = 'Informe a solicitação de conta.';
  end if;
  select request.table_visit_id, request.table_tab_id into target_visit_id, target_tab_id
  from public.service_requests as request
  join public.restaurants as restaurant on restaurant.id = request.restaurant_id
  where request.id = p_service_request_id and request.request_type = 'bill'
    and restaurant.slug = p_restaurant_slug and restaurant.active;
  if not found then
    raise exception using errcode = '22023', message = 'Solicitação de conta não encontrada neste restaurante.';
  end if;

  target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);
  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = target_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada.';
  end if;
  select request.* into target_request from public.service_requests as request
  where request.id = p_service_request_id and request.table_tab_id = target_tab.id
    and request.table_visit_id = target_visit.id and request.restaurant_id = target_visit.restaurant_id
    and request.restaurant_table_id = target_visit.restaurant_table_id
    and request.request_type = 'bill' for update;
  if not found then
    raise exception using errcode = '22023', message = 'Solicitação de conta não encontrada.';
  end if;
  if target_request.status = 'attended' then
    if target_request.resolved_by_member_id is distinct from target_visit.assigned_member_id then
      raise exception using errcode = '42501', message = 'Esta solicitação já foi atendida por outro funcionário.';
    end if;
    return target_request;
  end if;
  if target_request.status = 'cancelled' then
    raise exception using errcode = '22023', message = 'Esta solicitação foi cancelada. Atualize a fila.';
  end if;
  if target_visit.status <> 'open' or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Esta comanda ou atendimento já foi encerrado.';
  end if;

  update public.service_requests set status = 'attended',
    resolved_at = greatest(clock_timestamp(), target_request.created_at),
    resolved_by_member_id = target_visit.assigned_member_id
  where id = target_request.id returning * into target_request;
  return target_request;
end;
$$;

create function public.cancel_pending_bill_on_tab_close()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.service_requests set status = 'cancelled',
    resolved_at = greatest(clock_timestamp(), new.closed_at, created_at),
    resolved_by_member_id = new.closed_by_member_id
  where table_tab_id = new.id and restaurant_id = new.restaurant_id
    and table_visit_id = new.table_visit_id and restaurant_table_id = new.restaurant_table_id
    and request_type = 'bill' and status = 'pending';
  return new;
end;
$$;

create trigger table_tabs_cancel_pending_bill
after update of status on public.table_tabs for each row
when (old.status = 'open' and new.status = 'closed')
execute function public.cancel_pending_bill_on_tab_close();

revoke all privileges on function public.cancel_pending_bill_on_tab_close() from public, anon, authenticated;
revoke all privileges on function public.request_table_tab_bill(text, uuid),
  public.attend_table_tab_bill(text, uuid) from public, anon, authenticated;
grant execute on function public.request_table_tab_bill(text, uuid),
  public.attend_table_tab_bill(text, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
