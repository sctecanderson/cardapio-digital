// Auth, RPC e Storage simulados. Não usa o Supabase remoto.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const rid = '11111111-1111-4111-8111-111111111111';
const bid = '22222222-2222-4222-8222-222222222222';
const jid = '33333333-3333-4333-8333-333333333333';
const fid = '44444444-4444-4444-8444-444444444444';
const digest = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const media = new Uint8Array([82, 73, 70, 70, 12, 0, 0, 0, 87, 69, 66, 80]);
const snapshot = new TextEncoder().encode('{"snapshot":true}');
const manifest = new TextEncoder().encode('{"manifest":true}');
const file = { id: fid, source_kind: 'storage', source_bucket: 'menu-images', source_path: `${rid}/products/test.webp`,
  target_path: `${bid}/media/${fid}`, sha256: await digest(media), byte_count: media.length };
const backup = { status: 'ready', restaurantId: rid, snapshotPath: `${bid}/snapshot.json`, manifestPath: `${bid}/manifest.json`,
  snapshotSha256: await digest(snapshot), manifestSha256: await digest(manifest) };
const job = { id: jid, source_restaurant_id: rid, backup_id: bid, status: 'pending', files: [file] };
const originals = `menu-images/${file.source_path}`;
const privatePath = `elozi-backups/${file.target_path}`;
const objects = new Map([[originals, new Blob([media])], [privatePath, new Blob([media])],
  [`elozi-backups/${backup.snapshotPath}`, new Blob([snapshot])], [`elozi-backups/${backup.manifestPath}`, new Blob([manifest])]]);
let privileged = 0; let removes = 0; let deletes = 0; let lease = null; let removed = false;
let removeFails = false; let recordResponseLost = false;
const checks = new Set();
const ok = (data = null) => ({ data, error: null });
const fail = message => ({ data: null, error: { message } });
const storage = bucket => ({
  download: async path => objects.has(`${bucket}/${path}`) ? ok(objects.get(`${bucket}/${path}`)) : fail('missing'),
  exists: async path => ok(objects.has(`${bucket}/${path}`)),
  remove: async paths => {
    assert.equal(bucket, 'menu-images'); assert.deepEqual(paths, [file.source_path]);
    if (removeFails) return fail('network failure');
    removes++; for (const path of paths) objects.delete(`${bucket}/${path}`); return ok();
  },
});
globalThis.__createClient = (_url, key, options) => {
  assert.equal(typeof options.global.fetch, 'function');
  if (key === 'service') {
    privileged++;
    return { storage: { from: storage }, rpc: async (name, args) => {
      assert.equal(args.p_deletion_id, jid);
      if (name === 'record_platform_deletion_check') { checks.add(args.p_file_key); return ok(); }
      if (name === 'delete_platform_restaurant_data') {
        if (job.status === 'media_cleanup') return ok();
        if (!['snapshot', 'manifest', fid].every(k => checks.has(k))) return fail('missing verification');
        deletes++; job.status = 'media_cleanup'; return ok();
      }
      if (name === 'claim_platform_deletion_worker') {
        if (lease) return fail('already claimed'); lease = 'lease'; return ok(lease);
      }
      if (name === 'release_platform_deletion_worker') { assert.equal(args.p_token, lease); lease = null; return ok(); }
      if (name === 'record_platform_deletion_media_removed') {
        assert.equal(args.p_token, lease); assert.equal(objects.has(originals), false);
        if (recordResponseLost) { recordResponseLost = false; return fail('lost response'); }
        removed = true; return ok();
      }
      assert.equal(name, 'finish_platform_restaurant_deletion');
      if (!removed || lease) return fail('pending media');
      job.status = 'completed'; return ok();
    } };
  }
  const auth = options.global.headers.Authorization;
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'owner-id', is_anonymous: auth === 'Bearer guest' } }, error: null }) },
    rpc: async name => {
      if (auth !== 'Bearer owner') return { data: null, error: { code: '42501', message: 'Acesso exclusivo' } };
      if (name === 'get_platform_restaurant_deletion') return ok(structuredClone(job));
      assert.equal(name, 'get_platform_backup_progress'); return ok(backup);
    },
  };
};
let handler;
globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service', ADMIN_ALLOWED_ORIGINS: 'http://localhost:5173' })[key] }, serve: fn => { handler = fn; } };
const source = (await readFile(resolve(root, 'supabase/functions/delete-restaurant/index.ts'), 'utf8'))
  .replace('import { createClient } from "npm:@supabase/supabase-js@2.117.3";', 'const createClient = globalThis.__createClient;');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const call = async (action, extras = {}, token = 'owner', origin = 'http://localhost:5173') => {
  const response = await handler(new Request('https://test.supabase.co/functions/v1/delete-restaurant', {
    method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Origin: origin },
    body: JSON.stringify({ action, deletionId: jid, ...extras }),
  }));
  return { status: response.status, body: await response.json() };
};
assert.equal((await call('delete-data', {}, '')).status, 401);
assert.equal((await call('delete-data', {}, 'guest')).status, 401);
assert.equal((await call('delete-data', {}, 'waiter')).status, 403);
assert.equal((await call('delete-data', {}, 'owner', 'https://other.invalid')).status, 403);
assert.equal(privileged, 0);
assert.equal((await call('verify-file', { fileKey: 'outside' })).status, 404);
assert.equal((await call('delete-data')).status, 409);
assert.equal(deletes, 0);
objects.set(privatePath, new Blob(['corrupted']));
assert.equal((await call('verify-file', { fileKey: fid })).status, 409);
assert.equal(checks.has(fid), false);
objects.set(privatePath, new Blob([media]));
for (const fileKey of ['snapshot', 'manifest', fid]) assert.equal((await call('verify-file', { fileKey })).status, 200);
assert.equal((await call('remove-media', { fileId: fid })).status, 409);
assert.equal((await call('delete-data')).status, 200);
assert.equal((await call('delete-data')).status, 200);
assert.equal(deletes, 1);
assert.equal((await call('remove-media', { fileId: 'wrong-tenant' })).status, 404);
const path = file.source_path;
file.source_path = '99999999-9999-4999-8999-999999999999/products/test.webp';
assert.equal((await call('remove-media', { fileId: fid })).status, 404);
file.source_path = path;
objects.set(originals, new Blob(['changed original']));
assert.equal((await call('remove-media', { fileId: fid })).status, 409);
assert.equal(removes, 0); assert.equal(lease, null);
objects.set(originals, new Blob([media]));
removeFails = true;
assert.equal((await call('remove-media', { fileId: fid })).status, 409);
assert.equal(lease, null); assert.equal(objects.has(originals), true);
removeFails = false; recordResponseLost = true;
assert.equal((await call('remove-media', { fileId: fid })).status, 409);
assert.equal(removes, 1); assert.equal(lease, null); assert.equal(objects.has(originals), false);
assert.equal((await call('remove-media', { fileId: fid })).status, 200);
assert.equal(removes, 1, 'A repetição reconhece a remoção recebida antes da queda da resposta.');
assert.equal((await call('finish')).status, 200);
// Um trabalhador atrasado não pode remover mídias de uma recuperação posterior.
objects.set(originals, new Blob([media]));
assert.equal((await call('remove-media', { fileId: fid })).body.status, 'completed');
assert.equal(removes, 1); assert.equal(objects.has(originals), true);
assert.equal(objects.has(privatePath), true);
console.log('PASS: owner/origin, backup corruption, no cross-tenant deletion, unchanged originals, network retry, private backup preserved, completed job cannot delete again.');
console.log('Auth, RPC e Storage simulados; nenhuma operação no Supabase remoto.');
