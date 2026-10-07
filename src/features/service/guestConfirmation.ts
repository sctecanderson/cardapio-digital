import { supabase } from '../../lib/supabase';

export type GuestConfirmationResult =
  | {
      status: 'confirmed';
      guest_session_id: string;
      table_visit_id: string;
    }
  | {
      status: 'invalid_code';
    }
  | {
      status: 'rate_limited';
      retry_after_seconds: number;
    };

export async function confirmGuestSession(
  restaurantSlug: string,
  tableNumber: number,
  code: string,
): Promise<GuestConfirmationResult> {
  if (
    !Number.isInteger(tableNumber) ||
    tableNumber < 1 ||
    tableNumber > 999
  ) {
    throw new Error('Informe um número de mesa válido.');
  }

  if (!/^[0-9]{6}$/.test(code)) {
    throw new Error('Informe os seis dígitos do código.');
  }

  const { data, error } = await supabase.rpc(
    'confirm_guest_session',
    {
      p_restaurant_slug: restaurantSlug,
      p_table_number: tableNumber,
      p_code: code,
    },
  );

  if (error) {
    if (error.code === '42501' || error.code === '22023') {
      throw new Error(error.message);
    }

    throw new Error(
      'Não foi possível confirmar o cliente. Tente novamente.',
    );
  }

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data)
  ) {
    throw new Error('O servidor retornou um resultado inválido.');
  }

  if (
    data.status === 'confirmed' &&
    typeof data.guest_session_id === 'string' &&
    typeof data.table_visit_id === 'string'
  ) {
    return {
      status: 'confirmed',
      guest_session_id: data.guest_session_id,
      table_visit_id: data.table_visit_id,
    };
  }

  if (data.status === 'invalid_code') {
    return { status: 'invalid_code' };
  }

  if (
    data.status === 'rate_limited' &&
    typeof data.retry_after_seconds === 'number' &&
    Number.isInteger(data.retry_after_seconds) &&
    data.retry_after_seconds > 0
  ) {
    return {
      status: 'rate_limited',
      retry_after_seconds: data.retry_after_seconds,
    };
  }

  throw new Error('O servidor retornou um resultado inválido.');
}