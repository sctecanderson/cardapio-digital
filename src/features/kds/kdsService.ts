import { supabase } from '../../lib/supabase';

export type PreparationStation = 'kitchen' | 'bar' | 'none';
export type ProductionStatus = 'pending' | 'preparing' | 'ready' | 'delivered';
export type KdsFilterStation = 'all' | 'kitchen' | 'bar';

export interface KdsItem {
  id: string;
  table_tab_id: string;
  table_visit_id: string;
  restaurant_table_id: string;
  table_number: number;
  table_name: string;
  product_name: string;
  quantity: number;
  preparation_station: PreparationStation;
  production_status: ProductionStatus;
  created_at: string;
  prep_started_at: string | null;
  prep_ready_at: string | null;
  prep_delivered_at: string | null;
}

interface RawTabItem {
  id: string;
  table_tab_id: string;
  table_visit_id: string;
  restaurant_table_id: string;
  product_name: string;
  quantity: number;
  preparation_station: string | null;
  production_status: string | null;
  status: string;
  created_at: string;
  prep_started_at: string | null;
  prep_ready_at: string | null;
  prep_delivered_at: string | null;
}

/**
 * Busca os itens em produção ativa no restaurante (pending, preparing, ready).
 * Apenas itens pertencentes a comandas e atendimentos atualmente abertos são retornados.
 */
export async function fetchActiveKdsItems(restaurantSlug: string): Promise<KdsItem[]> {
  const { data: restaurant, error: restError } = await supabase
    .from('restaurants')
    .select('id')
    .eq('slug', restaurantSlug)
    .eq('active', true)
    .maybeSingle();

  if (restError || !restaurant) {
    throw new Error(restError?.message || 'Restaurante não encontrado.');
  }

  const restaurantId = restaurant.id;

  const [tablesRes, visitsRes, tabsRes, itemsRes] = await Promise.all([
    supabase
      .from('restaurant_tables')
      .select('id, table_number')
      .eq('restaurant_id', restaurantId),

    supabase
      .from('table_visits')
      .select('id, status')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'open'),

    supabase
      .from('table_tabs')
      .select('id, status')
      .eq('restaurant_id', restaurantId)
      .eq('status', 'open'),

    supabase
      .from('table_tab_items')
      .select(`
        id,
        table_tab_id,
        table_visit_id,
        restaurant_table_id,
        product_name,
        quantity,
        preparation_station,
        production_status,
        status,
        created_at,
        prep_started_at,
        prep_ready_at,
        prep_delivered_at
      `)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'active')
      .in('production_status', ['pending', 'preparing', 'ready'])
      .order('created_at', { ascending: true }),
  ]);

  if (itemsRes.error) {
    throw new Error(itemsRes.error.message || 'Erro ao carregar itens da esteira KDS.');
  }

  const openVisitIds = new Set((visitsRes.data ?? []).map((v) => v.id));
  const openTabIds = new Set((tabsRes.data ?? []).map((t) => t.id));
  const tableNumberMap = new Map<string, number>();

  for (const table of tablesRes.data ?? []) {
    tableNumberMap.set(table.id, table.table_number);
  }

  const rawItems = (itemsRes.data ?? []) as unknown as RawTabItem[];

  const activeKdsItems: KdsItem[] = [];

  for (const item of rawItems) {
    // Filtro estrito: comanda e visita devem estar abertas
    if (!openVisitIds.has(item.table_visit_id) || !openTabIds.has(item.table_tab_id)) {
      continue;
    }

    const tableNum = tableNumberMap.get(item.restaurant_table_id) ?? 0;
    const tableName = tableNum > 0 ? `Mesa ${String(tableNum).padStart(2, '0')}` : 'Mesa';

    activeKdsItems.push({
      id: item.id,
      table_tab_id: item.table_tab_id,
      table_visit_id: item.table_visit_id,
      restaurant_table_id: item.restaurant_table_id,
      table_number: tableNum,
      table_name: tableName,
      product_name: item.product_name,
      quantity: item.quantity,
      preparation_station: (item.preparation_station as PreparationStation) || 'kitchen',
      production_status: (item.production_status as ProductionStatus) || 'pending',
      created_at: item.created_at,
      prep_started_at: item.prep_started_at,
      prep_ready_at: item.prep_ready_at,
      prep_delivered_at: item.prep_delivered_at,
    });
  }

  return activeKdsItems;
}

/**
 * Traduz mensagens técnicas do PostgreSQL / RPC para texto amigável de exibição.
 */
function mapKdsErrorMessage(rawMessage: string): string {
  if (rawMessage.includes('42501') || rawMessage.toLowerCase().includes('permissão') || rawMessage.toLowerCase().includes('acesso')) {
    return 'Você não possui permissão para atualizar este pedido.';
  }
  if (rawMessage.toLowerCase().includes('comanda encerrada') || rawMessage.toLowerCase().includes('closed')) {
    return 'A comanda deste pedido já foi encerrada.';
  }
  if (rawMessage.toLowerCase().includes('cancelado') || rawMessage.toLowerCase().includes('cancelled')) {
    return 'Este pedido foi cancelado e não pode ser produzido.';
  }
  if (rawMessage.toLowerCase().includes('transição de produção inválida') || rawMessage.includes('22023')) {
    return 'Ação não permitida para o estado atual deste pedido.';
  }
  return rawMessage || 'Ocorreu uma falha ao atualizar o pedido. Tente novamente.';
}

/**
 * Invoca a RPC transacional segura para avançar o estado de produção de um item.
 */
export async function advanceKdsItemStatus(
  restaurantSlug: string,
  itemId: string,
  targetStatus: ProductionStatus
): Promise<{ success: boolean; data?: KdsItem; error?: string }> {
  try {
    const { data, error } = await supabase.rpc('update_tab_item_production_status', {
      p_restaurant_slug: restaurantSlug,
      p_item_id: itemId,
      p_target_status: targetStatus,
    });

    if (error) {
      return { success: false, error: mapKdsErrorMessage(error.message) };
    }

    return { success: true, data: data as unknown as KdsItem };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha na comunicação com o servidor.';
    return { success: false, error: mapKdsErrorMessage(message) };
  }
}

/**
 * Registra a subscrição em tempo real com debounce para novos pedidos e atualizações de status.
 */
export function subscribeToKdsItems(
  restaurantId: string,
  onUpdate: () => void,
  onStatusChange?: (status: 'SUBSCRIBED' | 'DISCONNECTED' | 'CONNECTING') => void
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const triggerDebounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onUpdate();
    }, 250);
  };

  const channel = supabase
    .channel(`kds-realtime:${restaurantId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'table_tab_items',
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      triggerDebounced
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'table_tab_items',
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      triggerDebounced
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'table_tabs',
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      triggerDebounced
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        onStatusChange?.('SUBSCRIBED');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onStatusChange?.('DISCONNECTED');
      } else {
        onStatusChange?.('CONNECTING');
      }
    });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    void supabase.removeChannel(channel);
  };
}
