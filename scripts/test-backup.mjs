import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const compiled = (source) => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
} }).outputText;
const rid = '11111111-1111-4111-8111-111111111111';
const bid = '22222222-2222-4222-8222-222222222222';
const localId = '33333333-3333-4333-8333-333333333333';
const storageId = '44444444-4444-4444-8444-444444444444';
const project = 'https://test.supabase.co';
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 42, 43]);
const webp = Uint8Array.from([82,73,70,70,12,0,0,0,87,69,66,80,42,43]);
const digest = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const files = [
  { id: localId, backup_id: bid, source_kind: 'local', source_key: 'local:/images/noma/a.png',
    source_bucket: null, source_path: null, source_url: '/images/noma/a.png',
    target_path: `${bid}/media/${localId}`, expected_bytes: null, byte_count: null, sha256: null, verified_at: null },
  { id: storageId, backup_id: bid, source_kind: 'storage', source_key: 'storage:a',
    source_bucket: 'menu-images', source_path: `${rid}/products/a.webp`,
    source_url: `${project}/storage/v1/object/public/menu-images/${rid}/products/a.webp`,
    target_path: `${bid}/media/${storageId}`, expected_bytes: webp.length, byte_count: null, sha256: null, verified_at: null },
];
const progress = { id: bid, restaurantId: rid, name: 'Teste', slug: 'teste', status: 'snapshot_created',
  initialized: true, files, createdAt: '2026-01-01T00:00:00Z', snapshotPath: `${bid}/snapshot.json`,
  manifestPath: `${bid}/manifest.json`, snapshotSha256: null, manifestSha256: null };
const objects = new Map([[`menu-images/${files[1].source_path}`, new Blob([webp])]]);
let sealCalls = 0;
let recoveryCalls = 0;
const recoveryValidation = { backupId: bid, restaurantId: rid, name: 'Teste', slug: 'teste', tableCount: 17, rowCount: 20, sourceExists: true, slugConflict: false };
let serviceCalls = 0;
const ok = (data = null) => ({ data, error: null });
const storage = (bucket) => ({
  exists: async (path) => ok(objects.has(`${bucket}/${path}`)),
  createSignedUploadUrl: async (path, options) => {
    assert.equal(options.upsert, false); return ok({ token: 'mock-token', path });
  },
  createSignedUrl: async (path) => ok({ signedUrl: `${project}/signed/${path}` }),
  download: async (path) => objects.has(`${bucket}/${path}`) ? ok(objects.get(`${bucket}/${path}`)) :
    { data: null, error: { message: 'not found' } },
  upload: async (path, bytes, options) => {
    assert.equal(options.upsert, false);
    if (objects.has(`${bucket}/${path}`)) return { data: null, error: { message: 'exists' } };
    objects.set(`${bucket}/${path}`, new Blob([bytes], { type: options.contentType })); return ok({ path });
  },
});
globalThis.__createClient = (_url, key, options) => {
  if (key === 'service') {
    serviceCalls++;
    return { storage: { from: storage }, rpc: async (name, args) => {
      if (name === 'complete_platform_backup_recovery') { recoveryCalls++; recoveryValidation.sourceExists = true; return ok({ recovered: true, archived: true }); }
      if (name === 'record_platform_backup_file_verification') {
        const file = files.find((f) => f.id === args.p_file_id);
        file.sha256 = args.p_sha256; file.byte_count = args.p_byte_count; file.verified_at = '2026-01-01T00:01:00Z';
        return ok();
      }
      assert.equal(name, 'seal_platform_restaurant_backup');
      assert(files.every((f) => f.verified_at)); sealCalls++;
      progress.snapshotSha256 = args.p_snapshot_sha256; progress.manifestSha256 = args.p_manifest_sha256;
      progress.status = 'ready'; return ok();
    } };
  }
  const token = options.global.headers.Authorization;
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user', is_anonymous: token === 'Bearer guest' } }, error: null }) },
    rpc: async (name) => {
      if (token !== 'Bearer owner') return { data: null, error: { code: '42501', message: 'Acesso negado' } };
      if (name === 'get_platform_backup_progress') return ok(structuredClone(progress));
      if (name === 'validate_platform_backup_recovery') return ok(structuredClone(recoveryValidation));
      assert.equal(name, 'get_platform_backup_snapshot');
      return ok({ snapshot: { format: 'elozi-restaurant-snapshot', version: 1, restaurantId: rid,
        tables: { restaurants: [{ id: rid, name: 'Teste' }] }, scope: { mediaBytesIncluded: false, authUsersIncluded: false } } });
    },
  };
};
let handler;
globalThis.Deno = { env: { get: (key) => ({ SUPABASE_URL: project, SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service', ADMIN_ALLOWED_ORIGINS: 'http://localhost:5173' })[key] },
  serve: (fn) => { handler = fn; } };
let source = await readFile(resolve(root, 'supabase/functions/backup-restaurant/index.ts'), 'utf8');
source = source.replace('import { createClient } from "npm:@supabase/supabase-js@2.117.3";',
  'const createClient = globalThis.__createClient;');
await import(`data:text/javascript;base64,${Buffer.from(compiled(source)).toString('base64')}`);
const call = async (action, extras = {}, token = 'owner', origin = 'http://localhost:5173') => {
  const response = await handler(new Request(`${project}/functions/v1/backup-restaurant`, {
    method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, backupId: bid, ...extras }),
  }));
  return { status: response.status, body: await response.json() };
};
assert.equal((await call('progress', {}, '')).status, 401);
assert.equal((await call('progress', {}, 'guest')).status, 401);
assert.equal((await call('progress', {}, 'waiter')).status, 403);
assert.equal((await call('progress', {}, 'owner', 'https://evil.invalid')).status, 403);
assert.equal(serviceCalls, 0, 'Negação de acesso acontece antes de usar o cliente privilegiado');
assert.equal((await call('finalize')).status, 409);
assert.equal((await call('local-upload', { fileId: 'other' })).status, 404);
assert.equal((await call('local-upload', { fileId: localId })).body.token, 'mock-token');
objects.set(`elozi-backups/${files[0].target_path}`, new Blob([png]));
assert.equal((await call('local-upload', { fileId: localId })).body.exists, true);
assert.equal((await call('verify-local', { fileId: localId, sha256: 'bad', byteCount: png.length })).status, 422);
assert.equal(files[0].verified_at, null);
assert.equal((await call('verify-local', { fileId: localId, sha256: await digest(png), byteCount: png.length })).status, 200);
objects.set(`elozi-backups/${files[1].target_path}`, new Blob(['corrupt']));
assert.equal((await call('copy-storage', { fileId: storageId })).status, 409);
assert.equal(files[1].verified_at, null);
objects.delete(`elozi-backups/${files[1].target_path}`);
const originalUrl = files[1].source_url;
files[1].source_url = 'https://external.invalid/file.webp';
assert.equal((await call('copy-storage', { fileId: storageId })).status, 400);
files[1].source_url = originalUrl;
assert.equal((await call('copy-storage', { fileId: storageId })).status, 200);
assert.equal((await call('copy-storage', { fileId: storageId })).status, 200);
assert.equal((await call('finalize')).status, 200);
assert.equal((await call('finalize')).status, 200);
assert.equal(sealCalls, 1, 'Resposta perdida da conclusão permite repetir sem duplicar');
assert.equal((await call('progress')).body.status, 'ready');
assert.equal((await call('download', { fileId: 'other' })).status, 404);
assert.equal((await call('download', { fileId: 'snapshot' })).body.sha256, progress.snapshotSha256);
const manifest = JSON.parse(await objects.get(`elozi-backups/${progress.manifestPath}`).text());
assert.equal(manifest.scope.mediaBytesIncluded, true);
assert.equal(manifest.scope.authUsersIncluded, false);
assert.equal(manifest.snapshotSha256, progress.snapshotSha256);
for (const file of manifest.media) {
  assert.equal(await digest(await objects.get(`elozi-backups/${file.path}`).arrayBuffer()), file.sha256);
}
assert.equal((await call('recovery-check')).body.sourceExists, true);
assert.equal((await call('recover-storage', { fileId: storageId, confirmSlug: 'teste' })).status, 409);
assert.equal(recoveryCalls, 0);
recoveryValidation.sourceExists = false;
assert.equal((await call('recover-finish', { confirmSlug: 'wrong' })).status, 400);
assert.equal((await call('recover-storage', { fileId: 'other', confirmSlug: 'teste' })).status, 404);
objects.set(`menu-images/${files[1].source_path}`, new Blob(['different original']));
assert.equal((await call('recover-storage', { fileId: storageId, confirmSlug: 'teste' })).status, 500);
assert.equal(await objects.get(`menu-images/${files[1].source_path}`).text(), 'different original');
objects.delete(`menu-images/${files[1].source_path}`);
assert.equal((await call('recover-storage', { fileId: storageId, confirmSlug: 'teste' })).status, 200);
assert.equal((await call('recover-storage', { fileId: storageId, confirmSlug: 'teste' })).status, 200);
const savedManifest = objects.get(`elozi-backups/${progress.manifestPath}`);
objects.set(`elozi-backups/${progress.manifestPath}`, new Blob(['corrupt manifest']));
assert.equal((await call('recover-finish', { confirmSlug: 'teste' })).status, 500);
assert.equal(recoveryCalls, 0);
objects.set(`elozi-backups/${progress.manifestPath}`, savedManifest);
const savedLocal = objects.get(`elozi-backups/${files[0].target_path}`);
objects.set(`elozi-backups/${files[0].target_path}`, new Blob(['corrupt local']));
assert.equal((await call('recover-finish', { confirmSlug: 'teste' })).status, 500);
assert.equal(recoveryCalls, 0);
objects.set(`elozi-backups/${files[0].target_path}`, savedLocal);
assert.equal((await call('recover-finish', { confirmSlug: 'teste' })).body.archived, true);
assert.equal(recoveryCalls, 1);
assert.equal((await call('recover-finish', { confirmSlug: 'teste' })).status, 409);
console.log('PASS recovery: explicit confirmation, no overwrite, missing media, retries, checksums and archived result.');
const zipSource = await readFile(resolve(root, 'src/features/platform/backupArchive.ts'), 'utf8');
const { createBackupZip } = await import(`data:text/javascript;base64,${Buffer.from(compiled(zipSource)).toString('base64')}`);
assert.throws(() => createBackupZip([{ path: '../bad', bytes: png }]));
assert.throws(() => createBackupZip([{ path: 'a', bytes: png }, { path: 'a', bytes: png }]));
const entries = [...objects].filter(([path]) => path.startsWith('elozi-backups/'));
const archive = createBackupZip(await Promise.all(entries.map(async ([path, blob]) => ({
  path: path.slice('elozi-backups/'.length), bytes: new Uint8Array(await blob.arrayBuffer()),
}))));
if (process.env.BACKUP_TEST_ZIP) await writeFile(process.env.BACKUP_TEST_ZIP, new Uint8Array(await archive.arrayBuffer()));
console.log('PASS: permissões, origem, isolamento, cópia, corrupção, repetição, conclusão, manifesto e caminhos do ZIP.');
console.log('Auth, RPC e Storage simulados. Não substitui o teste de upload no projeto Supabase.');
