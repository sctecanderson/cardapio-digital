import { supabase } from '../../lib/supabase';

export interface ConsumptionProduct {
  id: string;
  name: string;
  price_in_cents: number;
}

export interface TabConsumptionItem {
  id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  table_visit_id: string;
  table_tab_id: string;
  product_id: string;
  product_name: string;
  unit_price_in_cents: number;
  quantity: number;
  line_total_in_cents: number;
  status: 'active' | 'cancelled';
  added_by_member_id: string;
  created_at: string;
  cancelled_by_member_id: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

function operationError(error: { code?: string; message: string }, fallback: string) {
  return new Error(
    error.code === '42501' || error.code === '22023' ? error.message : fallback,
  );
}

interface TabConsumptionState {
  products: ConsumptionProduct[];
  items: TabConsumptionItem[];
  totalInCents: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isConsumptionProduct(value: unknown): value is ConsumptionProduct {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && isMoney(value.price_in_cents);
}

function isConsumptionItem(value: unknown): value is TabConsumptionItem {
  if (!isRecord(value)) return false;

  return typeof value.id === 'string'
    && typeof value.restaurant_id === 'string'
    && typeof value.restaurant_table_id === 'string'
    && typeof value.table_visit_id === 'string'
    && typeof value.table_tab_id === 'string'
    && typeof value.product_id === 'string'
    && typeof value.product_name === 'string'
    && isMoney(value.unit_price_in_cents)
    && typeof value.quantity === 'number'
    && Number.isInteger(value.quantity)
    && value.quantity >= 1 && value.quantity <= 99
    && isMoney(value.line_total_in_cents)
    && value.line_total_in_cents === value.unit_price_in_cents * value.quantity
    && (value.status === 'active' || value.status === 'cancelled')
    && typeof value.added_by_member_id === 'string'
    && typeof value.created_at === 'string'
    && isNullableString(value.cancelled_by_member_id)
    && isNullableString(value.cancelled_at)
    && isNullableString(value.cancellation_reason);
}

function parseTabConsumption(
  value: unknown,
  restaurantId: string,
  tableTabId: string,
): TabConsumptionState {
  if (!isRecord(value)) {
    throw new Error('O consumo não foi retornado corretamente ou não está acessível.');
  }

  const { products, items, totalInCents } = value;

  if (!Array.isArray(products) || !products.every(isConsumptionProduct)
    || !Array.isArray(items) || !items.every(isConsumptionItem)
    || !isMoney(totalInCents)) {
    throw new Error('O servidor retornou dados de consumo em formato inválido.');
  }

  let checkedTotal = 0;
  for (const item of items) {
    if (item.restaurant_id !== restaurantId || item.table_tab_id !== tableTabId) {
      throw new Error('O consumo recebido não corresponde à comanda selecionada.');
    }
    if (item.status !== 'active') continue;
    checkedTotal += item.line_total_in_cents;
    if (!Number.isSafeInteger(checkedTotal)) {
      throw new Error('O total ultrapassou o limite de cálculo desta interface.');
    }
  }

  if (checkedTotal !== totalInCents) {
    throw new Error('A lista de consumo não corresponde ao total informado pelo servidor.');
  }

  return { products, items, totalInCents };
}

export async function getTabConsumption(
  restaurantId: string,
  tableTabId: string,
): Promise<TabConsumptionState> {
  const { data, error } = await supabase.rpc('get_table_tab_consumption', {
    p_restaurant_id: restaurantId,
    p_table_tab_id: tableTabId,
  });

  if (error) {
    throw new Error('Não foi possível carregar o consumo. Tente novamente.');
  }

  // A RPC retorna JSON. Validamos o conteúdo antes de atribuir o tipo.
  return parseTabConsumption(data, restaurantId, tableTabId);
}

export async function addTabConsumption(
  restaurantSlug: string, tableTabId: string, productId: string,
  quantity: number, itemId: string,
) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new Error('Informe uma quantidade entre 1 e 99.');
  }
  const { data, error } = await supabase
    .rpc('add_table_tab_item', {
      p_restaurant_slug: restaurantSlug,
      p_table_tab_id: tableTabId,
      p_product_id: productId,
      p_quantity: quantity,
      p_item_id: itemId,
    })
    .single()
    .overrideTypes<TabConsumptionItem, { merge: false }>();

  if (error) throw operationError(error, 'Não foi possível registrar o consumo.');
  if (!data || data.id !== itemId || data.table_tab_id !== tableTabId ||
      data.product_id !== productId || data.quantity !== quantity) {
    throw new Error('O lançamento não foi confirmado. Atualize a comanda antes de tentar novamente.');
  }
  if (data.status === 'cancelled') {
    throw new Error('Este lançamento já foi cancelado. Atualize a comanda.');
  }
  return data;
}

export async function cancelTabConsumption(
  restaurantSlug: string, itemId: string, reason: string,
) {
  const normalizedReason = reason.trim();
  if (normalizedReason.length < 3 || normalizedReason.length > 300) {
    throw new Error('Informe um motivo entre 3 e 300 caracteres.');
  }
  const { data, error } = await supabase
    .rpc('cancel_table_tab_item', {
      p_restaurant_slug: restaurantSlug,
      p_item_id: itemId,
      p_reason: normalizedReason,
    })
    .single()
    .overrideTypes<TabConsumptionItem, { merge: false }>();

  if (error) throw operationError(error, 'Não foi possível cancelar o lançamento.');
  if (!data || data.id !== itemId || data.status !== 'cancelled') {
    throw new Error('O cancelamento não foi confirmado pelo servidor.');
  }
  return data;
}
