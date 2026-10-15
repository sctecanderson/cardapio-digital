-- ============================================================================
-- BLOCO 13.2: LEITURA SEGURA DE MESA PÚBLICA POR QR CODE (UUID)
-- ============================================================================

begin;

-- Permitir leitura da tabela restaurant_tables por visitantes anônimos e clientes autenticados
grant select on table public.restaurant_tables to anon, authenticated;

-- Política de RLS para consulta de mesas ativas e não excluídas
drop policy if exists restaurant_tables_read_public on public.restaurant_tables;
create policy restaurant_tables_read_public
  on public.restaurant_tables
  for select
  to anon, authenticated
  using (
    (coalesce(is_active, active, true) = true)
    and deleted_at is null
  );

-- RPC de suporte para busca canônica da mesa por UUID com validação de status SaaS
create or replace function public.get_public_table_by_id(p_table_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'restaurantId', t.restaurant_id,
    'tableNumber', t.table_number,
    'label', t.label,
    'active', coalesce(t.is_active, t.active, true),
    'deletedAt', t.deleted_at,
    'restaurantSlug', r.slug,
    'restaurantBillingStatus', public.get_restaurant_billing_status(r.subscription_expires_at)
  )
  from public.restaurant_tables as t
  join public.restaurants as r on r.id = t.restaurant_id
  where t.id = p_table_id
    and t.deleted_at is null
    and coalesce(t.is_active, t.active, true) = true
    and r.active = true;
$$;

revoke all on function public.get_public_table_by_id(uuid) from public;
grant execute on function public.get_public_table_by_id(uuid) to anon, authenticated;

commit;
