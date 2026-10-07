import { supabase } from '../../lib/supabase';

export interface TableVisit {
  id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  assigned_member_id: string | null;
  status: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
}

export async function openTableVisit(
  restaurantSlug: string,
  tableNumber: number,
): Promise<TableVisit> {
  if (
    !Number.isInteger(tableNumber) ||
    tableNumber < 1 ||
    tableNumber > 999
  ) {
    throw new Error('Informe um número de mesa válido.');
  }

  const { data, error } = await supabase.rpc('open_table_visit', {
    p_restaurant_slug: restaurantSlug,
    p_table_number: tableNumber,
  });

  if (error) {
    if (error.code === '42501' || error.code === '22023') {
      throw new Error(error.message);
    }

    throw new Error(
      'Não foi possível abrir o atendimento. Tente novamente.',
    );
  }

  if (!data) {
    throw new Error('O atendimento não foi retornado pelo servidor.');
  }

  return data as TableVisit;
}

export interface OpenTableVisit extends TableVisit {
  table: {
    table_number: number;
  };
}

export async function listMyOpenTableVisits(
  restaurantId: string,
  memberId: string,
): Promise<OpenTableVisit[]> {
  const { data, error } = await supabase
    .from('table_visits')
    .select(`
      *,
      table:restaurant_tables!inner(table_number)
    `)
    .eq('restaurant_id', restaurantId)
    .eq('assigned_member_id', memberId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .overrideTypes<OpenTableVisit[], { merge: false }>();

  if (error) {
    throw new Error(
      'Não foi possível carregar seus atendimentos. Tente novamente.',
    );
  }

  return data ?? [];
}

export async function closeTableVisit(
  restaurantSlug: string,
  tableVisitId: string,
): Promise<TableVisit> {
  if (!tableVisitId.trim()) {
    throw new Error('Informe o atendimento que deseja encerrar.');
  }

  const { data, error } = await supabase
    .rpc('close_table_visit', {
      p_restaurant_slug: restaurantSlug,
      p_table_visit_id: tableVisitId,
    })
    .single()
    .overrideTypes<TableVisit, { merge: false }>();

  if (error) {
    if (error.code === '42501' || error.code === '22023') {
      throw new Error(error.message);
    }

    throw new Error(
      'Não foi possível encerrar o atendimento. Tente novamente.',
    );
  }

  if (
    !data ||
    data.id !== tableVisitId ||
    data.status !== 'closed'
  ) {
    throw new Error(
      'O encerramento não foi confirmado pelo servidor.',
    );
  }

  return data;
}