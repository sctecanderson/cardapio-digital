import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase } from '../../lib/supabase';
import {
  assumePlatformRestaurantSetup,
  createPlatformRestaurant,
  listPlatformRestaurants,
  setPlatformRestaurantActive,
  setPlatformRestaurantArchived,
} from './platformRestaurants';
import type { PlatformRestaurant } from './platformRestaurants';
import { PlatformDeletionHistory } from './PlatformDeletionHistory';

function suggestSlug(name: string) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function PlatformRestaurantsPage() {
  const navigate = useNavigate();
  const mounted = useRef(false);
  const submitting = useRef(false);
  const requestId = useRef<string | null>(null);

  const [restaurants, setRestaurants] = useState<
    PlatformRestaurant[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [refresh, setRefresh] = useState(0);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupRestaurantId, setSetupRestaurantId] =
    useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusTarget, setStatusTarget] =
    useState<PlatformRestaurant | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [restaurantView, setRestaurantView] =
    useState<'current' | 'archived'>('current');

  const [archiveTarget, setArchiveTarget] =
    useState<PlatformRestaurant | null>(null);

  const [archiveName, setArchiveName] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState('');

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    async function loadRestaurants() {
      setLoading(true);
      setListError('');

      try {
        const result = await listPlatformRestaurants();

        if (!disposed) setRestaurants(result);
      } catch (cause) {
        if (!disposed) {
          setListError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar os restaurantes.',
          );
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void loadRestaurants();

    return () => {
      disposed = true;
    };
  }, [refresh]);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (submitting.current) return;

    const cleanName = name.trim();
    const cleanSlug = slug.trim().toLowerCase();

    if (
      !cleanName ||
      cleanName.length > 120 ||
      cleanSlug.length < 3 ||
      cleanSlug.length > 80 ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(cleanSlug)
    ) {
      setError(
        'Confira o nome e o endereço. Use letras sem acento, números e hífens no endereço.',
      );
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    try {
      // Mantém o ID em novas tentativas da mesma requisição.
      requestId.current ??= crypto.randomUUID();

      const created = await createPlatformRestaurant({
        id: requestId.current,
        name: cleanName,
        slug: cleanSlug,
      });

      if (!mounted.current) return;

      requestId.current = null;
      setName('');
      setSlug('');
      setSlugEdited(false);
      setNotice(
        `${created.name} cadastrado em /${created.slug}. Sua conta já está vinculada como administrador. Use “Administrar restaurante” para configurar o cardápio, a identidade e as mesas.`,
      );
      setRefresh((current) => current + 1);
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível cadastrar o restaurante.',
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function configureRestaurant(
    restaurant: PlatformRestaurant,
  ) {
    if (submitting.current) return;

    submitting.current = true;
    setBusy(true);
    setSetupRestaurantId(restaurant.id);
    setError('');
    setNotice('');

    try {
      await assumePlatformRestaurantSetup(restaurant.id);

      if (!mounted.current) return;

      navigate(`/${restaurant.slug}/admin`);
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível abrir a administração do restaurante.',
        );
      }
    } finally {
      submitting.current = false;

      if (mounted.current) {
        setBusy(false);
        setSetupRestaurantId(null);
      }
    }
  }

  function openStatusChange(restaurant: PlatformRestaurant) {
    if (submitting.current) return;

    setStatusTarget(restaurant);
    setArchiveTarget(null);
    setStatusReason('');
    setStatusError('');
    setNotice('');
  }

  async function handleStatusChange(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (!statusTarget || submitting.current) return;

    const target = statusTarget;
    const nextActive = !target.active;

    submitting.current = true;
    setBusy(true);
    setStatusBusy(true);
    setStatusError('');

    try {
      const updated = await setPlatformRestaurantActive(
        target.id,
        target.active,
        nextActive,
        statusReason,
      );

      if (!mounted.current) return;

      setRestaurants((current) =>
        current.map((restaurant) =>
          restaurant.id === updated.id
            ? { ...restaurant, active: updated.active }
            : restaurant,
        ),
      );

      setStatusTarget(null);
      setStatusReason('');
      setNotice(
        `${target.name} ${updated.active ? 'reativado' : 'suspenso'
        } com sucesso.`,
      );
      setRefresh((current) => current + 1);
    } catch (cause) {
      if (mounted.current) {
        setStatusError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível alterar o status.',
        );

        setRefresh((current) => current + 1);
      }
    } finally {
      submitting.current = false;

      if (mounted.current) {
        setBusy(false);
        setStatusBusy(false);
      }
    }
  }

  function openArchiveChange(restaurant: PlatformRestaurant) {
    if (submitting.current) return;

    setStatusTarget(null);
    setArchiveTarget(restaurant);
    setArchiveName('');
    setArchiveReason('');
    setArchiveError('');
    setNotice('');
  }

  async function handleArchiveChange(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (!archiveTarget || submitting.current) return;

    const target = archiveTarget;
    const shouldArchive = target.archivedAt === null;

    submitting.current = true;
    setBusy(true);
    setArchiveBusy(true);
    setArchiveError('');

    try {
      const updated = await setPlatformRestaurantArchived(
        target.id,
        shouldArchive,
        archiveName,
        archiveReason,
      );

      if (!mounted.current) return;

      setRestaurants((current) =>
        current.map((restaurant) =>
          restaurant.id === updated.id
            ? { ...restaurant, ...updated }
            : restaurant,
        ),
      );

      setArchiveTarget(null);
      setArchiveName('');
      setArchiveReason('');
      setNotice(
        shouldArchive
          ? `${target.name} arquivado. Você pode encontrá-lo na lista de arquivados.`
          : `${target.name} restaurado. Ele continua suspenso até ser reativado.`,
      );

      setRefresh((current) => current + 1);
    } catch (cause) {
      if (mounted.current) {
        setArchiveError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível alterar o arquivamento.',
        );

        setRefresh((current) => current + 1);
      }
    } finally {
      submitting.current = false;

      if (mounted.current) {
        setBusy(false);
        setArchiveBusy(false);
      }
    }
  }

  async function logout() {
    if (submitting.current) return;

    submitting.current = true;
    setBusy(true);
    setError('');

    try {
      const { error: logoutError } =
        await supabase.auth.signOut({ scope: 'local' });

      if (logoutError) {
        throw new Error('Não foi possível sair. Tente novamente.');
      }

      if (mounted.current) {
        navigate('/plataforma/acesso', { replace: true });
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível sair.',
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const visibleRestaurants = restaurants.filter((restaurant) =>
    restaurantView === 'archived'
      ? restaurant.archivedAt !== null
      : restaurant.archivedAt === null,
  );

  const theme = {
    '--brand': '#243447',
    '--page': '#F7F8FA',
    '--ink': '#1B2430',
  } as CSSProperties;

  return (
    <div
      style={theme}
      className="min-h-dvh bg-[var(--page)] text-[var(--ink)]"
    >
      <a href="#platform-content" className="skip-link">
        Pular para o conteúdo
      </a>

      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5">
          <div>
            <strong className="text-xl">Elozi</strong>
            <p className="text-sm opacity-75">
              Administração da plataforma
            </p>
          </div>

          <button
            type="button"
            onClick={() => void logout()}
            disabled={busy}
            className="admin-button"
          >
            Sair
          </button>
        </div>
      </header>

      <main
        id="platform-content"
        className="mx-auto max-w-6xl space-y-8 px-4 py-8"
      >
        <section className="admin-card admin-form">
          <h1 className="text-2xl font-semibold">
            Cadastrar restaurante
          </h1>

          <p className="mt-2 text-sm opacity-75">
            Crie o estabelecimento para iniciar sua configuração.
          </p>

          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="mt-6"
          >
            <fieldset disabled={busy} className="space-y-4">
              <div className="admin-grid-2">
                <label htmlFor="restaurant-name">
                  Nome do restaurante
                  <input
                    id="restaurant-name"
                    required
                    maxLength={120}
                    value={name}
                    placeholder="Ex.: Churrascaria da Brusque"
                    onChange={(event) => {
                      const value = event.target.value;

                      requestId.current = null;
                      setName(value);
                      setError('');
                      setNotice('');

                      if (!slugEdited) {
                        setSlug(suggestSlug(value));
                      }
                    }}
                  />
                </label>

                <label htmlFor="restaurant-slug">
                  Endereço do cardápio
                  <input
                    id="restaurant-slug"
                    required
                    minLength={3}
                    maxLength={80}
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={slug}
                    placeholder="churrascaria-da-brusque"
                    onChange={(event) => {
                      requestId.current = null;
                      setSlugEdited(true);
                      setSlug(event.target.value.toLowerCase());
                      setError('');
                      setNotice('');
                    }}
                  />
                </label>
              </div>

              <p className="admin-help">
                Endereço previsto: /{slug || 'nome-do-restaurante'}.
                Escolha um endereço permanente para usar nos QR Codes.
              </p>

              <button
                type="submit"
                className="admin-button primary"
              >
                {busy && !setupRestaurantId && !statusBusy && !archiveBusy
                  ? 'Cadastrando…'
                  : 'Cadastrar restaurante'}
              </button>
            </fieldset>
          </form>

          {error && (
            <p role="alert" className="admin-alert error mt-4">
              {error}
            </p>
          )}

          {notice && (
            <p role="status" className="admin-alert success mt-4">
              {notice}
            </p>
          )}
        </section>

        <section aria-labelledby="restaurants-title">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2
              id="restaurants-title"
              className="text-xl font-semibold"
            >
              Restaurantes
            </h2>

            <button
              type="button"
              onClick={() => setRefresh((current) => current + 1)}
              disabled={loading || busy}
              className="admin-button"
            >
              Atualizar
            </button>
          </div>

          <div
            className="mb-4 flex flex-wrap gap-3"
            role="group"
            aria-label="Visualização dos restaurantes"
          >
            {[
              ['current', 'Restaurantes'],
              ['archived', 'Arquivados'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                aria-pressed={restaurantView === value}
                className={`admin-button ${restaurantView === value ? 'primary' : ''
                  }`}
                onClick={() => {
                  setRestaurantView(
                    value as 'current' | 'archived',
                  );
                  setStatusTarget(null);
                  setArchiveTarget(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {archiveTarget && (
            <section
              className="admin-card admin-form mb-6"
              aria-labelledby="restaurant-archive-title"
            >
              <h3
                id="restaurant-archive-title"
                className="text-lg font-semibold"
              >
                {archiveTarget.archivedAt ? 'Restaurar' : 'Arquivar'}{' '}
                {archiveTarget.name}
              </h3>

              <p className="mt-2 text-sm">
                {archiveTarget.archivedAt
                  ? 'O restaurante voltará à lista principal, permanecendo suspenso até sua reativação.'
                  : 'O restaurante será suspenso e movido para a lista de arquivados. Seus dados serão preservados.'}
              </p>

              <form
                onSubmit={(event) => void handleArchiveChange(event)}
                className="mt-4"
              >
                <fieldset disabled={busy} className="space-y-4">
                  <label htmlFor="restaurant-archive-name">
                    Para confirmar, digite: {archiveTarget.name}
                    <input
                      id="restaurant-archive-name"
                      required
                      maxLength={120}
                      autoComplete="off"
                      autoFocus
                      value={archiveName}
                      onChange={(event) => {
                        setArchiveName(event.target.value);
                        setArchiveError('');
                      }}
                    />
                  </label>

                  <label htmlFor="restaurant-archive-reason">
                    Motivo
                    <textarea
                      id="restaurant-archive-reason"
                      required
                      minLength={3}
                      maxLength={500}
                      rows={3}
                      value={archiveReason}
                      onChange={(event) => {
                        setArchiveReason(event.target.value);
                        setArchiveError('');
                      }}
                    />
                  </label>

                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      className="admin-button primary"
                    >
                      {archiveBusy
                        ? 'Salvando…'
                        : archiveTarget.archivedAt
                          ? 'Confirmar restauração'
                          : 'Confirmar arquivamento'}
                    </button>

                    <button
                      type="button"
                      className="admin-button"
                      onClick={() => {
                        setArchiveTarget(null);
                        setArchiveName('');
                        setArchiveReason('');
                        setArchiveError('');
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                </fieldset>

                {archiveError && (
                  <p role="alert" className="admin-alert error mt-4">
                    {archiveError}
                  </p>
                )}
              </form>
            </section>
          )}

          {statusTarget && (
            <section
              className="admin-card admin-form mb-6"
              aria-labelledby="restaurant-status-title"
            >
              <h3
                id="restaurant-status-title"
                className="text-lg font-semibold"
              >
                {statusTarget.active ? 'Suspender' : 'Reativar'}{' '}
                {statusTarget.name}
              </h3>

              <p className="mt-2 text-sm">
                {statusTarget.active
                  ? 'A suspensão bloqueará o acesso ao serviço deste restaurante. Os dados serão preservados.'
                  : 'A reativação permitirá novamente o acesso ao serviço deste restaurante.'}
              </p>

              <form
                onSubmit={(event) => void handleStatusChange(event)}
                className="mt-4"
              >
                <fieldset disabled={busy} className="space-y-4">
                  <label htmlFor="restaurant-status-reason">
                    Motivo
                    <textarea
                      id="restaurant-status-reason"
                      required
                      minLength={3}
                      maxLength={500}
                      rows={3}
                      autoFocus
                      value={statusReason}
                      onChange={(event) => {
                        setStatusReason(event.target.value);
                        setStatusError('');
                      }}
                      placeholder={
                        statusTarget.active
                          ? 'Ex.: Assinatura pendente de regularização'
                          : 'Ex.: Assinatura regularizada'
                      }
                    />
                  </label>

                  <p className="admin-help">
                    O motivo será registrado internamente. Ele não será
                    exibido no cardápio público.
                  </p>

                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      className="admin-button primary"
                    >
                      {statusBusy
                        ? 'Salvando…'
                        : statusTarget.active
                          ? 'Confirmar suspensão'
                          : 'Confirmar reativação'}
                    </button>

                    <button
                      type="button"
                      className="admin-button"
                      onClick={() => {
                        setStatusTarget(null);
                        setStatusReason('');
                        setStatusError('');
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                </fieldset>

                {statusError && (
                  <p role="alert" className="admin-alert error mt-4">
                    {statusError}
                  </p>
                )}
              </form>
            </section>
          )}

          {loading ? (
            <p role="status">Carregando restaurantes…</p>
          ) : listError ? (
            <p role="alert" className="admin-alert error">
              {listError}
            </p>
          ) : visibleRestaurants.length === 0 ? (
            <p className="admin-card">
              {restaurantView === 'archived'
                ? 'Nenhum restaurante arquivado.'
                : 'Nenhum restaurante nesta lista.'}
            </p>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {visibleRestaurants.map((restaurant) => (
                <li key={restaurant.id} className="admin-card">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-lg font-semibold">{restaurant.name}</h3>
                    <Link to={`/plataforma/restaurantes/${restaurant.id}/excluir`}
                      aria-label={`Excluir definitivamente ${restaurant.name}`}
                      title="Excluir definitivamente"
                      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-red-700/20 text-2xl text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2">
                      <span aria-hidden="true">×</span>
                    </Link>
                  </div>

                  <p className="mt-1 text-sm opacity-75">
                    /{restaurant.slug}
                  </p>

                  <p className="mt-3 text-sm">
                    {restaurant.active
                      ? 'Restaurante ativo'
                      : 'Restaurante suspenso'}
                  </p>

                  <p className="mt-1 text-sm">
                    {restaurant.adminCount === 0
                      ? 'Administrador ainda não vinculado'
                      : `${restaurant.adminCount} administrador(es) ativo(s)`}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-3">
                    <Link to={`/plataforma/restaurantes/${restaurant.id}/backups`} className="admin-button">
                      Backups
                    </Link>
                    {!restaurant.archivedAt && (
                      <button
                        type="button"
                        onClick={() => openStatusChange(restaurant)}
                        disabled={busy}
                        className="admin-button"
                      >
                        {restaurant.active ? 'Suspender' : 'Reativar'}
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => openArchiveChange(restaurant)}
                      disabled={busy}
                      className="admin-button"
                    >
                      {restaurant.archivedAt ? 'Restaurar arquivamento' : 'Arquivar restaurante'}
                    </button>
                  </div>

                  {restaurant.active && (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void configureRestaurant(restaurant)}
                        disabled={busy}
                        className="admin-button primary"
                      >
                        {setupRestaurantId === restaurant.id
                          ? 'Abrindo administração…'
                          : restaurant.adminCount === 0
                            ? 'Assumir configuração'
                            : 'Administrar restaurante'}
                      </button>

                      <Link
                        to={`/${restaurant.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center text-sm underline"
                      >
                        Ver cardápio ↗
                      </Link>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <PlatformDeletionHistory refresh={refresh} />
      </main>
    </div>
  );
}
