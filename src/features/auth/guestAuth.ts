import { supabase } from '../../lib/supabase';

let pendingIdentity: Promise<string> | null = null;

export function ensureGuestIdentity(): Promise<string> {
  if (pendingIdentity) {
    return pendingIdentity;
  }

  pendingIdentity = resolveGuestIdentity().finally(() => {
    pendingIdentity = null;
  });

  return pendingIdentity;
}

async function resolveGuestIdentity(): Promise<string> {
  const { data: sessionData, error: sessionError } =
    await supabase.auth.getSession();

  if (sessionError) {
    throw new Error(
      'Não foi possível verificar sua sessão. Tente novamente.',
    );
  }

  if (sessionData.session) {
    const { data, error } = await supabase.auth.getUser();

    if (error || !data.user) {
      throw new Error(
        'Não foi possível validar sua sessão. Tente novamente.',
      );
    }

    if (!data.user.is_anonymous) {
      throw new Error(
        'Existe uma conta da equipe conectada neste navegador. ' +
          'Para testar como cliente, use uma janela anônima.',
      );
    }

    return data.user.id;
  }

  const { data, error } = await supabase.auth.signInAnonymously();

  if (error || !data.user || !data.user.is_anonymous) {
    throw new Error(
      'Não foi possível iniciar sua sessão de cliente. Tente novamente.',
    );
  }

  return data.user.id;
}
