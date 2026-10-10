import { supabase } from '../../lib/supabase';
import type { ServiceRequest } from './serviceRequests';

export interface BillRequest extends ServiceRequest {
  table_tab_id: string;
  table_visit_id: string;
  request_type: 'bill';
  include_service_fee: boolean | null;
}

export interface PendingBillRequest extends BillRequest {
  table: { table_number: number };
  visit: { assigned_member_id: string | null };
  tab: { label: string; status: 'open' | 'closed' };
}

export type RequestBillResult =
  | { status: 'created' | 'existing'; request: BillRequest }
  | { status: 'rate_limited'; retryAfterSeconds: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseBillRequest(value: unknown): BillRequest {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.restaurant_id !== 'string'
    || typeof value.restaurant_table_id !== 'string'
    || typeof value.table_visit_id !== 'string'
    || typeof value.table_tab_id !== 'string'
    || value.request_type !== 'bill'
    || (value.status !== 'pending' && value.status !== 'attended' && value.status !== 'cancelled')
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || !isNullableString(value.resolved_at)
    || !isNullableString(value.resolved_by_member_id)) {
    throw new Error('O servidor retornou uma solicitação de conta inválida.');
  }
  const include_service_fee = typeof value.include_service_fee === 'boolean' ? value.include_service_fee : null;
  return {
    id: value.id, restaurant_id: value.restaurant_id,
    restaurant_table_id: value.restaurant_table_id, table_visit_id: value.table_visit_id,
    table_tab_id: value.table_tab_id, request_type: 'bill', status: value.status,
    created_at: value.created_at, resolved_at: value.resolved_at,
    resolved_by_member_id: value.resolved_by_member_id,
    include_service_fee,
  };
}

function operationError(error: { code?: string; message: string }, fallback: string) {
  return new Error(error.code === '42501' || error.code === '22023' ? error.message : fallback);
}

export async function getBillRequestState(tableTabId: string): Promise<BillRequest | null> {
  const { data, error } = await supabase
    .from('service_requests')
    .select('id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id, request_type, status, created_at, resolved_at, resolved_by_member_id, include_service_fee')
    .eq('table_tab_id', tableTabId)
    .eq('request_type', 'bill')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Não foi possível consultar a solicitação de conta.');
  if (data === null) return null;
  const request = parseBillRequest(data);
  if (request.table_tab_id !== tableTabId) throw new Error('Solicitação de outra comanda.');
  return request;
}

export async function requestBill(
  restaurantSlug: string,
  tableTabId: string,
  includeServiceFee?: boolean,
): Promise<RequestBillResult> {
  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError || !authData.session?.user.is_anonymous) {
    throw new Error('Utilize seu acesso de cliente para pedir a conta.');
  }
  const { data, error } = await supabase.rpc('request_table_tab_bill', {
    p_restaurant_slug: restaurantSlug,
    p_table_tab_id: tableTabId,
    p_include_service_fee: includeServiceFee ?? false,
  });
  if (error) throw operationError(error, 'Não foi possível pedir a conta. Tente novamente.');
  if (!isRecord(data)) throw new Error('O servidor não confirmou sua solicitação.');
  if (data.status === 'rate_limited') {
    const seconds = data.retry_after_seconds;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1) {
      throw new Error('O servidor retornou um tempo de espera inválido.');
    }
    return { status: 'rate_limited', retryAfterSeconds: seconds };
  }
  if (data.status !== 'created' && data.status !== 'existing') {
    throw new Error('O servidor não confirmou sua solicitação.');
  }
  const request = parseBillRequest(data.request);
  if (request.table_tab_id !== tableTabId || request.status !== 'pending') {
    throw new Error('O servidor não confirmou um pedido pendente para esta comanda.');
  }
  return { status: data.status, request };
}

export async function listPendingBillRequests(restaurantId: string): Promise<PendingBillRequest[]> {
  const { data, error } = await supabase
    .from('service_requests')
    .select(`
      *,
      table:restaurant_tables!inner(table_number),
      visit:table_visits!inner(assigned_member_id),
      tab:table_tabs!inner(label, status)
    `)
    .eq('restaurant_id', restaurantId)
    .eq('request_type', 'bill')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .overrideTypes<PendingBillRequest[], { merge: false }>();
  if (error) throw new Error('Não foi possível carregar os pedidos de conta.');
  return data ?? [];
}

export async function attendBillRequest(restaurantSlug: string, requestId: string): Promise<BillRequest> {
  const { data, error } = await supabase.rpc('attend_table_tab_bill', {
    p_restaurant_slug: restaurantSlug, p_service_request_id: requestId,
  }).single();
  if (error) throw operationError(error, 'Não foi possível atender o pedido de conta.');
  const request = parseBillRequest(data);
  if (request.id !== requestId || request.status !== 'attended') {
    throw new Error('O atendimento do pedido de conta não foi confirmado.');
  }
  return request;
}

export interface CancelBillResult {
  status: 'cancelled';
  requestId: string;
  tableTabId: string;
}

export async function cancelBillRequest(restaurantSlug: string, tableTabId: string): Promise<CancelBillResult> {
  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError || !authData.session?.user.is_anonymous) {
    throw new Error('Utilize seu acesso de cliente para cancelar o pedido de conta.');
  }

  const { data, error } = await supabase.rpc('cancel_table_tab_bill', {
    p_restaurant_slug: restaurantSlug,
    p_table_tab_id: tableTabId,
  });

  if (error) throw operationError(error, 'Não foi possível cancelar o pedido de conta. Tente novamente.');
  if (!isRecord(data)) throw new Error('O servidor não confirmou o cancelamento da conta.');
  if (data.status !== 'cancelled' || typeof data.request_id !== 'string' || typeof data.table_tab_id !== 'string') {
    throw new Error('O servidor retornou uma resposta inválida.');
  }

  return {
    status: 'cancelled',
    requestId: data.request_id,
    tableTabId: data.table_tab_id,
  };
}
