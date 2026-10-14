import { supabase } from '../../lib/supabase';
import { getTabConsumption } from './tabConsumption';
import type { TabConsumptionItem } from './tabConsumption';

export interface GuestTabReference {
  id: string;
  restaurant_id: string;
  label: string;
  status: 'open' | 'closed';
}

interface StateBase {
  userId: string | null;
  guestSessionId: string | null;
  tabId: string | null;
  assignedWaiterName?: string | null;
}

export type GuestTabState =
  | (StateBase & { status: 'hidden' })
  | (StateBase & { status: 'waiting'; guestStatus?: string })
  | (StateBase & {
      status: 'ready';
      tab: GuestTabReference;
      items: TabConsumptionItem[];
      totalInCents: number;
    })
  | (StateBase & {
      status: 'closed';
      tab?: GuestTabReference;
      items?: TabConsumptionItem[];
      totalInCents?: number;
    });

export interface GuestTableTabSessionRpcResult {
  session_id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  status: 'pending' | 'active' | 'revoked' | 'expired';
  table_visit_id: string | null;
  table_tab_id: string | null;
  tab_status: 'open' | 'closed' | null;
  tab_label: string | null;
  created_at: string;
  expires_at: string;
}

export interface GuestTableTabContextRpcResult {
  session_id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  status: 'pending' | 'active' | 'revoked' | 'expired';
  table_visit_id: string | null;
  table_tab_id: string | null;
  tab_status: 'open' | 'closed' | null;
  tab_label: string | null;
  created_at: string;
  expires_at: string;
  totalInCents: number;
  items: TabConsumptionItem[];
  assignedWaiterName?: string | null;
}

export async function getGuestTabState(
  restaurantSlug: string,
  tableNumber: number,
): Promise<GuestTabState> {
  const base: StateBase = { userId: null, guestSessionId: null, tabId: null };

  if (
    !restaurantSlug ||
    typeof restaurantSlug !== 'string' ||
    !Number.isInteger(tableNumber) ||
    tableNumber < 1 ||
    tableNumber > 999
  ) {
    return { ...base, status: 'hidden' };
  }

  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError) {
    throw new Error('Não foi possível verificar seu acesso.');
  }

  const user = authData.session?.user;
  if (!user?.is_anonymous) {
    return { ...base, status: 'hidden' };
  }
  base.userId = user.id;

  // 1. Tenta consulta atômica completa via get_guest_table_tab_context
  // (inclui comanda, total e itens com status KDS em um único snapshot)
  const { data: ctxData, error: ctxError } = await supabase
    .rpc('get_guest_table_tab_context', {
      p_restaurant_slug: restaurantSlug,
      p_table_number: tableNumber,
    })
    .maybeSingle()
    .overrideTypes<GuestTableTabContextRpcResult, { merge: false }>();

  if (!ctxError && ctxData) {
    base.guestSessionId = ctxData.session_id;
    base.assignedWaiterName = ctxData.assignedWaiterName ?? null;

    if (ctxData.status === 'revoked') {
      return { ...base, status: 'closed' };
    }
    if (ctxData.status === 'expired') {
      return { ...base, status: 'hidden' };
    }
    if (ctxData.status === 'pending') {
      return { ...base, status: 'waiting', guestStatus: 'pending' };
    }
    if (ctxData.status === 'active') {
      if (!ctxData.table_tab_id) {
        return { ...base, status: 'waiting', guestStatus: 'active' };
      }

      base.tabId = ctxData.table_tab_id;
      const tab: GuestTabReference = {
        id: ctxData.table_tab_id,
        restaurant_id: ctxData.restaurant_id,
        label: ctxData.tab_label || 'Comanda da Mesa',
        status: ctxData.tab_status === 'closed' ? 'closed' : 'open',
      };

      if (tab.status === 'closed') {
        return {
          ...base,
          status: 'closed',
          tab,
          items: ctxData.items || [],
          totalInCents: ctxData.totalInCents || 0,
        };
      }

      return {
        ...base,
        status: 'ready',
        tabId: tab.id,
        tab,
        items: ctxData.items || [],
        totalInCents: ctxData.totalInCents || 0,
      };
    }

    return { ...base, status: 'hidden' };
  }

  // 2. Fallback: consulta clássica através de get_guest_table_tab_session
  const { data: rpcData, error: rpcError } = await supabase
    .rpc('get_guest_table_tab_session', {
      p_restaurant_slug: restaurantSlug,
      p_table_number: tableNumber,
    })
    .maybeSingle()
    .overrideTypes<GuestTableTabSessionRpcResult, { merge: false }>();

  if (rpcError) {
    throw new Error(`Não foi possível carregar os dados da mesa: ${rpcError.message}`);
  }

  // RPC bem-sucedida sem resultado: mesa/cliente sem sessão vinculada
  if (!rpcData) {
    return { ...base, status: 'hidden' };
  }

  base.guestSessionId = rpcData.session_id;

  if (rpcData.status === 'revoked') {
    return { ...base, status: 'closed' };
  }

  if (rpcData.status === 'expired') {
    return { ...base, status: 'hidden' };
  }

  if (rpcData.status === 'pending') {
    return { ...base, status: 'waiting', guestStatus: 'pending' };
  }

  if (rpcData.status === 'active') {
    if (!rpcData.table_tab_id) {
      return { ...base, status: 'waiting', guestStatus: 'active' };
    }

    base.tabId = rpcData.table_tab_id;

    const tab: GuestTabReference = {
      id: rpcData.table_tab_id,
      restaurant_id: rpcData.restaurant_id,
      label: rpcData.tab_label || 'Comanda da Mesa',
      status: rpcData.tab_status === 'closed' ? 'closed' : 'open',
    };

    if (tab.status === 'closed') {
      return { ...base, status: 'closed', tab };
    }

    const consumption = await getTabConsumption(tab.restaurant_id, tab.id);

    return {
      ...base,
      status: 'ready',
      tabId: tab.id,
      tab,
      items: consumption.items,
      totalInCents: consumption.totalInCents,
    };
  }

  return { ...base, status: 'hidden' };
}
