import { supabase } from '../../lib/supabase';

export interface RestaurantAlert {
  id: string;
  restaurant_id: string;
  type: 'low_stock' | 'system' | 'call_waiter' | 'close_table_request' | 'dish_ready';
  title: string;
  message: string;
  is_read: boolean;
  reference_id: string | null;
  created_at: string;
}

export async function fetchUnreadAlerts(restaurantId: string): Promise<RestaurantAlert[]> {
  const { data, error } = await supabase
    .from('restaurant_alerts')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('is_read', false)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message || 'Erro ao carregar notificações do restaurante.');
  }

  return data || [];
}

export async function fetchAllAlerts(restaurantId: string, limit = 50): Promise<RestaurantAlert[]> {
  const { data, error } = await supabase
    .from('restaurant_alerts')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message || 'Erro ao carregar histórico de alertas.');
  }

  return data || [];
}

export async function markAlertAsRead(alertId: string): Promise<void> {
  const { error } = await supabase
    .from('restaurant_alerts')
    .update({ is_read: true })
    .eq('id', alertId);

  if (error) {
    throw new Error(error.message || 'Erro ao marcar alerta como lido.');
  }
}

export async function markAllAlertsAsRead(restaurantId: string): Promise<void> {
  const { error } = await supabase
    .from('restaurant_alerts')
    .update({ is_read: true })
    .eq('restaurant_id', restaurantId)
    .eq('is_read', false);

  if (error) {
    throw new Error(error.message || 'Erro ao marcar todos os alertas como lidos.');
  }
}

export function subscribeToAlerts(
  restaurantId: string,
  onUpdate: () => void,
  onNewAlert?: (alert: RestaurantAlert) => void
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerDebounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onUpdate, 200);
  };

  const channel = supabase
    .channel(`alerts-realtime:${restaurantId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'restaurant_alerts',
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      (payload) => {
        if (payload.eventType === 'INSERT' && payload.new) {
          const newAlert = payload.new as RestaurantAlert;
          if (!newAlert.is_read && onNewAlert) {
            onNewAlert(newAlert);
          }
        }
        triggerDebounced();
      }
    )
    .subscribe();

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    void supabase.removeChannel(channel);
  };
}
