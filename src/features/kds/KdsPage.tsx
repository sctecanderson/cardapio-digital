import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';
import {
  fetchActiveKdsItems,
  advanceKdsItemStatus,
  subscribeToKdsItems,
  type KdsItem,
  type KdsFilterStation,
  type ProductionStatus,
} from './kdsService';
import { KdsItemCard } from './KdsItemCard';

function playNotificationChime() {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.setValueAtTime(880.00, now + 0.1); // A5

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.5);
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch (err) {
    console.warn('Não foi possível reproduzir som de notificação:', err);
  }
}

export function KdsPage() {
  const { restaurantSlug: paramSlug } = useParams<{ restaurantSlug: string }>();
  const { restaurant } = useRestaurant();
  const slug = paramSlug || restaurant.slug;

  const [items, setItems] = useState<KdsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterStation, setFilterStation] = useState<KdsFilterStation>('all');
  const [connectionStatus, setConnectionStatus] = useState<'SUBSCRIBED' | 'DISCONNECTED' | 'CONNECTING'>('CONNECTING');
  const [mutatingItemId, setMutatingItemId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());

  const [audioEnabled, setAudioEnabled] = useState(() => {
    return localStorage.getItem('kds_audio_enabled') !== 'false';
  });
  const audioEnabledRef = useRef(audioEnabled);
  audioEnabledRef.current = audioEnabled;

  useEffect(() => {
    localStorage.setItem('kds_audio_enabled', String(audioEnabled));
  }, [audioEnabled]);

  const isMountedRef = useRef(true);

  // Relógio digital em tempo real
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Carregamento de itens
  const loadItems = useCallback(async (isInitial = false) => {
    if (!slug) return;
    if (isInitial) setLoading(true);

    try {
      const activeItems = await fetchActiveKdsItems(slug);
      if (isMountedRef.current) {
        setItems(activeItems);
        setErrorMessage(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const msg = err instanceof Error ? err.message : 'Falha ao sincronizar pedidos da esteira.';
        setErrorMessage(msg);
      }
    } finally {
      if (isMountedRef.current && isInitial) {
        setLoading(false);
      }
    }
  }, [slug]);

  // Carga inicial e subscrição Realtime
  useEffect(() => {
    if (restaurant.subscriptionPlan === 'basic') {
      setLoading(false);
      return;
    }

    isMountedRef.current = true;
    void loadItems(true);

    if (!restaurant.id) return;

    const unsubscribe = subscribeToKdsItems(
      restaurant.id,
      () => {
        void loadItems(false);
      },
      (status) => {
        if (isMountedRef.current) {
          setConnectionStatus(status);
        }
      },
      () => {
        if (audioEnabledRef.current) {
          playNotificationChime();
        }
      }
    );

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [restaurant.id, restaurant.subscriptionPlan, loadItems]);

  // Avanço do estado de produção
  const handleAdvanceStatus = async (item: KdsItem, nextStatus: ProductionStatus) => {
    if (mutatingItemId) return;
    setMutatingItemId(item.id);
    setErrorMessage(null);

    // Atualização otimista local
    setItems((prev) =>
      prev
        .map((it) => (it.id === item.id ? { ...it, production_status: nextStatus } : it))
        .filter((it) => it.production_status !== 'delivered')
    );

    const result = await advanceKdsItemStatus(slug, item.id, nextStatus);

    if (!result.success) {
      setErrorMessage(result.error || 'Erro ao atualizar pedido.');
      // Reverte recarregando
      await loadItems(false);
    } else {
      // Recarrega silenciosamente para garantir sincronização de timestamps
      void loadItems(false);
    }

    setMutatingItemId(null);
  };

  // Filtragem por estação
  const filteredItems = useMemo(() => {
    if (filterStation === 'all') return items;
    return items.filter((item) => item.preparation_station === filterStation);
  }, [items, filterStation]);

  // Contagens por estação para badges das pílulas
  const stationCounts = useMemo(() => {
    let all = items.length;
    let kitchen = 0;
    let bar = 0;
    for (const item of items) {
      if (item.preparation_station === 'kitchen') kitchen++;
      else if (item.preparation_station === 'bar') bar++;
    }
    return { all, kitchen, bar };
  }, [items]);

  // Separação em colunas Kanban
  const pendingItems = useMemo(
    () => filteredItems.filter((i) => i.production_status === 'pending'),
    [filteredItems]
  );
  const preparingItems = useMemo(
    () => filteredItems.filter((i) => i.production_status === 'preparing'),
    [filteredItems]
  );
  const readyItems = useMemo(
    () => filteredItems.filter((i) => i.production_status === 'ready'),
    [filteredItems]
  );

  // Se o restaurante estiver no plano Básico, renderiza o Paywall comercial
  if (restaurant.subscriptionPlan === 'basic') {
    return (
      <div className="flex min-h-screen flex-col bg-[#f5f2eb] text-[#2b1d17] antialiased dark:bg-[#14110f] dark:text-[#f7f3ee]">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-black/10 bg-white/95 px-4 py-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-[#1a1512]/95 md:px-6">
          <div className="flex items-center gap-4">
            <Link
              to={`/${slug}/admin`}
              className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ink)]/60 transition-colors hover:text-[var(--ink)] dark:text-stone-400 dark:hover:text-white"
              title="Voltar ao Painel Administrativo"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span>Painel</span>
            </Link>
            <div className="h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden="true" />
            <h1 className="text-base font-black tracking-tight text-[var(--ink)] dark:text-white sm:text-lg">
              {restaurant.name}
            </h1>
          </div>
          <ThemeToggleButton />
        </header>

        <main className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md w-full rounded-3xl border border-black/10 bg-white p-8 text-center shadow-lg dark:border-white/10 dark:bg-[#1c1815]">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
                <rect x="9" y="8" width="6" height="5" rx="1" />
                <path d="M10 8V6.5a2 2 0 1 1 4 0V8" />
              </svg>
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-700 dark:text-amber-300 mb-3">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Recurso Pro &amp; Premium</span>
            </div>

            <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight mb-3">
              Módulo KDS exclusivo para planos Pro e Premium
            </h2>

            <p className="text-sm text-slate-600 dark:text-stone-300 leading-relaxed mb-6">
              O painel de produção em tempo real para cozinha e bar não está habilitado no plano Básico. Entre em contato com a administração da plataforma para realizar o upgrade e agilizar seus pedidos.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                to={`/${slug}/admin`}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-slate-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white cursor-pointer shadow-sm"
              >
                Voltar ao Início
              </Link>
              <Link
                to={`/${slug}/admin/mesas`}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-stone-700 px-5 py-2.5 text-sm font-bold text-slate-700 dark:text-stone-300 transition-all hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Ver Mesas e Comandas
              </Link>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f2eb] text-[#2b1d17] antialiased dark:bg-[#14110f] dark:text-[#f7f3ee]">
      {/* =========================================================================
          BARRA SUPERIOR (TOPBAR DO KDS)
          ========================================================================= */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-4 border-b border-black/10 bg-white/95 px-4 py-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-[#1a1512]/95 md:px-6">
        {/* Esquerda: Identificação do Restaurante & Relógio */}
        <div className="flex items-center gap-4">
          <Link
            to={`/${slug}/admin`}
            className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ink)]/60 transition-colors hover:text-[var(--ink)] dark:text-stone-400 dark:hover:text-white"
            title="Voltar ao Painel Administrativo"
          >
            <span aria-hidden="true">←</span>
            <span>Painel</span>
          </Link>

          <div className="h-4 w-px bg-black/10 dark:bg-white/10" aria-hidden="true" />

          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-black tracking-tight text-[var(--ink)] dark:text-white sm:text-lg">
              {restaurant.name}
            </h1>
            <span className="rounded bg-black/5 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-[var(--ink)]/70 dark:bg-white/10 dark:text-stone-300">
              KDS
            </span>
          </div>

          <div
            className="hidden font-mono text-sm font-black tracking-widest text-[var(--ink)]/80 dark:text-stone-300 sm:inline-block"
            aria-label="Hora atual"
          >
            {currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        </div>

        {/* Centro: Filtro por Estação (Pílulas) */}
        <nav className="flex items-center rounded-xl bg-stone-100 p-1 dark:bg-[#251f1b]" aria-label="Filtro de estação">
          <button
            type="button"
            onClick={() => setFilterStation('all')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterStation === 'all'
                ? 'bg-white text-[var(--ink)] shadow-sm dark:bg-[#342b26] dark:text-white'
                : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white'
            }`}
          >
            <span>Todas</span>
            <span className="rounded-full bg-black/5 px-1.5 py-0.2 text-[10px] font-black dark:bg-white/10">
              {stationCounts.all}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilterStation('kitchen')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterStation === 'kitchen'
                ? 'bg-white text-orange-700 shadow-sm dark:bg-[#342b26] dark:text-orange-300'
                : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white'
            }`}
          >
            <span>Cozinha</span>
            <span className="rounded-full bg-orange-100 px-1.5 py-0.2 text-[10px] font-black text-orange-800 dark:bg-orange-950 dark:text-orange-300">
              {stationCounts.kitchen}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilterStation('bar')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterStation === 'bar'
                ? 'bg-white text-blue-700 shadow-sm dark:bg-[#342b26] dark:text-blue-300'
                : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white'
            }`}
          >
            <span>Bar</span>
            <span className="rounded-full bg-blue-100 px-1.5 py-0.2 text-[10px] font-black text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              {stationCounts.bar}
            </span>
          </button>
        </nav>

        {/* Direita: Indicador Realtime, Tema e Ações */}
        <div className="flex items-center gap-3">
          {/* Status Realtime com bolinha pulsante */}
          <div
            className="flex items-center gap-1.5 text-xs font-semibold"
            title={
              connectionStatus === 'SUBSCRIBED'
                ? 'Conectado em tempo real'
                : connectionStatus === 'CONNECTING'
                ? 'Conectando ao canal em tempo real...'
                : 'Desconectado — usando reconexão automática'
            }
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connectionStatus === 'SUBSCRIBED'
                  ? 'animate-pulse bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
                  : connectionStatus === 'CONNECTING'
                  ? 'bg-amber-500'
                  : 'bg-rose-500'
              }`}
              aria-hidden="true"
            />
            <span className="hidden text-[11px] text-stone-500 dark:text-stone-400 md:inline">
              {connectionStatus === 'SUBSCRIBED' ? 'Ao vivo' : connectionStatus === 'CONNECTING' ? 'Conectando…' : 'Reconectando…'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setAudioEnabled((prev) => !prev)}
            className="flex items-center gap-1.5 h-9 px-2.5 rounded-xl border border-black/10 text-xs font-semibold hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 transition-colors"
            title={audioEnabled ? "Silenciar notificações sonoras" : "Ativar aviso sonoro para novos pedidos"}
            aria-label={audioEnabled ? "Som Ativo" : "Mudo"}
          >
            {audioEnabled ? (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-4 h-4 text-emerald-600 dark:text-emerald-400">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
                <span className="hidden sm:inline">Som Ativo</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-4 h-4 text-stone-400">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
                <span className="hidden sm:inline">Mudo</span>
              </>
            )}
          </button>

          <ThemeToggleButton className="h-9 w-9 rounded-xl border border-black/10 dark:border-white/10" />
        </div>
      </header>

      {/* Alerta de Erro caso a mutação falhe */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-bold text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
        >
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-4 h-4 flex-shrink-0">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-600 hover:text-rose-900 dark:text-rose-400"
            aria-label="Fechar erro"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* =========================================================================
          ESTEIRA DE PRODUÇÃO KANBAN (3 COLUNAS)
          ========================================================================= */}
      <main className="flex-1 p-3 md:p-5">
        {loading ? (
          <div className="flex h-96 flex-col items-center justify-center gap-3 text-center">
            <svg
              className="h-8 w-8 animate-spin text-stone-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Carregando pedidos da esteira KDS…
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Coluna 1: Pendentes / A Fazer */}
            <section
              className="flex flex-col rounded-2xl border border-black/10 bg-stone-100/70 p-3 shadow-inner dark:border-white/5 dark:bg-[#1a1512]/60 md:p-4"
              aria-labelledby="col-pending-heading"
            >
              <header className="mb-3 flex items-center justify-between border-b border-black/5 pb-2.5 dark:border-white/5">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-amber-500" aria-hidden="true" />
                  <h2 id="col-pending-heading" className="text-sm font-black uppercase tracking-wider">
                    Pendentes / A Fazer
                  </h2>
                </div>
                <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-black text-amber-700 dark:text-amber-300">
                  {pendingItems.length}
                </span>
              </header>

              <div className="flex flex-col gap-3">
                {pendingItems.length === 0 ? (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-black/10 text-center text-xs text-stone-400 dark:border-white/10 dark:text-stone-500">
                    Nenhum pedido pendente
                  </div>
                ) : (
                  pendingItems.map((item) => (
                    <KdsItemCard
                      key={item.id}
                      item={item}
                      onAdvance={handleAdvanceStatus}
                      isMutating={mutatingItemId === item.id}
                    />
                  ))
                )}
              </div>
            </section>

            {/* Coluna 2: Em Preparo */}
            <section
              className="flex flex-col rounded-2xl border border-black/10 bg-stone-100/70 p-3 shadow-inner dark:border-white/5 dark:bg-[#1a1512]/60 md:p-4"
              aria-labelledby="col-prep-heading"
            >
              <header className="mb-3 flex items-center justify-between border-b border-black/5 pb-2.5 dark:border-white/5">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-blue-500" aria-hidden="true" />
                  <h2 id="col-prep-heading" className="text-sm font-black uppercase tracking-wider">
                    Em Preparo
                  </h2>
                </div>
                <span className="rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-black text-blue-700 dark:text-blue-300">
                  {preparingItems.length}
                </span>
              </header>

              <div className="flex flex-col gap-3">
                {preparingItems.length === 0 ? (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-black/10 text-center text-xs text-stone-400 dark:border-white/10 dark:text-stone-500">
                    Nenhum item em preparo no momento
                  </div>
                ) : (
                  preparingItems.map((item) => (
                    <KdsItemCard
                      key={item.id}
                      item={item}
                      onAdvance={handleAdvanceStatus}
                      isMutating={mutatingItemId === item.id}
                    />
                  ))
                )}
              </div>
            </section>

            {/* Coluna 3: Prontos para Entrega */}
            <section
              className="flex flex-col rounded-2xl border border-black/10 bg-stone-100/70 p-3 shadow-inner dark:border-white/5 dark:bg-[#1a1512]/60 md:p-4"
              aria-labelledby="col-ready-heading"
            >
              <header className="mb-3 flex items-center justify-between border-b border-black/5 pb-2.5 dark:border-white/5">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-emerald-500" aria-hidden="true" />
                  <h2 id="col-ready-heading" className="text-sm font-black uppercase tracking-wider">
                    Prontos para Entrega
                  </h2>
                </div>
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-black text-emerald-700 dark:text-emerald-300">
                  {readyItems.length}
                </span>
              </header>

              <div className="flex flex-col gap-3">
                {readyItems.length === 0 ? (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-black/10 text-center text-xs text-stone-400 dark:border-white/10 dark:text-stone-500">
                    Nenhum item aguardando entrega
                  </div>
                ) : (
                  readyItems.map((item) => (
                    <KdsItemCard
                      key={item.id}
                      item={item}
                      onAdvance={handleAdvanceStatus}
                      isMutating={mutatingItemId === item.id}
                    />
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
