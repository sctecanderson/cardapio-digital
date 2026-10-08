import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { RestaurantMenu } from '../../types/menu';
import { getPublicMenu } from './publicMenu';

interface CatalogContext {
  menu: RestaurantMenu | null;
  loading: boolean;
  error: string;
  reload: () => void;
}
const MenuContext = createContext<CatalogContext | null>(null);

export function PublicMenuProvider({ restaurantSlug, children }: {
  restaurantSlug: string;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<RestaurantMenu | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    async function load() {
      if (disposed || pending) return;
      pending = true;
      try {
        const result = await getPublicMenu(restaurantSlug);
        if (!disposed) { setMenu(result); setError(''); }
      } catch (cause) {
        if (!disposed) {
          // Uma falha nunca ativa o catálogo local nem seus preços antigos.
          setMenu(null);
          setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o cardápio.');
        }
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    }
    function refreshVisible() {
      if (!document.hidden) void load();
    }
    setLoading(true);
    void load();
    // Compartilhado entre as três telas. Não carrega mídia, apenas metadados.
    const timer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('online', refreshVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('online', refreshVisible);
    };
  }, [restaurantSlug, refresh]);

  return <MenuContext.Provider value={{ menu, loading, error,
    reload: () => setRefresh((value) => value + 1) }}>{children}</MenuContext.Provider>;
}

export function usePublicMenu() {
  const context = useContext(MenuContext);
  if (!context) throw new Error('O catálogo precisa de PublicMenuProvider.');
  return context;
}

export function PublicMenuStatus() {
  const { loading, error, reload } = usePublicMenu();
  return <section className="panel" aria-busy={loading}>
    <h1>{loading ? 'Carregando cardápio…' : 'Cardápio indisponível'}</h1>
    <p role={loading ? 'status' : 'alert'}>
      {loading ? 'Buscando as opções do restaurante.' : error}
    </p>
    {!loading && <button type="button" onClick={reload}
      className="mt-3 min-h-11 rounded-xl bg-[var(--brand)] px-4 text-white">
      Tentar novamente
    </button>}
  </section>;
}
