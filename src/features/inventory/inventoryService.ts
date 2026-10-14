import { supabase } from '../../lib/supabase';

export type UnitMeasure = 'un' | 'kg' | 'g' | 'l' | 'ml' | 'cx' | 'pct';

export interface InventoryItem {
  id: string;
  restaurant_id: string;
  name: string;
  category: string;
  unit_measure: UnitMeasure;
  current_quantity: number;
  alert_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface InventoryItemInput {
  name: string;
  category?: string;
  unit_measure: UnitMeasure;
  current_quantity: number;
  alert_threshold: number;
}

export async function fetchInventory(restaurantId: string): Promise<InventoryItem[]> {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('name', { ascending: true });

  if (error) {
    throw new Error(error.message || 'Erro ao carregar itens do estoque.');
  }

  return (data || []).map((row) => ({
    ...row,
    current_quantity: Number(row.current_quantity),
    alert_threshold: Number(row.alert_threshold),
  }));
}

export async function createInventoryItem(
  restaurantId: string,
  input: InventoryItemInput
): Promise<InventoryItem> {
  const { data, error } = await supabase
    .from('inventory_items')
    .insert({
      restaurant_id: restaurantId,
      name: input.name.trim(),
      category: input.category?.trim() || 'geral',
      unit_measure: input.unit_measure,
      current_quantity: Math.max(0, input.current_quantity),
      alert_threshold: Math.max(0, input.alert_threshold),
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message || 'Erro ao cadastrar item de estoque.');
  }

  return {
    ...data,
    current_quantity: Number(data.current_quantity),
    alert_threshold: Number(data.alert_threshold),
  };
}

export async function updateInventoryItem(
  id: string,
  input: Partial<InventoryItemInput>
): Promise<InventoryItem> {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.category !== undefined) payload.category = input.category.trim();
  if (input.unit_measure !== undefined) payload.unit_measure = input.unit_measure;
  if (input.current_quantity !== undefined) payload.current_quantity = Math.max(0, input.current_quantity);
  if (input.alert_threshold !== undefined) payload.alert_threshold = Math.max(0, input.alert_threshold);

  const { data, error } = await supabase
    .from('inventory_items')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(error.message || 'Erro ao atualizar item de estoque.');
  }

  return {
    ...data,
    current_quantity: Number(data.current_quantity),
    alert_threshold: Number(data.alert_threshold),
  };
}

export async function updateStockQuantity(
  id: string,
  newQuantity: number
): Promise<InventoryItem> {
  const qty = Math.max(0, Number(newQuantity.toFixed(2)));
  const { data, error } = await supabase
    .from('inventory_items')
    .update({ current_quantity: qty })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    throw new Error(error.message || 'Erro ao atualizar quantidade em estoque.');
  }

  return {
    ...data,
    current_quantity: Number(data.current_quantity),
    alert_threshold: Number(data.alert_threshold),
  };
}

export async function deleteInventoryItem(id: string): Promise<void> {
  const { error } = await supabase
    .from('inventory_items')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(error.message || 'Erro ao excluir item do estoque.');
  }
}

export function subscribeToInventory(
  restaurantId: string,
  onUpdate: () => void
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerDebounced = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onUpdate, 200);
  };

  const channel = supabase
    .channel(`inventory-realtime:${restaurantId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'inventory_items',
        filter: `restaurant_id=eq.${restaurantId}`,
      },
      triggerDebounced
    )
    .subscribe();

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    void supabase.removeChannel(channel);
  };
}
