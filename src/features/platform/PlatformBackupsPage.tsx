import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import { listPlatformRestaurants, type PlatformRestaurant } from './platformRestaurants';
import { cancelBackup, downloadBackup, listBackups, processBackup, startBackup, type BackupSummary } from './platformBackups';

export function PlatformBackupsPage() {
  const { restaurantId = '' } = useParams();
  return <BackupContent key={restaurantId} restaurantId={restaurantId} />;
}

function BackupContent({ restaurantId }: { restaurantId: string }) {
  const [restaurant, setRestaurant] = useState<PlatformRestaurant | null>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const alive = useRef(false);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const newBackupId = useRef<string | null>(null);

  async function refresh() {
    const [restaurants, copies] = await Promise.all([listPlatformRestaurants(), listBackups(restaurantId)]);
    if (!alive.current) return;
    setRestaurant(restaurants.find((item) => item.id === restaurantId) ?? null);
    setBackups(copies);
    if (copies.some((copy) => copy.id === newBackupId.current)) newBackupId.current = null;
  }

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void Promise.all([listPlatformRestaurants(), listBackups(restaurantId)])
      .then(([restaurants, copies]) => {
        if (disposed) return;
        setRestaurant(restaurants.find((item) => item.id === restaurantId) ?? null);
        setBackups(copies);
      })
      .catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as cópias.'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; alive.current = false; controller.current?.abort(); };
  }, [restaurantId]);

  async function perform(action: (signal: AbortSignal, notify: (text: string) => void) => Promise<void>, success: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setError(''); setNotice('Preparando…');
    const task = new AbortController();
    controller.current = task;
    try {
      await action(task.signal, (text) => { if (alive.current) setNotice(text); });
      if (alive.current) setNotice(success);
    } catch (cause) {
      if (alive.current) {
        if (task.signal.aborted) setNotice('Operação interrompida. As etapas já concluídas foram preservadas.');
        else { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.'); setNotice(''); }
      }
    } finally {
      if (alive.current) {
        try { await refresh(); } catch { setError((current) => current || 'Confira a conexão e atualize a lista antes de repetir.'); }
        if (alive.current) setBusy(false);
      }
      busyRef.current = false;
      controller.current = null;
    }
  }

  const pending = backups.some((copy) => copy.status === 'snapshot_created');
  const canStart = restaurant && !restaurant.active && restaurant.archivedAt && !pending;
  const theme = { '--brand': '#243447', '--page': '#F7F8FA', '--ink': '#1B2430' } as CSSProperties;
  const date = (value: string) => new Date(value).toLocaleString('pt-BR');

  return <div style={theme} className="min-h-dvh bg-[var(--page)] text-[var(--ink)]">
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <Link to="/plataforma/restaurantes" className="inline-flex min-h-11 items-center underline">← Restaurantes</Link>
      <header>
        <p className="text-sm opacity-70">Elozi · Administração da plataforma</p>
        <h1 className="mt-2 text-3xl font-semibold">Backups{restaurant ? ` de ${restaurant.name}` : ''}</h1>
        <p className="mt-3">Guarde os dados e as mídias do restaurante em uma cópia privada e baixe um ZIP verificado.</p>
      </header>
      {error && <p role="alert" className="admin-alert error">{error}</p>}
      {notice && <p role="status" className="admin-alert success">{notice}</p>}
      {loading ? <p role="status">Carregando cópias…</p> : <>
        <section className="rounded-2xl border border-black/10 bg-white p-5" aria-labelledby="new-backup-title">
          <h2 id="new-backup-title" className="text-xl font-semibold">Preparar uma cópia</h2>
          <p className="mt-2 text-sm">Esta etapa exige o restaurante arquivado, deixando o cardápio indisponível durante a preparação. A cópia inclui comandas e consumo; as contas de login permanecem no Supabase Auth.</p>
          <p className="mt-2 text-sm">Enquanto houver uma cópia em preparação, conclua ou cancele essa cópia antes de restaurar o restaurante. Pausar permite retomar o envio depois.</p>
          {!restaurant && <p className="mt-3">Restaurante não encontrado. As cópias existentes, se houver, continuam listadas abaixo.</p>}
          {restaurant && !restaurant.archivedAt && <p className="mt-3 font-medium">Arquive o restaurante na tela anterior para habilitar uma nova cópia.</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" disabled={busy || !canStart} className="admin-button primary disabled:opacity-50"
              onClick={() => void perform(async (signal, notify) => {
                newBackupId.current ??= crypto.randomUUID();
                const copy = await startBackup(restaurantId, newBackupId.current);
                newBackupId.current = null;
                signal.throwIfAborted();
                await processBackup(copy.id, signal, notify);
              }, 'Cópia concluída no armazenamento privado. Baixe o ZIP para guardar uma cópia fora do Supabase.')}>
              Gerar backup
            </button>
            <button type="button" disabled={busy} className="admin-button disabled:opacity-50"
              onClick={() => void perform(async () => { await refresh(); }, 'Lista atualizada.')}>
              Atualizar lista
            </button>
            {busy && <button type="button" className="admin-button" onClick={() => controller.current?.abort()}>Pausar operação</button>}
          </div>
        </section>
        <section aria-labelledby="copies-title">
          <h2 id="copies-title" className="text-xl font-semibold">Cópias registradas</h2>
          {!backups.length ? <p className="mt-3">Nenhum backup registrado.</p> : <ul className="mt-4 space-y-4">
            {backups.map((copy) => <li key={copy.id} className="rounded-2xl border border-black/10 bg-white p-5">
              <div className="flex flex-wrap justify-between gap-3">
                <h3 className="font-semibold">{date(copy.createdAt)}</h3>
                <span>{copy.status === 'ready' ? 'Concluído' : copy.status === 'cancelled' ? 'Cancelado' : 'Em preparação'}</span>
              </div>
              <p className="mt-2 text-sm">{copy.verifiedCount} de {copy.fileCount} mídias verificadas</p>
              <p className="mt-1 break-all text-xs opacity-60">Referência: {copy.id}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                {copy.status === 'snapshot_created' && <>
                  <button type="button" disabled={busy} className="admin-button primary disabled:opacity-50"
                    onClick={() => void perform((signal, notify) => processBackup(copy.id, signal, notify), 'Cópia concluída. O ZIP está disponível para download.')}>
                    Retomar cópia
                  </button>
                  <button type="button" disabled={busy} className="admin-button disabled:opacity-50"
                    onClick={() => void perform(async () => { await cancelBackup(copy.id); newBackupId.current = null; }, 'Cópia cancelada. O restaurante pode ser restaurado na tela anterior.')}>
                    Cancelar cópia
                  </button>
                </>}
                {copy.status === 'ready' && <button type="button" disabled={busy} className="admin-button primary disabled:opacity-50"
                  onClick={() => void perform((signal, notify) => downloadBackup(copy.id, signal, notify), 'ZIP verificado e enviado ao navegador. Confira a pasta de downloads.')}>
                  Baixar ZIP
                </button>}
              </div>
            </li>)}
          </ul>}
        </section>
        <p className="text-sm opacity-75">Limites desta versão: 32 MiB por arquivo e 128 MiB por download ZIP. A recuperação e a exclusão definitiva serão liberadas após a validação da restauração.</p>
      </>}
    </main>
  </div>;
}
