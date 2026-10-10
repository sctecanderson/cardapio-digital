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

export async function getGuestTabState(
  restaurantSlug: string,
  tableNumber: number,
): Promise<GuestTabState> {
  const base: StateBase = { userId: null, guestSessionId: null, tabId: null };
  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError) throw new Error('Não foi possível verificar seu acesso.');
  const user = authData.session?.user;
  if (!user?.is_anonymous) return { ...base, status: 'hidden' };
  base.userId = user.id;

  // Consultar a sessão mais recente do usuário anônimo
  const { data: latestSession, error: sessionError } = await supabase
    .from('guest_sessions')
    .select('id, status, table_visit_id, restaurant_table_id, created_at, expires_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
    .overrideTypes<{
      id: string;
      status: 'pending' | 'active' | 'revoked' | 'expired';
      table_visit_id: string | null;
      restaurant_table_id: string;
      created_at: string;
      expires_at: string;
    }, { merge: false }>();

  if (sessionError) {
    throw new Error('Não foi possível recuperar sua presença na mesa.');
  }

  if (!latestSession) {
    return { ...base, status: 'hidden' };
  }

  base.guestSessionId = latestSession.id;

  // Se a sessão foi revogada (pelo encerramento da mesa ou da visita)
  if (latestSession.status === 'revoked') {
    return { ...base, status: 'closed' };
  }

  if (latestSession.status === 'pending') {
    return { ...base, status: 'waiting', guestStatus: 'pending' };
  }

  if (latestSession.status !== 'active') {
    return { ...base, status: 'hidden' };
  }

  // Para sessão ativa, buscar o vínculo da comanda
  const { data: link, error: linkError } = await supabase
    .from('table_tab_guests')
    .select('table_tab_id')
    .eq('guest_session_id', latestSession.id)
    .maybeSingle()
    .overrideTypes<{ table_tab_id: string }, { merge: false }>();

  if (linkError) throw new Error('Não foi possível localizar sua comanda.');
  if (!link) return { ...base, status: 'waiting', guestStatus: 'active' };

  base.tabId = link.table_tab_id;

  const { data: tab, error: tabError } = await supabase
    .from('table_tabs')
    .select('id, restaurant_id, label, status')
    .eq('id', link.table_tab_id)
    .maybeSingle()
    .overrideTypes<GuestTabReference, { merge: false }>();

  if (tabError) throw new Error('Não foi possível carregar sua comanda.');
  if (!tab) return { ...base, status: 'hidden' };

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
