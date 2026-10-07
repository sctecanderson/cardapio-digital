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