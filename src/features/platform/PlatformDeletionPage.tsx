import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import { listPlatformRestaurants, type PlatformRestaurant } from './platformRestaurants';
import { listBackups, type BackupSummary } from './platformBackups';
import { cancelDeletion, deletionLabel, listDeletions, processDeletion, startDeletion, type DeletionRecord } from './platformDeletions';

export function PlatformDeletionPage() {
  const { restaurantId = '' } = useParams();
  return <DeletionContent key={restaurantId} restaurantId={restaurantId} />;
}

function DeletionContent({ restaurantId }: { restaurantId: string }) {
  const [restaurant, setRestaurant] = useState<PlatformRestaurant | null>(null);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [job, setJob] = useState<DeletionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [backupId, setBackupId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState(false);
  const alive = useRef(false);
  const running = useRef(false);
  const requestId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  async function load() {
    const [restaurants, copies, jobs] = await Promise.all([listPlatformRestaurants(), listBackups(restaurantId), listDeletions()]);
    return { restaurant: restaurants.find(r => r.id === restaurantId) ?? null, copies,
      jobs: jobs.filter(j => j.source_restaurant_id === restaurantId) };
  }
  function apply(result: Awaited<ReturnType<typeof load>>) {
    setRestaurant(result.restaurant);
    setBackups(result.copies.filter(b => b.status === 'ready'));
    setJob(result.jobs.find(j => !['completed', 'cancelled'].includes(j.status)) ??
      (!result.restaurant ? result.jobs.find(j => j.status === 'completed') ?? null : null));
  }
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void load().then(result => { if (!disposed) apply(result); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar.'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; alive.current = false; controller.current?.abort(); };
  }, [restaurantId]);

  async function perform(action: (signal: AbortSignal, notify: (text: string) => void) => Promise<void>, success: string) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setNotice('Preparando…');
    const task = new AbortController(); controller.current = task;
    try {
      await action(task.signal, text => { if (alive.current) setNotice(text); });
      if (alive.current) setNotice(success);
    } catch (cause) {
      if (alive.current) {
        setNotice('');
        setError(task.signal.aborted ? 'A sequência foi pausada. Uma etapa já enviada pode terminar. Atualize para conferir o estado.' :
          cause instanceof Error ? cause.message : 'Não foi possível concluir. Atualize e retome.');
      }
    } finally {
      try { const result = await load(); if (alive.current) apply(result); }
      catch { if (alive.current) setError(current => current || 'Atualize a página para consultar o resultado antes de repetir.'); }
      running.current = false; controller.current = null;
      if (alive.current) setBusy(false);
    }
  }
  const canDelete = !!restaurant?.archivedAt && !restaurant.active && !!backupId &&
    confirmation.trim() === restaurant.name && reason.trim().length >= 3 && saved;
  const theme = { '--brand': '#243447', '--page': '#F7F8FA', '--ink': '#1B2430' } as CSSProperties;
  const backupLink = `/plataforma/restaurantes/${restaurantId}/backups`;

  return <div style={theme} className="min-h-dvh bg-[var(--page)] text-[var(--ink)]">
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <Link to="/plataforma/restaurantes" className="inline-flex min-h-11 items-center underline">← Restaurantes</Link>
      <header>
        <p className="text-sm opacity-70">Elozi · Administração da plataforma</p>
        <h1 className="mt-2 text-3xl font-semibold">Excluir restaurante</h1>
      </header>
      {error && <p role="alert" className="admin-alert error">{error}</p>}
      {notice && <p role="status" className="admin-alert success">{notice}</p>}
      {loading ? <p role="status">Carregando…</p> : job ? <section className="admin-card space-y-4">
        <h2 className="text-xl font-semibold">{job.source_name}</h2>
        <p className="font-medium">{deletionLabel(job.status)}</p>
        <p className="text-sm">Backup preservado: <span className="break-all">{job.backup_id}</span></p>
        {job.status === 'pending' && <p>A operação já foi confirmada. Os dados permanecem bloqueados para alterações até você retomar ou cancelar.</p>}
        {job.status === 'media_cleanup' && <p>Os dados já foram excluídos. Conclua a limpeza para liberar a recuperação pelo backup.</p>}
        {job.status === 'completed' && <p>Os dados e as mídias do Storage foram removidos. O backup e o histórico desta operação foram preservados.</p>}
        <div className="flex flex-wrap gap-3">
          <Link to={backupLink} className="admin-button">Acessar backups</Link>
          {job.status !== 'completed' && <button type="button" disabled={busy} className="admin-button primary disabled:opacity-50"
            onClick={() => void perform((signal, notify) => processDeletion(job.id, signal, notify), 'Exclusão concluída. O backup foi preservado.')}>
            Retomar exclusão confirmada
          </button>}
          {job.status === 'pending' && <button type="button" disabled={busy} className="admin-button disabled:opacity-50"
            onClick={() => void perform(async () => { await cancelDeletion(job.id); requestId.current = null; }, 'Exclusão cancelada. Os dados foram preservados.')}>
            Cancelar exclusão
          </button>}
        </div>
      </section> : restaurant ? <section className="admin-card admin-form space-y-4">
        <h2 className="text-xl font-semibold">{restaurant.name} <span className="text-base font-normal">/{restaurant.slug}</span></h2>
        <p>Esta ação remove o cadastro, cardápio, mesas, vínculos da equipe, atendimentos, comandas e consumo deste restaurante, além das mídias originais do Storage.</p>
        <p>As contas de login e o backup privado permanecem. Recuperar pelo backup é uma operação separada. Arquivos locais da pasta public permanecem no site.</p>
        {!restaurant.archivedAt || restaurant.active ? <p className="admin-alert error">Arquive o restaurante na tela anterior antes de continuar.</p> : <>
          <Link to={backupLink} target="_blank" rel="noopener noreferrer" className="admin-button">Abrir backups e baixar ZIP ↗</Link>
          {!backups.length ? <p>Gere e baixe um backup concluído antes de excluir.</p> : <form onSubmit={event => {
            event.preventDefault();
            if (!canDelete) return;
            void perform(async (signal, notify) => {
              requestId.current ??= crypto.randomUUID();
              const created = await startDeletion({ id: requestId.current, restaurantId, backupId,
                name: confirmation, reason, backupSaved: saved });
              if (alive.current) setJob(created);
              signal.throwIfAborted();
              await processDeletion(created.id, signal, notify);
            }, 'Exclusão concluída. O backup foi preservado.');
          }}>
            <fieldset disabled={busy} className="space-y-4">
              <label htmlFor="delete-backup">Backup de recuperação
                <select id="delete-backup" required value={backupId} onChange={event => {
                  setBackupId(event.target.value); setSaved(false); requestId.current = null;
                }}>
                  <option value="">Selecione a cópia que você baixou</option>
                  {backups.map(b => <option key={b.id} value={b.id}>{new Date(b.createdAt).toLocaleString('pt-BR')} · {b.id.slice(0, 8)}</option>)}
                </select>
              </label>
              <p className="text-sm">O servidor bloqueará a exclusão se os dados ou as mídias mudaram depois desta cópia.</p>
              <label htmlFor="delete-name">Para confirmar, digite: {restaurant.name}
                <input id="delete-name" required maxLength={120} autoComplete="off" value={confirmation}
                  onChange={event => { setConfirmation(event.target.value); requestId.current = null; }} />
              </label>
              <label htmlFor="delete-reason">Motivo
                <textarea id="delete-reason" required minLength={3} maxLength={500} rows={3} value={reason}
                  onChange={event => { setReason(event.target.value); requestId.current = null; }} />
              </label>
              <label className="flex items-start gap-3" htmlFor="delete-saved">
                <input id="delete-saved" type="checkbox" required checked={saved} onChange={event => setSaved(event.target.checked)}
                  style={{ width: 20, minHeight: 20, flexShrink: 0 }} />
                <span>Baixei e guardei o ZIP desta cópia. Entendo que os dados e as mídias originais serão excluídos.</span>
              </label>
              <button type="submit" disabled={!canDelete || busy}
                className="min-h-12 rounded-xl bg-red-700 px-5 font-semibold text-white disabled:opacity-50">
                Confirmar exclusão definitiva
              </button>
            </fieldset>
          </form>}
        </>}
      </section> : <p className="admin-card">Restaurante não encontrado. <Link to={backupLink} className="underline">Consultar backups</Link></p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} className="admin-button disabled:opacity-50"
          onClick={() => void perform(async () => {}, 'Estado atualizado.')}>Atualizar estado</button>
        {busy && <button type="button" className="admin-button" onClick={() => controller.current?.abort()}>Pausar sequência</button>}
      </div>
      <p className="text-sm opacity-70">Pausar interrompe os próximos passos. Uma etapa já enviada pode terminar no servidor; consulte o estado antes de repetir.</p>
    </main>
  </div>;
}
