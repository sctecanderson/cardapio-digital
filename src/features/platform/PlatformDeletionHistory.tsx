import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { deletionLabel, listDeletions, type DeletionRecord } from './platformDeletions';

export function PlatformDeletionHistory({ refresh }: { refresh: number }) {
  const [jobs, setJobs] = useState<DeletionRecord[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    setError('');
    void listDeletions().then(result => { if (!disposed) setJobs(result); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar o histórico.'); });
    return () => { disposed = true; };
  }, [refresh]);
  return <section aria-labelledby="deletion-history-title" className="space-y-4">
    <h2 id="deletion-history-title" className="text-xl font-semibold">Exclusões e backups preservados</h2>
    {error && <p role="alert" className="admin-alert error">{error}</p>}
    {!jobs.length && !error ? <p className="text-sm opacity-70">Nenhuma solicitação de exclusão registrada.</p> : <ul className="grid gap-4 md:grid-cols-2">
      {jobs.map(job => <li key={job.id} className="admin-card space-y-2">
        <h3 className="font-semibold">{job.source_name}</h3>
        <p className="text-sm">{deletionLabel(job.status)} · {new Date(job.requested_at).toLocaleString('pt-BR')}</p>
        <div className="flex flex-wrap gap-3">
          <Link to={`/plataforma/restaurantes/${job.source_restaurant_id}/backups`} className="admin-button">Backups e recuperação</Link>
          {!['completed', 'cancelled'].includes(job.status) && <Link to={`/plataforma/restaurantes/${job.source_restaurant_id}/excluir`} className="admin-button">Retomar operação</Link>}
        </div>
      </li>)}
    </ul>}
  </section>;
}
