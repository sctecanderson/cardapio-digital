import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Outlet } from 'react-router';
import { supabase } from '../../lib/supabase';
import { getPlatformAccess } from './platformRestaurants';

type AccessState =
  | 'checking'
  | 'allowed'
  | 'denied'
  | 'signed-out'
  | 'error';

export function RequirePlatformAccess() {
  const [state, setState] = useState<AccessState>('checking');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const allowedUser = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let authTimer: ReturnType<typeof setTimeout> | undefined;

    async function checkAccess() {
      const request = ++revision;

      setError('');

      try {
        const { data, error: sessionError } =
          await supabase.auth.getSession();

        if (sessionError) {
          throw new Error(
            'Não foi possível recuperar seu login.',
          );
        }

        if (disposed || request !== revision) return;

        if (
          !data.session ||
          data.session.user.is_anonymous
        ) {
          allowedUser.current = null;
          setState('signed-out');
          return;
        }

        if (allowedUser.current !== data.session.user.id) {
          allowedUser.current = null;
          setState('checking');
        }
        const allowed = await getPlatformAccess();

        if (disposed || request !== revision) return;

        allowedUser.current = allowed ? data.session.user.id : null;
        setState(allowed ? 'allowed' : 'denied');
      } catch (cause) {
        if (disposed || request !== revision) return;

        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível verificar seu acesso.',
        );

        if (!allowedUser.current) setState('error');
      }
    }

    function scheduleCheck() {
      if (disposed) return;

      // Atualização em segundo plano preserva operações em andamento.
      revision += 1;

      if (authTimer !== undefined) {
        clearTimeout(authTimer);
      }

      // Executa consultas fora do callback de autenticação.
      authTimer = setTimeout(() => {
        authTimer = undefined;
        void checkAccess();
      }, 0);
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session || session.user.is_anonymous || session.user.id !== allowedUser.current) {
        allowedUser.current = null;
        setState(session ? 'checking' : 'signed-out');
      }
      scheduleCheck();
    });

    void checkAccess();

    function refreshWhenVisible() {
      if (!document.hidden) scheduleCheck();
    }

    document.addEventListener(
      'visibilitychange',
      refreshWhenVisible,
    );
    window.addEventListener('online', scheduleCheck);

    return () => {
      disposed = true;
      revision += 1;
      subscription.unsubscribe();

      if (authTimer !== undefined) {
        clearTimeout(authTimer);
      }

      document.removeEventListener(
        'visibilitychange',
        refreshWhenVisible,
      );
      window.removeEventListener('online', scheduleCheck);
    };
  }, [retry]);

  if (state === 'signed-out' || state === 'denied') {
    return (
      <Navigate
        to="/plataforma/acesso"
        replace
      />
    );
  }

  if (state === 'checking') {
    return (
      <main className="shell py-10">
        <p role="status">Verificando acesso à Elozi…</p>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="shell py-10">
        <h1 className="text-2xl font-semibold">
          Não foi possível verificar o acesso
        </h1>

        <p role="alert" className="mt-3">
          {error}
        </p>

        <div className="mt-4 flex flex-wrap gap-4">
          <button
            type="button"
            onClick={() => setRetry((current) => current + 1)}
            className="min-h-11 rounded-xl border px-4"
          >
            Tentar novamente
          </button>

          <Link
            to="/plataforma/acesso"
            className="inline-flex min-h-11 items-center underline"
          >
            Ir para o acesso
          </Link>
        </div>
      </main>
    );
  }

  return <>
    {error && <p role="status" className="shell py-3 text-sm">Não foi possível revalidar o acesso. Confira a conexão; as operações continuam verificando sua permissão no servidor.</p>}
    <Outlet />
  </>;
}