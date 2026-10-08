import { supabase } from '../../lib/supabase';

export interface TableTab {
  id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  table_visit_id: string;
  label: string;
  status: 'open' | 'closed';
  created_by_member_id: string;
  created_at: string;
  closed_by_member_id: string | null;
  closed_at: string | null;
}

export interface TableTabGuest {
  guest_session_id: string;
  table_tab_id: string;
  table_visit_id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  linked_by_member_id: string;
  linked_at: string;
}

export interface ConfirmedTabGuest {
  id: string;
  confirmed_at: string;
  expires_at: string;
}

export interface TableTabsState {
  tabs: TableTab[];
  guests: ConfirmedTabGuest[];
  links: TableTabGuest[];
}

function operationError(
  error: { code?: string; message: string },
  fallback: string,
) {
  return new Error(
    error.code === '42501' || error.code === '22023'
      ? error.message
      : fallback,
  );
}

export async function getTableTabsState(
  restaurantId: string,
  tableVisitId: string,
): Promise<TableTabsState> {
  const [tabsResult, guestsResult, linksResult] = await Promise.all([
    supabase
      .from('table_tabs')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('table_visit_id', tableVisitId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .overrideTypes<TableTab[], { merge: false }>(),

    supabase
      .from('guest_sessions')
      .select('id, confirmed_at, expires_at')
      .eq('restaurant_id', restaurantId)
      .eq('table_visit_id', tableVisitId)
      .eq('status', 'active')
      .order('confirmed_at', { ascending: true })
      .order('id', { ascending: true })
      .overrideTypes<ConfirmedTabGuest[], { merge: false }>(),

    supabase
      .from('table_tab_guests')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('table_visit_id', tableVisitId)
      .overrideTypes<TableTabGuest[], { merge: false }>(),
  ]);

  if (tabsResult.error || guestsResult.error || linksResult.error) {
    throw new Error(
      'Não foi possível carregar as comandas e os clientes. Tente novamente.',
    );
  }

  return {
    tabs: tabsResult.data ?? [],
    guests: guestsResult.data ?? [],
    links: linksResult.data ?? [],
  };
}

export async function createTableTab(
  restaurantSlug: string,
  tableVisitId: string,
  label: string,
  tableTabId: string,
): Promise<TableTab> {
  const { data, error } = await supabase
    .rpc('create_table_tab', {
      p_restaurant_slug: restaurantSlug,
      p_table_visit_id: tableVisitId,
      p_label: label.trim(),
      p_table_tab_id: tableTabId,
    })
    .single()
    .overrideTypes<TableTab, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível criar a comanda.');
  }

  if (
    !data ||
    data.id !== tableTabId ||
    data.table_visit_id !== tableVisitId
  ) {
    throw new Error(
      'Não foi possível confirmar a criação. Atualize a lista antes de tentar novamente.',
    );
  }

  return data;
}

export async function linkGuestToTableTab(
  restaurantSlug: string,
  tableTabId: string,
  guestSessionId: string,
): Promise<TableTabGuest> {
  const { data, error } = await supabase
    .rpc('link_guest_to_table_tab', {
      p_restaurant_slug: restaurantSlug,
      p_table_tab_id: tableTabId,
      p_guest_session_id: guestSessionId,
    })
    .single()
    .overrideTypes<TableTabGuest, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível vincular o cliente.');
  }

  if (
    !data ||
    data.table_tab_id !== tableTabId ||
    data.guest_session_id !== guestSessionId
  ) {
    throw new Error('O vínculo não foi confirmado pelo servidor.');
  }

  return data;
}

export async function closeTableTab(
  restaurantSlug: string,
  tableTabId: string,
): Promise<TableTab> {
  const { data, error } = await supabase
    .rpc('close_table_tab', {
      p_restaurant_slug: restaurantSlug,
      p_table_tab_id: tableTabId,
    })
    .single()
    .overrideTypes<TableTab, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível encerrar a comanda.');
  }

  if (!data || data.id !== tableTabId || data.status !== 'closed') {
    throw new Error('O encerramento não foi confirmado pelo servidor.');
  }

  return data;
}