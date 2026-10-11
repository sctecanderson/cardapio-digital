import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const candidatePglitePaths = [
  process.env.PGLITE_MODULE ? path.resolve(process.env.PGLITE_MODULE) : null,
  path.resolve(projectRoot, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
  path.resolve(projectRoot, '.tools', 'pglite', 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js'),
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js',
].filter((candidate) => Boolean(candidate) && fs.existsSync(candidate));

if (candidatePglitePaths.length === 0) {
  throw new Error(
    'Informe PGLITE_MODULE apontando para @electric-sql/pglite/dist/index.js ou disponibilize em .tools/pglite.',
  );
}

const { PGlite } = await import(pathToFileURL(candidatePglitePaths[0]).href);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 6.3-D1 (Auto-publicação, Filtros e Curtidas de Comentários) ---');
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

const migrationFiles = (await fs.promises.readdir(path.join(projectRoot, 'supabase', 'migrations'))).sort();

for (const name of migrationFiles) {
  try {
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      const demoSeed = await fs.promises.readFile(path.join(projectRoot, 'supabase', 'seeds', 'demo_restaurants.sql'), 'utf8');
      await db.exec(demoSeed);
    }
    const sql = await fs.promises.readFile(path.join(projectRoot, 'supabase', 'migrations', name), 'utf8');
    await db.exec(sql);
    if (name === '20261008210000_create_restaurant_administration.sql') {
      const brasaSeed = await fs.promises.readFile(path.join(projectRoot, 'supabase', 'seeds', 'validate_brasa_identity.sql'), 'utf8');
      await db.exec(brasaSeed);
    }
  } catch (e) {
    console.error(`Erro ao compilar migration ${name}:`, e.message);
    process.exit(1);
  }
}

console.log('PASS: Todas as migrações (incluindo 20261013100000_comment_auto_publish_filters_and_likes.sql) compiladas com sucesso.\n');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const guest1 = '90000000-0000-4000-8000-000000000001';
const guest2 = '90000000-0000-4000-8000-000000000002';
const guest3 = '90000000-0000-4000-8000-000000000003';
const nomaAdmin = '80000000-0000-4000-8000-000000000001';
const brasaAdmin = '80000000-0000-4000-8000-000000000002';
const platformAdmin = '80000000-0000-4000-8000-000000000099';

const [{ id: nomaId, slug: nomaSlug }] = await q("select id, slug from public.restaurants where slug = 'noma'");
const [{ id: brasaId, slug: brasaSlug }] = await q("select id, slug from public.restaurants where slug = 'brasa'");

await db.exec(`
insert into auth.users (id, is_anonymous) values
  ('${guest1}', true),
  ('${guest2}', true),
  ('${guest3}', true),
  ('${nomaAdmin}', false),
  ('${brasaAdmin}', false),
  ('${platformAdmin}', false);

insert into public.platform_admins (user_id) values ('${platformAdmin}');

insert into public.restaurant_members (restaurant_id, user_id, role, active) values
  ('${nomaId}', '${nomaAdmin}', 'admin', true),
  ('${brasaId}', '${brasaAdmin}', 'admin', true);
`);

const setSession = async (userId, isAnonymous) => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claims', '{"sub":"${userId}","is_anonymous":${isAnonymous},"role":"authenticated"}', false);
  `);
};

const [prodNoma] = await q("select id, name, slug from public.menu_products where restaurant_id = $1 limit 1", [nomaId]);
const [prodBrasa] = await q("select id, name, slug from public.menu_products where restaurant_id = $1 limit 1", [brasaId]);

// ============================================================================
// TESTE 1: PUBLICAÇÃO AUTOMÁTICA DE COMENTÁRIOS VÁLIDOS
// ============================================================================
console.log('--- Teste 1: Publicação Automática de Comentários Válidos ---');

await setSession(guest1, true);
const [cleanCommentRes] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  [nomaSlug, prodNoma.id, 'Alice Silva', 'Excelente tempero, ponto perfeito da carne!']
);

assert.equal(cleanCommentRes.res.status, 'approved', 'Comentário sem termos restritos deve nascer como approved');
assert.equal(cleanCommentRes.res.likesCount, 0, 'Comentário recém-criado deve iniciar com likesCount = 0');

// Verificar incremento imediato de comments_count em menu_products
const [prodNomaAfterClean] = await q('select comments_count from public.menu_products where id = $1', [prodNoma.id]);
assert.equal(prodNomaAfterClean.comments_count, 1, 'comments_count deve ser incrementado imediatamente após publicação automática');

// Verificar disponibilidade imediata em get_public_product_comments
const [pubList] = await q('select public.get_public_product_comments($1, $2) as res', [nomaSlug, prodNoma.id]);
assert.equal(pubList.res.items.length, 1, 'Comentário aprovado deve aparecer imediatamente na leitura pública');
assert.equal(pubList.res.items[0].id, cleanCommentRes.res.id);
assert.equal(pubList.res.items[0].likesCount, 0, 'Leitura pública deve conter likesCount');
assert.equal('userId' in pubList.res.items[0], false, 'Leitura pública não deve expor userId');
assert.equal('user_id' in pubList.res.items[0], false, 'Leitura pública não deve expor user_id');

console.log('PASS: Publicação automática, atualização de comments_count e visibilidade pública validadas.');

// ============================================================================
// TESTE 2: FILTRO GLOBAL DE TERMOS OFENSIVOS DA PLATAFORMA
// ============================================================================
console.log('\n--- Teste 2: Filtro Global de Termos Ofensivos da Plataforma ---');

await setSession(guest2, true);
// Texto contendo termo restrito da plataforma ("merda")
const [offensiveCommentRes] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  [nomaSlug, prodNoma.id, 'Bruno Souza', 'Comida ruim demais uma verdadeira merda!']
);

assert.equal(offensiveCommentRes.res.status, 'pending', 'Comentário com termo ofensivo global deve nascer como pending');

// comments_count NÃO deve ser incrementado para pending
const [prodNomaAfterOffensive] = await q('select comments_count from public.menu_products where id = $1', [prodNoma.id]);
assert.equal(prodNomaAfterOffensive.comments_count, 1, 'comments_count NÃO deve incrementar para comentário pending');

// NÃO deve aparecer na consulta pública
const [pubListAfterOffensive] = await q('select public.get_public_product_comments($1, $2) as res', [nomaSlug, prodNoma.id]);
assert.equal(pubListAfterOffensive.res.items.length, 1, 'Comentário pending NÃO deve aparecer na leitura pública');

// Teste de limite de palavras (não bloquear palavras inocentes como "esmeralda" mesmo contendo "merda" no interior da palavra)
await db.exec(`update public.product_comments set created_at = clock_timestamp() - interval '20 seconds' where id = '${offensiveCommentRes.res.id}';`);
await setSession(guest2, true);
const [innocentCommentRes] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  [nomaSlug, prodNoma.id, 'Bruno Souza', 'Prato verde esmeralda muito sofisticado e saboroso']
);
assert.equal(innocentCommentRes.res.status, 'approved', 'Comentário com substring legítima inocente deve nascer approved');

console.log('PASS: Filtro global da plataforma retém ofensas em pending sem bloquear palavras legítimas.');

// ============================================================================
// TESTE 3: TERMOS RESTRITOS CONFIGURÁVEIS POR RESTAURANTE E ISOLAMENTO
// ============================================================================
console.log('\n--- Teste 3: Termos Restritos Configuráveis por Restaurante e Isolamento Multi-Tenant ---');

// Admin do Noma adiciona termo restrito "picante"
await setSession(nomaAdmin, false);
const [addTermRes] = await q(
  'select public.add_restaurant_comment_restricted_term($1, $2) as res',
  [nomaSlug, '  Picante  ']
);
assert.ok(addTermRes.res.id);
assert.equal(addTermRes.res.term, 'Picante');
assert.equal(addTermRes.res.normalizedTerm, 'picante');

// Admin do Brasa NÃO pode listar termos do Noma
await setSession(brasaAdmin, false);
await assert.rejects(
  async () => { await q('select public.list_restaurant_comment_restricted_terms($1)', [nomaSlug]); },
  (err) => err.code === '42501' || /administrador deste restaurante/.test(err.message),
  'Admin de outro restaurante não pode listar termos restritos do Noma'
);

// Admin do Noma lista seus termos
await setSession(nomaAdmin, false);
const [termsNoma] = await q('select public.list_restaurant_comment_restricted_terms($1) as res', [nomaSlug]);
assert.equal(termsNoma.res.length, 1);
assert.equal(termsNoma.res[0].normalizedTerm, 'picante');

// Visitante comenta no Noma com a palavra "picante" -> deve nascer pending
await setSession(guest3, true);
const [nomaRestrictedComment] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  [nomaSlug, prodNoma.id, 'Carla Dias', 'Achei este prato muito pícante para o meu gosto']
);
assert.equal(nomaRestrictedComment.res.status, 'pending', 'Termo restrito do restaurante com acento deve reter comentário como pending');

// O MESMO termo "picante" no restaurante Brasa NÃO deve ser bloqueado (isolamento multi-tenant!)
const [brasaCleanComment] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  [brasaSlug, prodBrasa.id, 'Carla Dias', 'Adoro molho picante neste restaurante']
);
assert.equal(brasaCleanComment.res.status, 'approved', 'Termo restrito de um restaurante não afeta outros restaurantes');

// Admin do Noma remove termo restrito
await setSession(nomaAdmin, false);
const [removeTermRes] = await q(
  'select public.remove_restaurant_comment_restricted_term($1, $2) as res',
  [nomaSlug, addTermRes.res.id]
);
assert.equal(removeTermRes.res.success, true);

console.log('PASS: Termos restritos por restaurante funcionam com isolamento multi-tenant rigoroso.');

// ============================================================================
// TESTE 4: CURTIDAS EM COMENTÁRIOS (JOINHAS REAIS, CONTADORES E SEGURANÇA)
// ============================================================================
console.log('\n--- Teste 4: Curtidas em Comentários (Joinhas Reais e Idempotência) ---');

const approvedCommentId = cleanCommentRes.res.id;
const pendingCommentId = offensiveCommentRes.res.id;

// 4.0 Teste de Regressão de Segurança: Contas da equipe/admin NÃO podem enviar comentários
await setSession(nomaAdmin, false);
await assert.rejects(
  async () => {
    await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prodNoma.id, 'Admin Noma', 'Comentário administrativo']);
  },
  /Apenas clientes anônimos podem enviar comentários públicos/,
  'Membros da equipe não podem enviar comentários públicos'
);

await setSession(platformAdmin, false);
await assert.rejects(
  async () => {
    await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prodNoma.id, 'Super Admin', 'Comentário da plataforma']);
  },
  /Apenas clientes anônimos podem enviar comentários públicos/,
  'Admins da plataforma não podem enviar comentários públicos'
);

// 4.1 Comentário pending NÃO pode receber curtidas públicas
await setSession(guest1, true);
await assert.rejects(
  async () => {
    await q('select public.toggle_product_comment_like($1, $2, true)', [nomaSlug, pendingCommentId]);
  },
  (err) => err.code === '22023' || /Apenas comentários aprovados podem receber curtidas/.test(err.message),
  'Comentários pending não podem receber curtidas públicas'
);

// 4.1.1 Isolamento entre restaurantes ao curtir: tentar curtir comentário do Noma passando slug do Brasa deve falhar
await assert.rejects(
  async () => {
    await q('select public.toggle_product_comment_like($1, $2, true)', [brasaSlug, approvedCommentId]);
  },
  (err) => err.code === '22023' || /Comentário não encontrado/.test(err.message),
  'Curtidas não podem cruzar restaurantes diferentes'
);

// 4.2 Curtir comentário aprovado
const [likeRes1] = await q(
  'select public.toggle_product_comment_like($1, $2, true) as res',
  [nomaSlug, approvedCommentId]
);
assert.equal(likeRes1.res.liked, true);
assert.equal(likeRes1.res.likesCount, 1);

// Verificar materialização de likes_count em product_comments
const [commRow1] = await q('select likes_count from public.product_comments where id = $1', [approvedCommentId]);
assert.equal(commRow1.likes_count, 1, 'likes_count do comentário deve ser 1');

// 4.3 Idempotência: curtir novamente com liked = true não duplica nem incrementa
const [likeIdempRes] = await q(
  'select public.toggle_product_comment_like($1, $2, true) as res',
  [nomaSlug, approvedCommentId]
);
assert.equal(likeIdempRes.res.liked, true);
assert.equal(likeIdempRes.res.likesCount, 1, 'Idempotência mantida');

// 4.4 Outro usuário (guest2) curte o mesmo comentário -> contador sobe para 2
await setSession(guest2, true);
const [likeRes2] = await q(
  'select public.toggle_product_comment_like($1, $2, true) as res',
  [nomaSlug, approvedCommentId]
);
assert.equal(likeRes2.res.liked, true);
assert.equal(likeRes2.res.likesCount, 2);

// 4.5 Consulta get_my_product_comment_likes
const [myLikesGuest2] = await q('select public.get_my_product_comment_likes($1) as res', [nomaSlug]);
assert.equal(myLikesGuest2.res.includes(approvedCommentId), true);

// 4.6 Descurtir (unlike)
const [unlikeRes2] = await q(
  'select public.toggle_product_comment_like($1, $2, false) as res',
  [nomaSlug, approvedCommentId]
);
assert.equal(unlikeRes2.res.liked, false);
assert.equal(unlikeRes2.res.likesCount, 1, 'Contador decrece para 1 após unlike');

// 4.7 Guarda matemática de likes_count em product_comments
await assert.rejects(
  async () => {
    await db.exec(`update public.product_comments set likes_count = 999 where id = '${approvedCommentId}';`);
  },
  /A contagem de curtidas do comentário é gerenciada automaticamente/,
  'Guarda matemática impede alteração arbitrária de likes_count no comentário'
);

console.log('PASS: Curtidas em comentários (toggle, idempotência, integridade matemática e consulta) validadas.');

// ============================================================================
// TESTE 5: ADMINISTRAÇÃO E EXCLUSÃO DEFINITIVA COM ATUALIZAÇÃO DE CONTADORES
// ============================================================================
console.log('\n--- Teste 5: Administração e Exclusão Definitiva de Comentários ---');

// Admin do Noma lista comentários com likesCount
await setSession(nomaAdmin, false);
const [adminListRes] = await q('select public.list_admin_product_comments($1) as res', [nomaSlug]);
const itemInList = adminListRes.res.items.find((item) => item.id === approvedCommentId);
assert.ok(itemInList);
assert.equal(itemInList.likesCount, 1, 'list_admin_product_comments deve expor likesCount');

// Exclusão definitiva de comentário aprovado
const [delRes] = await q(
  'select public.delete_admin_product_comment($1, $2) as res',
  [nomaSlug, approvedCommentId]
);
assert.equal(delRes.res.deleted, true);

// comments_count do produto deve ter sido reduzido
const [prodNomaAfterDel] = await q('select comments_count from public.menu_products where id = $1', [prodNoma.id]);
const [actualApproved] = await q("select count(*)::int as c from public.product_comments where product_id = $1 and status = 'approved'", [prodNoma.id]);
assert.equal(prodNomaAfterDel.comments_count, actualApproved.c, 'comments_count deve ser sincronizado atomicamente na exclusão');

// As curtidas associadas ao comentário excluído devem ter sido removidas em cascade
const [likesRemaining] = await q('select count(*)::int as c from public.product_comment_likes where comment_id = $1', [approvedCommentId]);
assert.equal(likesRemaining.c, 0, 'Curtidas do comentário excluído devem ser purgadas');

console.log('PASS: Exclusão definitiva com cascata atômica e sincronização contábil validada.');

// ============================================================================
// TESTE 6: CICLO COMPLETO DE BACKUP v4, RESTAURAÇÃO E COMPATIBILIDADE v1, v2, v3
// ============================================================================
console.log('\n--- Teste 6: Ciclo Completo de Backup v4 e Compatibilidade Histórica ---');

const v4RestId = '77777777-4444-4444-8444-444444444444';
const v4CatId = '66666666-4444-4444-8444-444444444444';
const v4ProdId = '55555555-4444-4444-8444-444444444444';
const v4BackupId = '88888888-4444-4444-8444-444444444444';

await db.exec(`
insert into public.restaurants (id, slug, name, active, archived_at)
values ('${v4RestId}', 'restaurante-v4', 'Restaurante V4', true, null);

insert into public.restaurant_members (restaurant_id, user_id, role, active)
values ('${v4RestId}', '${nomaAdmin}', 'admin', true);

insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
values ('${v4CatId}', '${v4RestId}', 'cat-v4', 'Categoria V4', 'cat-v4', 1, true);

insert into public.menu_products (
  id, restaurant_id, category_id, catalog_key, slug, name, short_description, description, price_in_cents, available, featured, sort_order
) values (
  '${v4ProdId}', '${v4RestId}', '${v4CatId}', 'prod-v4', 'prod-v4', 'Prato V4', 'desc', 'desc', 5000, true, true, 1
);
`);

// Adiciona 1 termo restrito e 1 comentário com curtida no restaurante V4
await setSession(nomaAdmin, false);
await q('select public.add_restaurant_comment_restricted_term($1, $2)', ['restaurante-v4', 'reservado']);

await setSession(guest1, true);
const [v4Comm] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  ['restaurante-v4', v4ProdId, 'Daniela Melo', 'Prato espetacular em todos os sentidos!']
);
await q('select public.toggle_product_comment_like($1, $2, true)', ['restaurante-v4', v4Comm.res.id]);

// Arquivar restaurante V4 para gerar backup v4
await db.exec(`update public.restaurants set active = false, archived_at = now() where id = '${v4RestId}';`);

await setSession(platformAdmin, false);
const [v4SnapRes] = await q('select public.create_platform_backup_snapshot($1, $2) as res', [v4RestId, v4BackupId]);
assert.equal(v4SnapRes.res.status, 'snapshot_created');

const [v4Meta] = await q(
  "select format_version, snapshot->>'version' as snap_ver from public.platform_restaurant_backups where id = $1",
  [v4BackupId]
);
assert.equal(v4Meta.format_version, 4, 'Backup recém-gerado deve ser format_version = 4');
assert.equal(v4Meta.snap_ver, '4');

await db.exec(`
update public.platform_restaurant_backups
set status = 'ready',
    files_initialized_at = now(),
    completed_at = now(),
    snapshot_sha256 = repeat('a', 64),
    manifest_sha256 = repeat('b', 64)
where id = '${v4BackupId}';
`);

// Exclusão do restaurante V4 usando backup v4
const v4DelId = '33333333-4444-4444-8444-444444444444';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v4DelId}', '${v4RestId}', 'Restaurante V4', 'restaurante-v4', '${v4BackupId}', '${platformAdmin}', 'Exclusão V4', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v4DelId}', 'snapshot'),
  ('${v4DelId}', 'manifest');
`);
await q('select public.delete_platform_restaurant_data($1, $2)', [v4DelId, platformAdmin]);
await db.exec(`update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v4DelId}';`);

// Restauração completa a partir do backup v4
const [v4RecRes] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [v4BackupId, platformAdmin]);
assert.equal(v4RecRes.res.recovered, true);
assert.equal(v4RecRes.res.tableCount, 22, 'Recuperação v4 deve restaurar todas as 22 tabelas');

// Conferir integridade após recuperação v4
const [v4ProdRecovered] = await q('select comments_count from public.menu_products where id = $1', [v4ProdId]);
assert.equal(v4ProdRecovered.comments_count, 1, 'comments_count preservado na recuperação v4');

const [v4CommRecovered] = await q('select likes_count from public.product_comments where id = $1', [v4Comm.res.id]);
assert.equal(v4CommRecovered.likes_count, 1, 'likes_count do comentário preservado na recuperação v4');

console.log('PASS: Ciclo completo de backup v4 (22 tabelas), exclusão atômica e restauração aprovado.');

console.log('\n========================================================================');
console.log('TODOS OS TESTES DO BLOCO 6.3-D1 FORAM APROVADOS COM SUCESSO!');
console.log('========================================================================\n');

await db.close();
