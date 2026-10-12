import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const candidatePglitePaths = [
  process.env.PGLITE_MODULE ? path.resolve(process.env.PGLITE_MODULE) : null,
  path.resolve(projectRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
  path.resolve(projectRoot, '.tools', 'pglite', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
].filter((candidate) => Boolean(candidate) && fs.existsSync(candidate));

if (candidatePglitePaths.length === 0) {
  throw new Error(
    'Informe PGLITE_MODULE apontando para @electric-sql/pglite/dist/index.js ou disponibilize em .tools/pglite.',
  );
}

const { PGlite } = await import(pathToFileURL(candidatePglitePaths[0]).href);

console.log('--- Iniciando Banco PostgreSQL Local para Validação Final do Bloco 6.1 ---');
const db = new PGlite();

await db.exec(`
create role anon;
create role authenticated;
create role service_role bypassrls;
create publication supabase_realtime;
create schema auth;
create schema storage;
create schema extensions;

create table auth.users (
  id uuid primary key,
  is_anonymous boolean default false
);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create function extensions.gen_random_bytes(integer) returns bytea language sql as $$
  select decode(repeat('00', $1), 'hex')
$$;

create table storage.buckets (
  id text primary key,
  name text,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(bucket_id, name)
);
alter table storage.objects enable row level security;
`);

const root = path.resolve(import.meta.dirname, '..');
const migrationFiles = (await fs.promises.readdir(path.join(root, 'supabase', 'migrations'))).sort();

for (const name of migrationFiles) {
  try {
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      const demoSeed = await fs.promises.readFile(path.join(root, 'supabase', 'seeds', 'demo_restaurants.sql'), 'utf8');
      await db.exec(demoSeed);
    }
    const sql = await fs.promises.readFile(path.join(root, 'supabase', 'migrations', name), 'utf8');
    await db.exec(sql);
  } catch (e) {
    console.error(`Erro ao compilar migration ${name}:`, e.message);
    process.exit(1);
  }
}

console.log('PASS: Todas as migrações compiladas com sucesso.\n');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const guest1 = '90000000-0000-4000-8000-000000000001';
const guest2 = '90000000-0000-4000-8000-000000000002';
const guest3 = '90000000-0000-4000-8000-000000000003';
const adminUser = '80000000-0000-4000-8000-000000000001';

await db.exec(`
insert into auth.users (id, is_anonymous) values
  ('${guest1}', true),
  ('${guest2}', true),
  ('${guest3}', true),
  ('${adminUser}', false);

insert into public.platform_admins (user_id) values ('${adminUser}');
`);

const [{ id: nomaId, slug: nomaSlug }] = await q("select id, slug from public.restaurants where slug = 'noma'");
const products = await q('select id, name, available, likes_count, category_id from public.menu_products where restaurant_id = $1 order by sort_order', [nomaId]);
const activeProd1 = products[0];
const activeProd2 = products[1];

// ============================================================================
// TESTE 1: PERMISSÕES COM ROLES EFETIVAS (anon, authenticated, service_role)
// ============================================================================
console.log('--- Teste 1: Testes de Permissões com Roles Efetivas ---');

// 1.1 anon não pode ler tabelas privadas
await db.exec("set role anon; select set_config('request.jwt.claim.sub', '', false);");
await assert.rejects(
  async () => { await q('select * from public.product_likes'); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'anon não pode consultar product_likes'
);
await assert.rejects(
  async () => { await q('select * from public.product_like_events'); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'anon não pode consultar product_like_events'
);

// 1.2 authenticated não pode ler tabelas privadas
await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${guest1}', false);`);
await assert.rejects(
  async () => { await q('select * from public.product_likes'); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'authenticated não pode consultar product_likes'
);

// 1.3 authenticated não pode executar função privada de reconciliação
await assert.rejects(
  async () => { await q('select public.reconcile_restaurant_likes_count($1)', [nomaId]); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'authenticated não pode executar reconcile_restaurant_likes_count'
);

// 1.4 Proteção de escrita direta em likes_count
await assert.rejects(
  async () => {
    await db.exec(`update public.menu_products set likes_count = 500 where id = '${activeProd1.id}'`);
  },
  (err) => err.code === '42501' || /gerenciada automaticamente|permission denied/.test(err.message),
  'authenticated é expressamente bloqueado ao tentar alterar likes_count'
);

await db.exec('reset role;');
console.log('PASS: Roles anon e authenticated têm acesso direto estritamente revogado e protegido.');

// ============================================================================
// TESTE 2: GUARDA MATEMÁTICA EM likes_count (Direto e via Trigger Não Relacionado)
// ============================================================================
console.log('\n--- Teste 2: Guarda Matemática contra Alteração Arbitrária e Trigger Malicioso ---');

// 2.1 Tentativa direta de update em likes_count para um número que não corresponde aos registros de product_likes
await assert.rejects(
  async () => {
    await db.exec(`update public.menu_products set likes_count = 999 where id = '${activeProd1.id}'`);
  },
  (err) => err.code === '42501' || /deve corresponder exatamente/.test(err.message),
  'Tentativa direta de update arbitrário em likes_count bloqueada'
);

// 2.2 Tentativa de alterar likes_count a partir de UM OUTRO TRIGGER (em profundidade > 1)
await db.exec(`
create or replace function public.test_unrelated_trigger_fn()
returns trigger language plpgsql as $$
begin
  update public.menu_products set likes_count = 777 where id = '${activeProd1.id}';
  return new;
end;
$$;

create trigger test_unrelated_trigger
  after update of subtitle on public.restaurants
  for each row execute function public.test_unrelated_trigger_fn();
`);

await assert.rejects(
  async () => {
    await db.exec(`update public.restaurants set subtitle = 'Subtitulo Novo' where id = '${nomaId}'`);
  },
  (err) => err.code === '42501' || /deve corresponder exatamente/.test(err.message),
  'Trigger não relacionado tentando alterar likes_count para valor falso deve ser bloqueado!'
);

await db.exec(`
drop trigger test_unrelated_trigger on public.restaurants;
drop function public.test_unrelated_trigger_fn();
`);

// 2.3 Edições normais de catálogo continuam funcionando perfeitamente
await db.exec(`update public.menu_products set short_description = 'Descrição atualizada' where id = '${activeProd1.id}'`);
const [descCheck] = await q('select short_description from public.menu_products where id = $1', [activeProd1.id]);
assert.equal(descCheck.short_description, 'Descrição atualizada');
console.log('PASS: Guarda matemática bloqueia qualquer escrita arbitrária (mesmo dentro de outro trigger).');

// ============================================================================
// TESTE 3: INTEGRIDADE MULTI-TENANT (Impedir Cruzamento de restaurant_id e product_id)
// ============================================================================
console.log('\n--- Teste 3: Integridade Multi-Tenant Referencial Composta ---');

const otherRestId = 'aaaaaaaa-1111-4111-8111-111111111111';
await db.exec(`
insert into public.restaurants (id, slug, name, active)
values ('${otherRestId}', 'outro-restaurante', 'Outro Restaurante', true);
`);

await assert.rejects(
  async () => {
    await db.exec(`
      insert into public.product_likes (restaurant_id, product_id, user_id)
      values ('${otherRestId}', '${activeProd1.id}', '${guest1}');
    `);
  },
  (err) => err.code === '23503' || /product_likes_product_same_restaurant/.test(err.message),
  'FK composta deve impedir cruzar produto de um restaurante com outro restaurante'
);
console.log('PASS: FK composta (product_id, restaurant_id) impede cruzamento indevido entre restaurantes.');

// ============================================================================
// TESTE 4: OPERAÇÕES DE CURTIR, IDEMPOTÊNCIA, THROTTLE E PRESERVAÇÃO DE REVISION
// ============================================================================
console.log('\n--- Teste 4: Curtir, Idempotência, Throttle e Preservação de Revision ---');
const [revBeforeLike] = await q('select revision from public.menu_products where id = $1', [activeProd1.id]);

await db.exec(`select set_config('request.jwt.claim.sub', '${guest1}', false)`);

const [like1] = await q('select public.toggle_product_like($1, $2, $3) as res', [nomaSlug, activeProd1.id, true]);
assert.equal(like1.res.liked, true);
assert.equal(like1.res.likesCount, 1);

const [revAfterLike] = await q('select revision from public.menu_products where id = $1', [activeProd1.id]);
assert.equal(revAfterLike.revision, revBeforeLike.revision, 'Curtir produto NÃO deve incrementar menu_products.revision');

const [likeRepeat] = await q('select public.toggle_product_like($1, $2, $3) as res', [nomaSlug, activeProd1.id, true]);
assert.equal(likeRepeat.res.liked, true);
assert.equal(likeRepeat.res.likesCount, 1);

await assert.rejects(
  async () => { await q('select public.toggle_product_like($1, $2, $3)', [nomaSlug, activeProd1.id, false]); },
  (err) => err.code === '55000' || /Aguarde um momento/.test(err.message),
  'Throttle de 2s bloqueia alternância rápida'
);

await db.exec(`update public.product_like_events set created_at = clock_timestamp() - interval '3 seconds' where user_id = '${guest1}';`);
const [unlike1] = await q('select public.toggle_product_like($1, $2, $3) as res', [nomaSlug, activeProd1.id, false]);
assert.equal(unlike1.res.liked, false);
assert.equal(unlike1.res.likesCount, 0);

const [revAfterUnlike] = await q('select revision from public.menu_products where id = $1', [activeProd1.id]);
assert.equal(revAfterUnlike.revision, revBeforeLike.revision, 'Descurtir produto NÃO deve incrementar menu_products.revision');
console.log('PASS: Fluxo de curtir, repetição idempotente, descurtir e preservação de revision validados.');

// ============================================================================
// TESTE 4B: EDIÇÃO ADMINISTRATIVA E PROTEÇÃO DE CONCORRÊNCIA DE CATÁLOGO (REVISION)
// ============================================================================
console.log('\n--- Teste 4B: Edição Administrativa, Incremento de Revision e Conflito Concorrente ---');
const catalogAdminId = '81000000-0000-4000-8000-000000000001';
await db.exec(`
insert into auth.users (id, is_anonymous) values ('${catalogAdminId}', false);
insert into public.restaurant_members (restaurant_id, user_id, role, active)
values ('${nomaId}', '${catalogAdminId}', 'admin', true);
`);

// Admin abre o produto (lê revision atual)
const [prodOpenByAdmin] = await q('select * from public.menu_products where id = $1', [activeProd1.id]);
const adminReadRevision = prodOpenByAdmin.revision;

// Enquanto o admin está com o formulário aberto, um cliente curte o produto
await db.exec(`
update public.product_like_events set created_at = clock_timestamp() - interval '5 seconds' where user_id = '${guest1}';
select set_config('request.jwt.claim.sub', '${guest1}', false);
`);
await q('select public.toggle_product_like($1, $2, $3)', [nomaSlug, activeProd1.id, true]);

// Admin salva edição legítima via save_menu_product usando adminReadRevision -> DEVE ter sucesso (sem falso conflito 40001)
await db.exec(`
set role authenticated;
select set_config('request.jwt.claim.sub', '${catalogAdminId}', false);
select set_config('request.jwt.claims', '{"sub":"${catalogAdminId}","is_anonymous":false,"role":"authenticated"}', false);
`);
await q('select public.save_menu_product($1, $2, $3, $4)', [
  nomaSlug,
  activeProd1.id,
  adminReadRevision,
  {
    category_id: prodOpenByAdmin.category_id,
    name: prodOpenByAdmin.name,
    slug: prodOpenByAdmin.slug,
    short_description: 'Descrição Editada pelo Admin',
    description: prodOpenByAdmin.description,
    price_in_cents: prodOpenByAdmin.price_in_cents + 100,
    available: prodOpenByAdmin.available,
    featured: prodOpenByAdmin.featured,
    sort_order: prodOpenByAdmin.sort_order,
    dietary_information: prodOpenByAdmin.dietary_information,
  },
]);
await db.exec('reset role;');

const [prodAfterAdminSave] = await q('select revision, likes_count, price_in_cents from public.menu_products where id = $1', [activeProd1.id]);
assert.equal(prodAfterAdminSave.revision, adminReadRevision + 1, 'Edição administrativa legítima DEVE incrementar revision em +1');
assert.equal(prodAfterAdminSave.likes_count, 1, 'Edição administrativa preserva likes_count intacto');

// Outro admin tentando salvar com a revision antiga (adminReadRevision) DEVE falhar com conflito 40001
await db.exec(`
set role authenticated;
select set_config('request.jwt.claim.sub', '${catalogAdminId}', false);
select set_config('request.jwt.claims', '{"sub":"${catalogAdminId}","is_anonymous":false,"role":"authenticated"}', false);
`);
await assert.rejects(
  async () => {
    await q('select public.save_menu_product($1, $2, $3, $4)', [
      nomaSlug,
      activeProd1.id,
      adminReadRevision, // obsoleta!
      {
        category_id: prodOpenByAdmin.category_id,
        name: 'Edição Concorrente Obsoleta',
        slug: prodOpenByAdmin.slug,
        short_description: 'desc',
        description: prodOpenByAdmin.description,
        price_in_cents: prodOpenByAdmin.price_in_cents,
        available: true,
        featured: false,
        sort_order: prodOpenByAdmin.sort_order,
      },
    ]);
  },
  (err) => err.code === '40001' || /Este produto foi alterado/.test(err.message),
  'Proteção contra conflito real de edição concorrente do administrador permanece intacta'
);
await db.exec('reset role;');

// Operação combinada alterando campo administrativo e likes_count na mesma instrução SQL (após insert legítimo em product_likes)
await db.exec(`
insert into public.product_likes (restaurant_id, product_id, user_id)
values ('${nomaId}', '${activeProd1.id}', '${guest3}');
`);
// Agora product_likes tem 2 linhas (likes_count = 2 pelo trigger). Se removermos 1 sem trigger ou atualizarmos junto:
await db.exec(`
alter table public.product_likes disable trigger product_likes_counter_sync;
delete from public.product_likes where product_id = '${activeProd1.id}' and user_id = '${guest3}';
alter table public.product_likes enable trigger product_likes_counter_sync;
`);
const [revBeforeCombined] = await q('select revision from public.menu_products where id = $1', [activeProd1.id]);
// Atualizar simultaneamente short_description (administrativo) e likes_count (de 2 para 1, que é a verdade contábil atual)
await db.exec(`
update public.menu_products
set short_description = 'Atualização Combinada', likes_count = 1
where id = '${activeProd1.id}';
`);
const [revAfterCombined] = await q('select revision, likes_count from public.menu_products where id = $1', [activeProd1.id]);
assert.equal(revAfterCombined.revision, revBeforeCombined.revision + 1, 'Atualização combinada (campo administrativo + likes_count) DEVE incrementar revision');
assert.equal(revAfterCombined.likes_count, 1);

// Limpar curtida de activeProd1 para os próximos testes
await db.exec(`delete from public.product_likes where product_id = '${activeProd1.id}';`);
console.log('PASS: Controle de revisão do catálogo (isolamento de likes, incremento em edição real e conflito 40001) validado.');

// ============================================================================
// TESTE 5: RATE LIMITING GLOBAL MULTI-PRODUTO
// ============================================================================
console.log('\n--- Teste 5: Rate Limiting Global Multi-Produto ---');
await db.exec(`select set_config('request.jwt.claim.sub', '${guest2}', false)`);

for (let i = 0; i < 15; i++) {
  await db.exec(`
    insert into public.product_like_events (restaurant_id, product_id, user_id, action, created_at)
    values ('${nomaId}', '${activeProd1.id}', '${guest2}', 'like', clock_timestamp() - interval '10 seconds');
  `);
}

await assert.rejects(
  async () => {
    await q('select public.toggle_product_like($1, $2, $3)', [nomaSlug, activeProd2.id, true]);
  },
  (err) => err.code === '55000' || /Muitas interações/.test(err.message),
  'Limite de 15 ações por minuto bloqueia requisições em qualquer produto do restaurante'
);
console.log('PASS: Rate limit de 15 ações/minuto por sessão protege atomicamente todo o catálogo.');

// ============================================================================
// TESTE 6: CICLO DE VIDA COMPLETO DE SNAPSHOT NOVO (v2) E CONTRATO DE BACKUP
// ============================================================================
console.log('\n--- Teste 6: Restauração Completa de Snapshot Novo (v2), Contrato e Permissões de Backup ---');
const v2RestId = '77777777-2222-4222-8222-222222222222';
const v2BackupId = '88888888-2222-4222-8222-222222222222';
const v2SecondBackupId = '88888888-2222-4222-8222-999999999999';
const v2CatId = '66666666-2222-4222-8222-222222222222';
const v2ProdId = '55555555-2222-4222-8222-222222222222';

await db.exec(`
insert into storage.objects (bucket_id, name, metadata)
values
  ('restaurant-images', '${v2RestId}/cover.jpg', '{"size": 1024}'::jsonb),
  ('menu-images', '${v2RestId}/prod-v2.jpg', '{"size": 2048}'::jsonb);

insert into public.restaurants (id, slug, name, active, logo, cover)
values (
  '${v2RestId}',
  'restaurante-v2',
  'Restaurante V2',
  true,
  '{"id":"logo-1","url":"/images/logo-v2.png","alt":"Logo"}'::jsonb,
  '{"id":"cover-1","url":"https://cdn.example.com/storage/v1/object/public/restaurant-images/${v2RestId}/cover.jpg","storagePath":"${v2RestId}/cover.jpg","alt":"Cover"}'::jsonb
);

insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
values ('${v2CatId}', '${v2RestId}', 'cat-v2', 'Categoria V2', 'cat-v2', 1, true);

insert into public.menu_products (
  id, restaurant_id, category_id, catalog_key, slug, name, short_description, description,
  price_in_cents, available, featured, sort_order, images, video
)
values (
  '${v2ProdId}', '${v2RestId}', '${v2CatId}', 'prod-v2', 'prod-v2', 'Prato V2', 'desc', 'desc',
  3500, true, false, 1,
  '[{"id":"img-1","url":"https://cdn.example.com/storage/v1/object/public/menu-images/${v2RestId}/prod-v2.jpg","storagePath":"${v2RestId}/prod-v2.jpg","alt":"Prato"}]'::jsonb,
  '{"id":"vid-1","url":"/videos/prato-v2.mp4"}'::jsonb
);
`);

// Adicionar 2 curtidas reais no Prato V2 (guest1 e guest3)
await db.exec(`select set_config('request.jwt.claim.sub', '${guest1}', false);`);
await q('select public.toggle_product_like($1, $2, $3)', ['restaurante-v2', v2ProdId, true]);
await db.exec(`select set_config('request.jwt.claim.sub', '${guest3}', false);`);
await q('select public.toggle_product_like($1, $2, $3)', ['restaurante-v2', v2ProdId, true]);

const [v2ProdBefore] = await q('select likes_count from public.menu_products where id = $1', [v2ProdId]);
assert.equal(v2ProdBefore.likes_count, 2, 'Prato V2 deve ter 2 curtidas antes do backup');

// Arquivar restaurante v2
await db.exec(`update public.restaurants set active = false, archived_at = now() where id = '${v2RestId}';`);

// 6.1 Verificar permissões de create_platform_backup_snapshot sob role authenticated:
// Usuário autenticado comum (não platform_admin) é bloqueado por require_platform_admin()
await db.exec(`
set role authenticated;
select set_config('request.jwt.claim.sub', '${catalogAdminId}', false);
select set_config('request.jwt.claims', '{"sub":"${catalogAdminId}","is_anonymous":false,"role":"authenticated"}', false);
`);
await assert.rejects(
  async () => { await q('select public.create_platform_backup_snapshot($1, $2)', [v2RestId, v2BackupId]); },
  (err) => err.code === '42501' || /Acesso exclusivo da administração da Elozi/.test(err.message),
  'authenticated não-admin da plataforma não pode criar backup snapshot'
);

// 6.2 Platform admin autenticado cria snapshot sob role authenticated e recebe campos originais de retorno
await db.exec(`
select set_config('request.jwt.claim.sub', '${adminUser}', false);
select set_config('request.jwt.claims', '{"sub":"${adminUser}","is_anonymous":false,"role":"authenticated"}', false);
`);
const [snapCreated] = await q('select public.create_platform_backup_snapshot($1, $2) as res', [v2RestId, v2BackupId]);
assert.equal(snapCreated.res.id, v2BackupId);
assert.equal(snapCreated.res.status, 'snapshot_created');
assert.equal(snapCreated.res.restaurantId, v2RestId);
assert.ok(snapCreated.res.createdAt, 'Deve retornar createdAt');
assert.equal(snapCreated.res.storageObjectCount, 2, 'Deve retornar storageObjectCount = 2');
assert.equal(snapCreated.res.mediaReferenceCount, 4, 'Deve retornar mediaReferenceCount = 4');

// 6.3 Repetição idempotente com o mesmo backup_id retorna { id, status, restaurantId, createdAt }
const [snapIdempotent] = await q('select public.create_platform_backup_snapshot($1, $2) as res', [v2RestId, v2BackupId]);
assert.equal(snapIdempotent.res.id, v2BackupId);
assert.equal(snapIdempotent.res.status, 'snapshot_created');
assert.equal(snapIdempotent.res.restaurantId, v2RestId);
assert.ok(snapIdempotent.res.createdAt, 'Repetição idempotente deve retornar createdAt');

// 6.4 Rejeição de um segundo snapshot em preparação (status = 'snapshot_created') para o mesmo restaurante
await assert.rejects(
  async () => { await q('select public.create_platform_backup_snapshot($1, $2)', [v2RestId, v2SecondBackupId]); },
  (err) => err.code === '55000' || /já possui uma cópia em preparação/.test(err.message),
  'Deve rejeitar segundo snapshot em preparação para o mesmo restaurante'
);
await db.exec('reset role;');

const [v2BackupMeta] = await q(
  'select format_version, snapshot->>\'version\' as snap_ver, media_references, snapshot from public.platform_restaurant_backups where id = $1',
  [v2BackupId]
);
assert.ok([4, 5].includes(Number(v2BackupMeta.format_version)), 'format_version do novo backup gerado deve ser 4 ou 5');
assert.ok(['4', '5'].includes(String(v2BackupMeta.snap_ver)), 'version no JSON do novo backup gerado deve ser 4 ou 5');
assert.equal(v2BackupMeta.media_references.length, 4, 'media_references deve conter as 4 mídias registradas');
assert.ok(
  v2BackupMeta.media_references.every((ref) => ref.kind && ref.ownerId && ref.media),
  'media_references deve preservar o contrato exato { kind, ownerId, media }'
);

// Validar compatibilidade de media_references com prepare_platform_backup_files
const [prepFiles] = await q('select public.prepare_platform_backup_files($1) as res', [v2BackupId]);
assert.equal(prepFiles.res, 4, 'prepare_platform_backup_files deve inicializar os 4 arquivos de mídia (2 storage + 2 local) sem erro');

// Converter para fixture histórica v2 legítima (19 tabelas, com likes_count e sem product_comments/comments_count)
const v2HistoricalSnapshot = structuredClone(v2BackupMeta.snapshot);
v2HistoricalSnapshot.version = 2;
delete v2HistoricalSnapshot.tables.product_comments;
delete v2HistoricalSnapshot.tables.restaurant_comment_restricted_terms;
delete v2HistoricalSnapshot.tables.product_comment_likes;
for (const prod of v2HistoricalSnapshot.tables.menu_products) {
  delete prod.comments_count;
}

// Limpar platform_backup_files temporários para seguir com o teste focado em DB snapshot/recovery v2
await q(
  `delete from public.platform_backup_files where backup_id = $1`,
  [v2BackupId]
);
await q(
  `update public.platform_restaurant_backups
   set format_version = 2,
       snapshot = $1,
       status = 'ready',
       files_initialized_at = now(),
       completed_at = now(),
       snapshot_sha256 = repeat('a', 64),
       manifest_sha256 = repeat('b', 64)
   where id = $2`,
  [v2HistoricalSnapshot, v2BackupId]
);

// Excluir o restaurante v2
const v2DelId = '33333333-2222-4222-8222-222222222222';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v2DelId}', '${v2RestId}', 'Restaurante V2', 'restaurante-v2', '${v2BackupId}', '${adminUser}', 'Exclusão V2', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v2DelId}', 'snapshot'),
  ('${v2DelId}', 'manifest');
`);
await q('select public.delete_platform_restaurant_data($1, $2)', [v2DelId, adminUser]);
await db.exec(`
delete from storage.objects where name like '${v2RestId}/%';
update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v2DelId}';
`);

// Remover guest3 do auth.users para comprovar que a recuperação v2 funciona mesmo com identidades anônimas ausentes
await db.exec(`delete from auth.users where id = '${guest3}';`);

// Executar recuperação completa v2
const [v2RecRes] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [v2BackupId, adminUser]);
assert.equal(v2RecRes.res.recovered, true);
assert.equal(v2RecRes.res.tableCount, 19);

// Conferir que o produto recuperado mantém likes_count = 2 e os 2 registros em product_likes
const [v2ProdAfter] = await q('select likes_count, comments_count from public.menu_products where id = $1', [v2ProdId]);
assert.equal(v2ProdAfter.likes_count, 2, 'Prato V2 recuperado deve preservar likes_count = 2');
assert.equal(v2ProdAfter.comments_count, 0, 'Prato V2 recuperado de backup v2 deve inicializar comments_count = 0');
const [v2LikesAfter] = await q('select count(*) as c from public.product_likes where product_id = $1', [v2ProdId]);
assert.equal(Number(v2LikesAfter.c), 2, 'Os 2 registros históricos de product_likes foram preservados');
console.log('PASS: Backup v2 com curtidas reais (e identidade anônima ausente) e media_references restaurado e reconciliado com perfeição.');

// ============================================================================
// TESTE 7: RESTAURAÇÃO COMPLETA DE BACKUP LEGADO (v1 - Com e Sem Produtos)
// ============================================================================
console.log('\n--- Teste 7: Restauração Completa de Backups Legados (v1) Com e Sem Produtos ---');
const v1RestId = '77777777-1111-4111-8111-111111111111';
const v1BackupId = '88888888-1111-4111-8111-111111111111';
const v1CatId = '66666666-1111-4111-8111-111111111111';
const v1Prod1 = '55555555-1111-4111-8111-111111111111';
const v1Prod2 = '55555555-1111-4111-8111-222222222222';

await db.exec(`
insert into public.restaurants (id, slug, name, active, archived_at)
values ('${v1RestId}', 'restaurante-v1', 'Restaurante V1', false, now());

insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
values ('${v1CatId}', '${v1RestId}', 'cat-v1', 'Categoria V1', 'cat-v1', 1, true);

insert into public.menu_products (id, restaurant_id, category_id, catalog_key, slug, name, short_description, description, price_in_cents, available, featured, sort_order)
values
  ('${v1Prod1}', '${v1RestId}', '${v1CatId}', 'prod-v1-a', 'prod-v1-a', 'Prato V1 A', 'desc', 'desc', 2000, true, false, 1),
  ('${v1Prod2}', '${v1RestId}', '${v1CatId}', 'prod-v1-b', 'prod-v1-b', 'Prato V1 B', 'desc', 'desc', 2500, true, false, 2);
`);

await q('select public.create_platform_backup_snapshot($1, $2)', [v1RestId, v1BackupId]);
await db.exec(`
update public.platform_restaurant_backups
set status = 'ready',
    files_initialized_at = now(),
    completed_at = now(),
    snapshot_sha256 = repeat('a', 64),
    manifest_sha256 = repeat('b', 64)
where id = '${v1BackupId}';
`);

// Construir fixture histórica v2 e v1 legítimas a partir do snapshot v4 recém-capturado
const [v1SnapRow] = await q('select snapshot from public.platform_restaurant_backups where id = $1', [v1BackupId]);
const baseV2Snapshot = structuredClone(v1SnapRow.snapshot);
baseV2Snapshot.version = 2;
delete baseV2Snapshot.tables.product_comments;
delete baseV2Snapshot.tables.restaurant_comment_restricted_terms;
delete baseV2Snapshot.tables.product_comment_likes;
for (const prod of baseV2Snapshot.tables.menu_products) {
  delete prod.comments_count;
}

const v1Snapshot = structuredClone(baseV2Snapshot);
v1Snapshot.version = 1;
delete v1Snapshot.tables.product_likes;
delete v1Snapshot.tables.product_like_events;
for (const prod of v1Snapshot.tables.menu_products) {
  delete prod.likes_count;
}
await q(`update public.platform_restaurant_backups set format_version = 1, snapshot = $1 where id = $2;`, [v1Snapshot, v1BackupId]);

// Excluir restaurante usando o backup v1 (também valida check_platform_deletion_backup para v1!)
const v1DelId = '33333333-1111-4111-8111-111111111111';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v1DelId}', '${v1RestId}', 'Restaurante V1', 'restaurante-v1', '${v1BackupId}', '${adminUser}', 'Exclusão V1', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v1DelId}', 'snapshot'),
  ('${v1DelId}', 'manifest');
`);
await q('select public.delete_platform_restaurant_data($1, $2)', [v1DelId, adminUser]);
await db.exec(`update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v1DelId}';`);

// Recuperar do backup v1 com múltiplos produtos
const [v1RecRes] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [v1BackupId, adminUser]);
assert.equal(v1RecRes.res.recovered, true);
assert.equal(v1RecRes.res.tableCount, 17);

const v1RestoredProds = await q('select id, likes_count, comments_count from public.menu_products where restaurant_id = $1', [v1RestId]);
assert.equal(v1RestoredProds.length, 2, 'Ambos os produtos legados restaurados');
assert.ok(v1RestoredProds.every(p => p.likes_count === 0 && p.comments_count === 0), 'Todos os produtos legados receberam likes_count = 0 e comments_count = 0');

// Testar staging de backup v1 SEM PRODUTOS
const v1EmptyProdsSnap = structuredClone(v1Snapshot);
v1EmptyProdsSnap.tables.menu_products = [];
await q(`update public.platform_restaurant_backups set snapshot = $1 where id = $2;`, [v1EmptyProdsSnap, v1BackupId]);
const [v1EmptyStage] = await q('select public.stage_platform_backup_recovery($1) as res', [v1BackupId]);
assert.equal(v1EmptyStage.res.tableCount, 17);
console.log('PASS: Backups legados v1 (com múltiplos produtos e sem produtos) validados e restaurados com sucesso.');

// ============================================================================
// TESTE 8: REJEIÇÃO DE SNAPSHOT ADULTERADO (v2 sem tabelas ou sem likes_count)
// ============================================================================
console.log('\n--- Teste 8: Rejeição de Snapshots (v2) Adulterados ---');
const tamperedId = '44444444-4444-4444-8444-444444444444';

// 8.1 Snapshot v2 que teve product_likes removida para tentar se passar por legado
const tamperedV2Snap = structuredClone(baseV2Snapshot);
delete tamperedV2Snap.tables.product_likes;

await db.exec(`
insert into public.platform_restaurant_backups (
  id, source_restaurant_id, source_name, source_slug, format_version, status, snapshot,
  files_initialized_at, completed_at, snapshot_sha256, manifest_sha256, storage_inventory, media_references
) values (
  '${tamperedId}', '${v1RestId}', 'Tampered V2', 'tampered-v2', 2, 'ready', '${JSON.stringify(tamperedV2Snap)}'::jsonb,
  now(), now(), repeat('c', 64), repeat('d', 64), '[]'::jsonb, '[]'::jsonb
);
`);

await assert.rejects(
  async () => { await q('select public.stage_platform_backup_recovery($1)', [tamperedId]); },
  /Tabela ausente no snapshot: product_likes/,
  'Snapshot v2 sem product_likes NÃO pode ser classificado como v1 e deve ser rejeitado'
);

// 8.2 Snapshot v2 com todas as tabelas, mas onde o 2º produto omitiu likes_count
const tamperedProdV2Snap = structuredClone(baseV2Snapshot);
delete tamperedProdV2Snap.tables.menu_products[1].likes_count;
await q(`update public.platform_restaurant_backups set snapshot = $1 where id = $2`, [tamperedProdV2Snap, tamperedId]);

await assert.rejects(
  async () => { await q('select public.stage_platform_backup_recovery($1)', [tamperedId]); },
  /Colunas incompatíveis em menu_products/,
  'Snapshot v2 onde um produto omitiu likes_count deve ser rejeitado'
);

console.log('PASS: Snapshots v2 adulterados são rigorosamente bloqueados pelo versionamento explícito.');

// ============================================================================
// TESTE 9: SERIALIZAÇÃO POR PRODUTO E CONCORRÊNCIA DE MÚLTIPLOS USUÁRIOS
// ============================================================================
console.log('\n--- Teste 9: Serialização por Produto (Locks Transacionais e Disparo Paralelo) ---');
const concUserA = '91000000-0000-4000-8000-000000000001';
const concUserB = '91000000-0000-4000-8000-000000000002';
const concUserC = '91000000-0000-4000-8000-000000000003';
const concProd = products[2];

await db.exec(`
insert into auth.users (id, is_anonymous) values
  ('${concUserA}', true),
  ('${concUserB}', true),
  ('${concUserC}', true);
`);

// 9.1 Verificar que toggle_product_like adquire RowExclusiveLock (FOR NO KEY UPDATE) em menu_products
// e 2 advisory locks transacionais (user+product e user+restaurant) dentro da mesma transação
await db.exec('begin;');
await db.exec(`select set_config('request.jwt.claim.sub', '${concUserA}', true);`);
await q('select public.toggle_product_like($1, $2, $3)', [nomaSlug, concProd.id, true]);

const locksHeld = await q(`
  select locktype, mode, granted
  from pg_locks
  where pid = pg_backend_pid()
    and (
      locktype = 'advisory'
      or (locktype = 'relation' and relation = 'public.menu_products'::regclass and mode = 'RowExclusiveLock')
    )
`);
const advisoryCount = locksHeld.filter((l) => l.locktype === 'advisory' && l.granted).length;
const hasMenuProductsRowLock = locksHeld.some((l) => l.locktype === 'relation' && l.mode === 'RowExclusiveLock' && l.granted);
assert.ok(advisoryCount >= 2, 'Deve reter os 2 advisory locks transacionais (user+product e user+restaurant)');
assert.equal(hasMenuProductsRowLock, true, 'Deve reter RowExclusiveLock em menu_products durante a transação');
await db.exec('commit;');

// 9.2 Disparo concorrente via Promise.all na fila do driver PGlite para múltiplos usuários distintos no mesmo produto
await Promise.all([
  db.exec(`select set_config('request.jwt.claim.sub', '${concUserB}', false); select public.toggle_product_like('${nomaSlug}', '${concProd.id}', true);`),
  db.exec(`select set_config('request.jwt.claim.sub', '${concUserC}', false); select public.toggle_product_like('${nomaSlug}', '${concProd.id}', true);`),
]);

const [concProdAfter] = await q('select likes_count from public.menu_products where id = $1', [concProd.id]);
const [concLikesRows] = await q('select count(*)::int as c from public.product_likes where product_id = $1', [concProd.id]);
assert.equal(concProdAfter.likes_count, 3, 'Contador materializado deve refletir exatamente as 3 curtidas');
assert.equal(concLikesRows.c, 3, 'Tabela product_likes deve conter exatamente 3 linhas');
console.log('PASS: Serialização por produto e consistência de contagem com múltiplos usuários validadas.');

console.log('\n========================================================================');
console.log('TODOS OS TESTES FINAIS DO BLOCO 6.1 FORAM APROVADOS COM SUCESSO!');
console.log('========================================================================\n');

await db.close();
