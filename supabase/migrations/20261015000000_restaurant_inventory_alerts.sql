-- ============================================================================
-- BLOCO 14: CONTROLE DE ESTOQUE, LIMITE DE RUPTURA E CENTRAL DE ALERTAS
-- ============================================================================

begin;

-- ============================================================================
-- 1. TABELA DE ESTOQUE: public.inventory_items
-- ============================================================================
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  category text not null default 'geral' check (char_length(trim(category)) between 2 and 60),
  unit_measure text not null default 'un' check (unit_measure in ('un', 'kg', 'g', 'l', 'ml', 'cx', 'pct')),
  current_quantity numeric(10,2) not null default 0 check (current_quantity >= 0),
  alert_threshold numeric(10,2) not null default 5 check (alert_threshold >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists inventory_items_restaurant_id_idx
  on public.inventory_items (restaurant_id);

create index if not exists inventory_items_restaurant_category_idx
  on public.inventory_items (restaurant_id, category);

-- Trigger para atualização automática de updated_at
create or replace function public.handle_inventory_items_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  NEW.updated_at = timezone('utc', now());
  return NEW;
end;
$$;

drop trigger if exists trg_inventory_items_updated_at on public.inventory_items;
create trigger trg_inventory_items_updated_at
  before update on public.inventory_items
  for each row
  execute function public.handle_inventory_items_updated_at();

-- ============================================================================
-- 2. TABELA DE ALERTAS: public.restaurant_alerts
-- ============================================================================
create table if not exists public.restaurant_alerts (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  type text not null check (type in ('low_stock', 'system')),
  title text not null,
  message text not null,
  is_read boolean not null default false,
  reference_id uuid null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists restaurant_alerts_restaurant_unread_idx
  on public.restaurant_alerts (restaurant_id, is_read, created_at desc);

create index if not exists restaurant_alerts_reference_id_idx
  on public.restaurant_alerts (reference_id);

-- ============================================================================
-- 3. TRIGGER ANTI-SPAM DE LIMITE DE RUPTURA / ESTOQUE CRÍTICO
-- ============================================================================
-- Dispara apenas quando o estoque cai de um valor acima do limite para um valor
-- menor ou igual ao limite configurado. Deduções sucessivas no mesmo estado não duplicam.
create or replace function public.check_inventory_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if NEW.current_quantity <= NEW.alert_threshold and OLD.current_quantity > NEW.alert_threshold then
    insert into public.restaurant_alerts (
      restaurant_id,
      type,
      title,
      message,
      reference_id
    ) values (
      NEW.restaurant_id,
      'low_stock',
      'Estoque Crítico: ' || NEW.name,
      'O item "' || NEW.name || '" atingiu o nível crítico (' || trim(to_char(NEW.current_quantity, 'FM999999990.##')) || ' ' || NEW.unit_measure || '). Limite configurado: ' || trim(to_char(NEW.alert_threshold, 'FM999999990.##')) || ' ' || NEW.unit_measure || '.',
      NEW.id
    );
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_check_inventory_alert on public.inventory_items;
create trigger trg_check_inventory_alert
  after update of current_quantity on public.inventory_items
  for each row
  execute function public.check_inventory_alert();

-- ============================================================================
-- 4. POLÍTICAS DE SEGURANÇA (RLS)
-- ============================================================================
alter table public.inventory_items enable row level security;
alter table public.restaurant_alerts enable row level security;

-- Permissões de Leitura para inventory_items
drop policy if exists inventory_items_read on public.inventory_items;
create policy inventory_items_read on public.inventory_items
  for select
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = inventory_items.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and restaurant.active = true
    )
  );

-- Permissões de Inserção para inventory_items (apenas admins ou platform admin)
drop policy if exists inventory_items_insert on public.inventory_items;
create policy inventory_items_insert on public.inventory_items
  for insert
  to authenticated
  with check (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = inventory_items.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role = 'admin'
        and restaurant.active = true
    )
  );

-- Permissões de Atualização para inventory_items (admins e equipe podem atualizar estoque)
drop policy if exists inventory_items_update on public.inventory_items;
create policy inventory_items_update on public.inventory_items
  for update
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = inventory_items.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role in ('admin', 'waiter')
        and restaurant.active = true
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = inventory_items.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role in ('admin', 'waiter')
        and restaurant.active = true
    )
  );

-- Permissões de Exclusão para inventory_items (apenas admins ou platform admin)
drop policy if exists inventory_items_delete on public.inventory_items;
create policy inventory_items_delete on public.inventory_items
  for delete
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = inventory_items.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role = 'admin'
        and restaurant.active = true
    )
  );

-- Permissões para restaurant_alerts:
-- Leitura
drop policy if exists restaurant_alerts_read on public.restaurant_alerts;
create policy restaurant_alerts_read on public.restaurant_alerts
  for select
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = restaurant_alerts.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and restaurant.active = true
    )
  );

-- Atualização (marcar como lido)
drop policy if exists restaurant_alerts_update on public.restaurant_alerts;
create policy restaurant_alerts_update on public.restaurant_alerts
  for update
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = restaurant_alerts.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and restaurant.active = true
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = restaurant_alerts.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and restaurant.active = true
    )
  );

-- Inserção de alertas manuais/sistema (admins)
drop policy if exists restaurant_alerts_insert on public.restaurant_alerts;
create policy restaurant_alerts_insert on public.restaurant_alerts
  for insert
  to authenticated
  with check (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = restaurant_alerts.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role = 'admin'
        and restaurant.active = true
    )
  );

-- Exclusão de alertas (apenas admins)
drop policy if exists restaurant_alerts_delete on public.restaurant_alerts;
create policy restaurant_alerts_delete on public.restaurant_alerts
  for delete
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as member
      join public.restaurants as restaurant on restaurant.id = member.restaurant_id
      where member.restaurant_id = restaurant_alerts.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
        and member.role = 'admin'
        and restaurant.active = true
    )
  );

-- Concessões
grant select, insert, update, delete on table public.inventory_items to authenticated;
grant select, insert, update, delete on table public.restaurant_alerts to authenticated;

-- ============================================================================
-- 5. PUBLICAÇÃO REALTIME
-- ============================================================================
do $$
declare
  target_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach target_table in array array['restaurant_alerts', 'inventory_items'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = target_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', target_table);
      end if;
    end loop;
  end if;
end;
$$;

commit;
