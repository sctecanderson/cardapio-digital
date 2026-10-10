import { supabase } from '../../lib/supabase';

export type DeletionStatus = 'pending' | 'deleting_data' | 'media_cleanup' | 'completed' | 'cancelled';
export interface DeletionRecord {
  id: string; source_restaurant_id: string; source_name: string; source_slug: string;
  backup_id: string; requested_at: string; status: DeletionStatus; reason: string;
  data_deleted_at: string | null; completed_at: string | null;
}
export interface DeletionProgress extends DeletionRecord {
  files: { id: string; source_kind: 'local' | 'storage' }[];
  checks: { file_key: string; verified_at: string; removed_at: string | null }[];
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(['42501', '22023', '55000'].includes(error.code) ? error.message :
    'Não foi possível consultar a exclusão. Confira a conexão e a nova migration.');
  return data as T;
}
export const listDeletions = () => rpc<DeletionRecord[]>('list_platform_restaurant_deletions');
export const getDeletion = (id: string) => rpc<DeletionProgress>('get_platform_restaurant_deletion', { p_deletion_id: id });
export const cancelDeletion = (id: string) => rpc<void>('cancel_platform_restaurant_deletion', { p_deletion_id: id });
export const startDeletion = (input: { id: string; restaurantId: string; backupId: string; name: string; reason: string; backupSaved: boolean }) =>
  rpc<DeletionProgress>('start_platform_restaurant_deletion', {
    p_id: input.id, p_restaurant_id: input.restaurantId, p_backup_id: input.backupId,
    p_confirmation_name: input.name, p_reason: input.reason, p_backup_saved: input.backupSaved,
  });

async function worker(body: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  const { data, error } = await supabase.functions.invoke('delete-restaurant', { body });
  signal.throwIfAborted();
  if (error) {
    let message = 'Não foi possível concluir. Confira a publicação de delete-restaurant e retome a operação.';
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const detail = await context.json().catch(() => null);
      if (typeof detail?.error === 'string') message = detail.error;
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
}

export async function processDeletion(id: string, signal: AbortSignal, notify: (text: string) => void) {
  let job = await getDeletion(id);
  signal.throwIfAborted();
  if (job.status === 'completed') return;
  if (job.status === 'cancelled') throw new Error('Exclusão cancelada. Crie outra solicitação se necessário.');
  if (job.status === 'pending') {
    const keys = ['snapshot', 'manifest', ...job.files.map(f => f.id)];
    for (const [index, fileKey] of keys.entries()) {
      notify(`Conferindo o backup: ${index + 1} de ${keys.length} arquivos…`);
      await worker({ action: 'verify-file', deletionId: id, fileKey }, signal);
    }
    notify('Excluindo os dados do restaurante…');
    await worker({ action: 'delete-data', deletionId: id }, signal);
    job = await getDeletion(id);
  }
  signal.throwIfAborted();
  if (job.status === 'completed') return;
  if (job.status !== 'media_cleanup') throw new Error('Atualize a operação antes de retomar.');
  const storageFiles = job.files.filter(f => f.source_kind === 'storage');
  for (const [index, file] of storageFiles.entries()) {
    signal.throwIfAborted();
    if (job.checks.some(check => check.file_key === file.id && check.removed_at)) continue;
    notify(`Dados excluídos. Limpando mídia ${index + 1} de ${storageFiles.length}…`);
    await worker({ action: 'remove-media', deletionId: id, fileId: file.id }, signal);
  }
  notify('Conferindo o término da exclusão…');
  await worker({ action: 'finish', deletionId: id }, signal);
}

export function deletionLabel(status: DeletionStatus) {
  return { pending: 'Aguardando verificação', deleting_data: 'Excluindo dados', media_cleanup: 'Dados excluídos · limpeza pendente',
    completed: 'Exclusão concluída', cancelled: 'Cancelada' }[status];
}
