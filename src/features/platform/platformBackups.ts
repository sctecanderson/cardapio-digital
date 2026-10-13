import { supabase } from '../../lib/supabase';
import { createBackupZip } from './backupArchive';

export type BackupStatus = 'snapshot_created' | 'ready' | 'cancelled';
export interface BackupSummary {
  id: string; name: string; slug: string; status: BackupStatus;
  createdAt: string; completedAt: string | null; fileCount: number; verifiedCount: number;
}
export interface BackupFile {
  id: string; source_kind: 'storage' | 'local'; source_url: string | null;
  target_path: string; byte_count: number | null; sha256: string | null; verified_at: string | null;
}
export interface BackupProgress extends Omit<BackupSummary, 'fileCount' | 'verifiedCount'> {
  restaurantId: string; initialized: boolean; files: BackupFile[];
  snapshotPath: string; manifestPath: string;
  snapshotSha256: string | null; manifestSha256: string | null;
}
const MAX_FILE = 32 * 1024 * 1024;
const MAX_ZIP = 128 * 1024 * 1024;

async function rpc<T>(name: string, values: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, values);
  if (error) throw new Error(['42501', '22023', '55000'].includes(error.code) ? error.message :
    'Não foi possível consultar o backup. Confira a conexão e as migrations.');
  return data as T;
}
export const listBackups = (id: string) => rpc<BackupSummary[]>('list_platform_restaurant_backups', { p_restaurant_id: id });
export const startBackup = (restaurantId: string, backupId: string) => rpc<{ id: string }>('start_platform_restaurant_backup', {
  p_restaurant_id: restaurantId, p_backup_id: backupId,
});
export const cancelBackup = (id: string) => rpc<void>('cancel_platform_backup_snapshot', { p_backup_id: id });
export const getBackupProgress = (id: string) => rpc<BackupProgress>('get_platform_backup_progress', { p_backup_id: id });

async function worker<T>(body: Record<string, unknown>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const { data, error } = await supabase.functions.invoke('backup-restaurant', { body });
  signal.throwIfAborted();
  if (error) {
    let message = 'Não foi possível processar o backup. Confira a publicação da função e tente retomar.';
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const detail = await context.json().catch(() => null);
      if (detail && typeof detail.error === 'string') message = detail.error;
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export async function readBackupBytes(response: Response, limit: number, signal: AbortSignal) {
  if (!response.ok || !response.body) throw new Error('Não foi possível ler um arquivo do backup.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error('Arquivo acima do limite desta versão do backup.');
      chunks.push(value);
    }
  } catch (cause) { await reader.cancel().catch(() => undefined); throw cause; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export interface RecoveryValidation {
  backupId: string; restaurantId: string; name: string; slug: string;
  tableCount: number; rowCount: number; sourceExists: boolean; slugConflict: boolean;
}

export const validateRecovery = (id: string) => rpc<RecoveryValidation>(
  'validate_platform_backup_recovery', { p_backup_id: id },
);

export async function recoverBackup(id: string, confirmSlug: string, signal: AbortSignal, notice: (text: string) => void) {
  const validation = await validateRecovery(id);
  signal.throwIfAborted();
  if (validation.sourceExists || validation.slugConflict) {
    throw new Error('O restaurante ou seu endereço ainda existe. A recuperação não substitui dados.');
  }
  if (confirmSlug !== validation.slug) throw new Error('Digite o endereço exato para confirmar.');
  const progress = await getBackupProgress(id);
  if (progress.status !== 'ready') throw new Error('Selecione um backup concluído.');
  for (const [index, file] of progress.files.entries()) {
    signal.throwIfAborted();
    notice(`Recuperando e conferindo mídia ${index + 1} de ${progress.files.length}…`);
    if (file.source_kind === 'storage') {
      await worker({ action: 'recover-storage', backupId: id, fileId: file.id, confirmSlug }, signal);
    } else {
      const path = file.source_url || '';
      if (!/^\/(images|videos)\/[A-Za-z0-9_./-]+$/.test(path) || /(^|\/)\.{1,2}(\/|$)/.test(path)) {
        throw new Error('Caminho local inválido na recuperação.');
      }
      const response = await fetch(path, { signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error(`Mídia local ausente: ${path}. Reponha a pasta public com scripts/recover-local-media.py.`);
      const bytes = await readBackupBytes(response, MAX_FILE, signal);
      if (bytes.length !== file.byte_count || await hash(bytes) !== file.sha256) {
        throw new Error(`Reponha ${path} com scripts/recover-local-media.py e publique a pasta public antes de recuperar os dados.`);
      }
    }
  }
  notice('Conferindo os arquivos no servidor e recuperando os dados…');
  await worker({ action: 'recover-finish', backupId: id, confirmSlug }, signal);
}

export async function processBackup(id: string, signal: AbortSignal, notice: (text: string) => void) {
  let progress = await getBackupProgress(id);
  signal.throwIfAborted();
  if (progress.status === 'ready') return;
  if (progress.status !== 'snapshot_created') throw new Error('Backup cancelado. Gere uma nova cópia.');
  if (!progress.initialized) {
    await rpc('prepare_platform_backup_files', { p_backup_id: id });
    progress = await getBackupProgress(id);
  }
  let done = progress.files.filter((file) => file.verified_at).length;
  for (const file of progress.files) {
    signal.throwIfAborted();
    if (file.verified_at) continue;
    notice(`Copiando e conferindo arquivo ${done + 1} de ${progress.files.length}…`);
    if (file.source_kind === 'storage') {
      await worker({ action: 'copy-storage', backupId: id, fileId: file.id }, signal);
    } else {
      const path = file.source_url || '';
      if (!/^\/(images|videos)\/[A-Za-z0-9_./-]+$/.test(path) || /(^|\/)\.{1,2}(\/|$)/.test(path)) {
        throw new Error('Caminho local inválido no backup.');
      }
      const response = await fetch(path, { signal, cache: 'no-store', redirect: 'error' });
      if (!(response.headers.get('content-type') || '').match(/^(image|video)\//i)) {
        throw new Error(`Mídia local ausente: ${path}. Confira a pasta public.`);
      }
      const bytes = await readBackupBytes(response, MAX_FILE, signal);
      const sha256 = await hash(bytes);
      const upload = await worker<{ exists?: boolean; path: string; token?: string; contentType: string }>({
        action: 'local-upload', backupId: id, fileId: file.id,
      }, signal);
      if (!upload.exists) {
        if (!upload.token) throw new Error('Autorização de envio indisponível.');
        const { error } = await supabase.storage.from('elozi-backups').uploadToSignedUrl(
          upload.path, upload.token, bytes, { contentType: upload.contentType },
        );
        signal.throwIfAborted();
        // Mesmo com resposta perdida, a verificação abaixo pode confirmar o envio.
        if (error) notice('Conferindo se o envio foi recebido…');
      }
      await worker({ action: 'verify-local', backupId: id, fileId: file.id, sha256, byteCount: bytes.length }, signal);
    }
    done++;
  }
  notice('Conferindo os documentos e concluindo a cópia…');
  await worker({ action: 'finalize', backupId: id }, signal);
}

export async function downloadBackup(id: string, signal: AbortSignal, notice: (text: string) => void) {
  const progress = await getBackupProgress(id);
  signal.throwIfAborted();
  if (progress.status !== 'ready') throw new Error('Conclua o backup antes de baixar.');
  if (progress.files.reduce((sum, file) => sum + (file.byte_count ?? 0), 0) > MAX_ZIP) {
    throw new Error('Download pelo navegador limitado a 128 MiB. A cópia privada permanece armazenada.');
  }
  const entries = [
    { id: 'snapshot', path: progress.snapshotPath, sha: progress.snapshotSha256 },
    { id: 'manifest', path: progress.manifestPath, sha: progress.manifestSha256 },
    ...progress.files.map((file) => ({ id: file.id, path: file.target_path, sha: file.sha256 })),
  ];
  const files: { path: string; bytes: Uint8Array }[] = [];
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    signal.throwIfAborted();
    notice(`Baixando e conferindo ${index + 1} de ${entries.length} arquivos…`);
    const signed = await worker<{ url: string; sha256: string }>({ action: 'download', backupId: id, fileId: entry.id }, signal);
    const response = await fetch(signed.url, { signal, cache: 'no-store', redirect: 'error' });
    const bytes = await readBackupBytes(response, Math.min(MAX_FILE, MAX_ZIP - total), signal);
    if (!entry.sha || signed.sha256 !== entry.sha || await hash(bytes) !== entry.sha) {
      throw new Error('Um arquivo falhou na conferência de integridade. O ZIP não foi salvo.');
    }
    files.push({ path: entry.path, bytes });
    total += bytes.length;
  }
  signal.throwIfAborted();
  notice('Preparando ZIP…');
  const blob = createBackupZip(files);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `elozi-${progress.slug}-${id}.zip`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Dá tempo ao navegador para iniciar a gravação do arquivo.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
