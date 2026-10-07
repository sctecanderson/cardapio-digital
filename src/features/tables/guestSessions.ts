import { supabase } from '../../lib/supabase';
import { ensureGuestIdentity } from '../auth/guestAuth';

export interface GuestSession {
    id: string;
    restaurant_id: string;
    restaurant_table_id: string;
    user_id: string;
    table_visit_id: string | null;
    confirmed_by_member_id: string | null;
    confirmed_at: string | null;
    status: 'pending' | 'active' | 'revoked' | 'expired';
    created_at: string;
    expires_at: string;
}

export async function startGuestSession(
    restaurantSlug: string,
    tableNumber: number,
): Promise<GuestSession> {
    if (
        !Number.isInteger(tableNumber) ||
        tableNumber < 1 ||
        tableNumber > 999
    ) {
        throw new Error('Informe um número de mesa válido.');
    }

    await ensureGuestIdentity();

    const { data, error } = await supabase
        .rpc('start_guest_session', {
            p_restaurant_slug: restaurantSlug,
            p_table_number: tableNumber,
        })
        .single()
        .overrideTypes<GuestSession, { merge: false }>();

    if (error) {
        if (error.code === '42501' || error.code === '22023') {
            throw new Error(error.message);
        }

        throw new Error(
            'Não foi possível iniciar sua sessão na mesa. Tente novamente.',
        );
    }

    if (!data?.id) {
        throw new Error('A sessão não foi retornada pelo servidor.');
    }

    return data;
}

export interface GuestConfirmationCode {
  guest_session_id: string;
  code: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export async function issueGuestConfirmationCode(
  guestSessionId: string,
): Promise<GuestConfirmationCode> {
  await ensureGuestIdentity();

  const { data, error } = await supabase
    .rpc('issue_guest_confirmation_code', {
      p_guest_session_id: guestSessionId,
    })
    .single()
    .overrideTypes<GuestConfirmationCode, { merge: false }>();

  if (error) {
    if (error.code === '42501' || error.code === '22023') {
      throw new Error(error.message);
    }

    throw new Error(
      'Não foi possível gerar seu código. Tente novamente.',
    );
  }

  if (
    !data ||
    data.guest_session_id !== guestSessionId ||
    !/^[0-9]{6}$/.test(data.code)
  ) {
    throw new Error('O servidor não retornou um código válido.');
  }

  return data;
}

export interface GuestSessionState {
  session: GuestSession | null;
  code: GuestConfirmationCode | null;
}

export async function getGuestSessionState(
  restaurantSlug: string,
  tableNumber: number,
): Promise<GuestSessionState> {
  const { data: authData, error: authError } =
    await supabase.auth.getSession();

  if (authError) {
    throw new Error('Não foi possível verificar sua sessão.');
  }

  if (!authData.session?.user.is_anonymous) {
    return { session: null, code: null };
  }

  const { data: session, error: sessionError } = await supabase
    .rpc('get_guest_session', {
      p_restaurant_slug: restaurantSlug,
      p_table_number: tableNumber,
    })
    .maybeSingle()
    .overrideTypes<GuestSession, { merge: false }>();

  if (sessionError) {
    throw new Error(
      'Não foi possível recuperar sua sessão na mesa.',
    );
  }

  if (!session || session.status !== 'pending') {
    return { session, code: null };
  }

  const { data: code, error: codeError } = await supabase
    .from('guest_confirmation_codes')
    .select(
      'guest_session_id, code, created_at, expires_at, consumed_at',
    )
    .eq('guest_session_id', session.id)
    .maybeSingle()
    .overrideTypes<GuestConfirmationCode, { merge: false }>();

  if (codeError) {
    throw new Error(
      'Não foi possível recuperar seu código de confirmação.',
    );
  }

  return { session, code };
}