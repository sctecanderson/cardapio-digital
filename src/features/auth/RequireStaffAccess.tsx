import { useEffect, useState } from 'react';
import {
  Navigate,
  Outlet,
  useParams,
} from 'react-router';
import { supabase } from '../../lib/supabase';
import {
  getStaffAccess,
  type StaffAccess,
} from './staffAuth';

type AccessState =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'authorized'; access: StaffAccess }
  | { status: 'error'; message: string };

interface RequireStaffAccessProps {
  requiredRole?: StaffAccess['role'];
}

export function RequireStaffAccess({
  requiredRole,
}: RequireStaffAccessProps) {
  const { restaurantSlug = '' } = useParams();

  return (
    <StaffGate
      key={restaurantSlug}
      restaurantSlug={restaurantSlug}
      requiredRole={requiredRole}
    />
  );
}

function StaffGate({
  restaurantSlug,
  requiredRole,
}: RequireStaffAccessProps & {
  restaurantSlug: string;
}) {
  const [state, setState] = useState<AccessState>({
    status: 'loading',
  });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function verifyAccess() {
      const currentGeneration = ++generation;

      setState({ status: 'loading' });

      try {
        const { data, error } =
          await supabase.auth.getSession();

        if (error) {
          throw new Error(
            'Não foi possível verificar sua sessão.',
          );
        }

        const access = data.session
          ? await getStaffAccess(restaurantSlug)
          : null;

        if (
          disposed ||
          currentGeneration !== generation
        ) {
          return;
        }

        setState(
          access
            ? { status: 'authorized', access }
            : { status: 'denied' },
        );
      } catch (cause) {
        if (
          disposed ||
          currentGeneration !== generation
        ) {
          return;
        }

        setState({
          status: 'error',
          message:
            cause instanceof Error
              ? cause.message
              : 'Não foi possível verificar seu acesso.',
        });
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (disposed) return;

        // Invalidar verificações anteriores.
        generation++;
        clearTimeout(timer);

        if (!session) {
          setState({ status: 'denied' });
          return;
        }

        setState({ status: 'loading' });

        // Consultar fora do callback de autenticação.
        timer = setTimeout(() => {
          void verifyAccess();
        }, 0);
      },
    );

    void verifyAccess();

    return () => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [restaurantSlug, retry]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="py-6">
        Verificando acesso…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="py-6">
        <p role="alert">{state.message}</p>

        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="mt-4 min-h-11 rounded-xl border border-current px-4 py-3"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (state.status === 'denied') {
    return (
      <Navigate
        to={`/${restaurantSlug}/acesso`}
        replace
      />
    );
  }

  if (
    requiredRole &&
    state.access.role !== requiredRole
  ) {
    return (
      <p role="alert" className="py-6">
        Seu perfil não possui permissão para esta área.
      </p>
    );
  }

  return <Outlet context={state.access} />;
}