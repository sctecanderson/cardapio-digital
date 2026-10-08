import { supabase } from '../../lib/supabase';
import { getTabConsumption } from './tabConsumption';
import type { TabConsumptionItem } from './tabConsumption';

interface GuestTabReference {
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
  | (StateBase & { status: 'hidden' | 'waiting' })
  | (StateBase & {
      status: 'ready';
      tab: GuestTabReference;
      items: TabConsumptionItem[];
      totalInCents: number;
    });

export async function getGuestTabState(
  restaurantSlug: string,
  tableNumber: number,
): Promise<GuestTabState> {
  const base: StateBase = { userId: null, guestSessionId: null, tabId: null };
  const { data: authData, error: authError } = await supabase.auth.getSession();
  if (authError) throw new Error('Não foi possível verificar seu acesso.');
  const user = authData.session?.user;
  // Apenas recupera a identidade existente; não cria sessão nem faz login.
  if (!user?.is_anonymous) return { ...base, status: 'hidden' };
  base.userId = user.id;

  const { data: guest, error: guestError } = await supabase
    .rpc('get_guest_session', {
      p_restaurant_slug: restaurantSlug,
      p_table_number: tableNumber,
    })
    .maybeSingle()
    .overrideTypes<{ id: string; status: string }, { merge: false }>();
  if (guestError) throw new Error('Não foi possível recuperar sua presença na mesa.');
  if (!guest) return { ...base, status: 'hidden' };
  base.guestSessionId = guest.id;
  if (guest.status !== 'active') return { ...base, status: 'hidden' };

  const { data: link, error: linkError } = await supabase
    .from('table_tab_guests')
    .select('table_tab_id')
    .eq('guest_session_id', guest.id)
    .maybeSingle()
    .overrideTypes<{ table_tab_id: string }, { merge: false }>();
  if (linkError) throw new Error('Não foi possível localizar sua comanda.');
  if (!link) return { ...base, status: 'waiting' };

  const { data: tab, error: tabError } = await supabase
    .from('table_tabs')
    .select('id, restaurant_id, label, status')
    .eq('id', link.table_tab_id)
    .maybeSingle()
    .overrideTypes<GuestTabReference, { merge: false }>();
  if (tabError) throw new Error('Não foi possível carregar sua comanda.');
  if (!tab) return { ...base, status: 'hidden' };
  const consumption = await getTabConsumption(tab.restaurant_id, tab.id);

  return {
    ...base, status: 'ready', tabId: tab.id, tab,
    items: consumption.items, totalInCents: consumption.totalInCents,
  };
}
