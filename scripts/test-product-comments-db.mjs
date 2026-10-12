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

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 6.3-A (Comentários Reais) ---');
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
const nomaAdmin = '80000000-0000-4000-8000-000000000001';
const brasaAdmin = '80000000-0000-4000-8000-000000000002';
const nomaWaiter = '80000000-0000-4000-8000-000000000003';
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
  ('${nomaWaiter}', false),
  ('${platformAdmin}', false);

insert into public.platform_admins (user_id) values ('${platformAdmin}');

insert into public.restaurant_members (restaurant_id, user_id, role, active) values
  ('${nomaId}', '${nomaAdmin}', 'admin', true),
  ('${brasaId}', '${brasaAdmin}', 'admin', true),
  ('${nomaId}', '${nomaWaiter}', 'waiter', true);
`);

const setSession = async (userId, isAnonymous) => {
  if (!userId) {
    await db.exec(`
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claims', '{}', false);
    `);
    return;
  }
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claims', '{"sub":"${userId}","is_anonymous":${Boolean(isAnonymous)},"role":"authenticated"}', false);
  `);
};

const products = await q(
  'select id, name, available, likes_count, comments_count, category_id, revision from public.menu_products where restaurant_id = $1 order by sort_order',
  [nomaId],
);
const prod1 = products[0];
const prod2 = products[1];
const prod3 = products[2];

// ============================================================================
// TESTE 1: PERMISSÕES COM ROLES EFETIVAS (anon, authenticated, service_role)
// ============================================================================
console.log('--- Teste 1: Permissões com Roles Efetivas ---');

await db.exec('set role anon;');
await setSession(null, false);

await assert.rejects(
  async () => { await q('select * from public.product_comments'); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'anon não pode consultar product_comments diretamente',
);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Ana', 'Muito bom!']); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'anon não pode executar create_product_comment',
);

await assert.rejects(
  async () => { await q('select public.list_admin_product_comments($1)', [nomaSlug]); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'anon não pode executar list_admin_product_comments',
);

await assert.rejects(
  async () => { await q('select public.moderate_product_comment($1, $2, $3)', [nomaSlug, prod1.id, 'approved']); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'anon não pode executar moderate_product_comment',
);

await db.exec('set role authenticated;');
await setSession(guest1, true);

await assert.rejects(
  async () => { await q('select * from public.product_comments'); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'authenticated não pode consultar product_comments diretamente',
);

await assert.rejects(
  async () => { await q('select public.reconcile_restaurant_comments_count($1)', [nomaId]); },
  (err) => err.code === '42501' || /permission denied/.test(err.message),
  'authenticated não pode executar reconcile_restaurant_comments_count',
);

await assert.rejects(
  async () => {
    await db.exec(`update public.menu_products set comments_count = 100 where id = '${prod1.id}'`);
  },
  (err) => err.code === '42501' || /gerenciada automaticamente|permission denied/.test(err.message),
  'authenticated não pode alterar comments_count diretamente',
);

await db.exec('reset role;');
console.log('PASS: Roles anon e authenticated têm acesso direto revogado e protegido.');

// ============================================================================
// TESTE 2: GUARDA MATEMÁTICA EM comments_count
// ============================================================================
console.log('\n--- Teste 2: Guarda Matemática contra Alteração Arbitrária e Trigger Malicioso ---');

await assert.rejects(
  async () => {
    await db.exec(`update public.menu_products set comments_count = 42 where id = '${prod1.id}'`);
  },
  (err) => err.code === '42501' || /deve corresponder exatamente aos comentários aprovados/.test(err.message),
  'Tentativa direta de update arbitrário em comments_count deve ser bloqueada',
);

await db.exec(`
create or replace function public.test_malicious_comments_trigger_fn()
returns trigger language plpgsql as $$
begin
  update public.menu_products set comments_count = 99 where id = '${prod1.id}';
  return new;
end;
$$;

create trigger test_malicious_comments_trigger
  after update of subtitle on public.restaurants
  for each row execute function public.test_malicious_comments_trigger_fn();
`);

await assert.rejects(
  async () => {
    await db.exec(`update public.restaurants set subtitle = 'Subtitulo Teste' where id = '${nomaId}'`);
  },
  (err) => err.code === '42501' || /deve corresponder exatamente aos comentários aprovados/.test(err.message),
  'Trigger externo tentando fraudar comments_count deve ser bloqueado',
);

await db.exec(`
drop trigger test_malicious_comments_trigger on public.restaurants;
drop function public.test_malicious_comments_trigger_fn();
`);

console.log('PASS: Guarda matemática de comments_count inviolável.');

// ============================================================================
// TESTE 3: INTEGRIDADE MULTI-TENANT POR FK COMPOSTA
// ============================================================================
console.log('\n--- Teste 3: Isolamento Multi-Tenant por FK Composta ---');

await assert.rejects(
  async () => {
    await db.exec(`
      insert into public.product_comments (
        restaurant_id, product_id, user_id, author_name, body, content_fingerprint, status
      ) values (
        '${brasaId}', '${prod1.id}', '${guest1}', 'Cliente', 'Comentário cruzado', md5('comentario cruzado'), 'pending'
      );
    `);
  },
  (err) => err.code === '23503' || /product_comments_product_same_restaurant/.test(err.message),
  'FK composta deve impedir associar produto do Noma ao restaurante Brasa',
);

console.log('PASS: FK composta (product_id, restaurant_id) impede cruzamento entre restaurantes.');

// ============================================================================
// TESTE 4: CRIAÇÃO DE COMENTÁRIOS, IDENTIDADE ANÔNIMA E VALIDAÇÕES DE CONTEÚDO
// ============================================================================
console.log('\n--- Teste 4: Criação por Cliente Anônimo e Validação de Nome/Texto ---');

// 4.1 Sem sessão autenticada -> bloqueado
await setSession(null, false);
await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina', 'Prato incrível!']); },
  (err) => err.code === '42501' || /sessão de cliente/.test(err.message),
  'Sem sessão deve rejeitar create_product_comment',
);

// 4.2 Conta administrativa não-anônima -> bloqueada
await setSession(nomaAdmin, false);
await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Admin', 'Tentando comentar']); },
  (err) => err.code === '42501' || /Apenas clientes anônimos/.test(err.message),
  'Administrador não pode criar comentário público como cliente',
);

// 4.3 Conta de garçom -> bloqueada
await setSession(nomaWaiter, false);
await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Garçom', 'Tentando comentar']); },
  (err) => err.code === '42501' || /Apenas clientes anônimos/.test(err.message),
  'Membro da equipe não pode criar comentário público como cliente',
);

// 4.4 Validações de comprimento e caracteres de controle com cliente anônimo legítimo
await setSession(guest1, true);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'A', 'Comentário válido']); },
  (err) => err.code === '22023' || /2 a 40 caracteres/.test(err.message),
  'Nome com menos de 2 caracteres úteis deve falhar',
);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'A'.repeat(41), 'Comentário válido']); },
  (err) => err.code === '22023' || /2 a 40 caracteres/.test(err.message),
  'Nome com mais de 40 caracteres deve falhar',
);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina\nSilva', 'Comentário válido']); },
  (err) => err.code === '22023' || /caracteres válidos/.test(err.message),
  'Nome com quebra de linha/controle deve falhar',
);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina', 'Oi']); },
  (err) => err.code === '22023' || /3 e 280 caracteres/.test(err.message),
  'Comentário com menos de 3 caracteres deve falhar',
);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina', 'X'.repeat(281)]); },
  (err) => err.code === '22023' || /3 e 280 caracteres/.test(err.message),
  'Comentário com mais de 280 caracteres deve falhar',
);

await assert.rejects(
  async () => { await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina', 'Texto com controle \x07 invisível']); },
  (err) => err.code === '22023' || /caracteres inválidos/.test(err.message),
  'Comentário com caractere de controle invisível deve falhar',
);

// 4.5 Criação bem-sucedida: sem termos restritos, comentário nasce approved com publicação automática imediata
const [revBeforeComment] = await q('select revision, comments_count from public.menu_products where id = $1', [prod1.id]);
const [createdRes] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  [nomaSlug, prod1.id, '  Marina   Alves  ', '  Sabor   surpreendente e textura impecável!  '],
);

const comment1 = createdRes.res;
assert.ok(comment1.id, 'Deve retornar id do comentário');
assert.equal(comment1.productId, prod1.id);
assert.equal(comment1.authorName, 'Marina Alves', 'Deve normalizar espaços do nome');
assert.equal(comment1.body, 'Sabor surpreendente e textura impecável!', 'Deve normalizar espaços do comentário');
assert.equal(comment1.status, 'approved', 'Comentário válido sem termos restritos deve ser auto-publicado (approved)');
assert.equal('userId' in comment1, false, 'Não pode expor userId no retorno');
assert.equal('user_id' in comment1, false, 'Não pode expor user_id no retorno');

const [revAfterApproved] = await q('select revision, comments_count from public.menu_products where id = $1', [prod1.id]);
assert.equal(revAfterApproved.comments_count, 1, 'Comentário auto-publicado deve incrementar comments_count imediatamente');
assert.equal(revAfterApproved.revision, revBeforeComment.revision, 'Criar comentário não deve alterar revision');

console.log('PASS: Criação por cliente anônimo, auto-publicação e isolamento de identidade validados.');

// ============================================================================
// TESTE 5: PROTEÇÃO CONTRA SPAM, DUPLICATAS E PUBLICAÇÕES EXCESSIVAS
// ============================================================================
console.log('\n--- Teste 5: Proteção contra Spam, Duplicatas, Cooldown e Rate Limit ---');

// 5.1 Cooldown de 15 segundos no mesmo produto
await assert.rejects(
  async () => {
    await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina Alves', 'Outro comentário seguido']);
  },
  (err) => err.code === '55000' || /Aguarde alguns segundos/.test(err.message),
  'Cooldown de 15s deve bloquear envios consecutivos no mesmo produto',
);

// Retroceder created_at em 20 segundos para testar duplicata exata em 24h
await db.exec(`
  update public.product_comments
  set created_at = clock_timestamp() - interval '20 seconds'
  where id = '${comment1.id}';
`);

// 5.2 Duplicata normalizada (mesmo texto com caixa e espaços diferentes) em 24h
await assert.rejects(
  async () => {
    await q(
      'select public.create_product_comment($1, $2, $3, $4)',
      [nomaSlug, prod1.id, 'Marina Alves', '   sabor SURPREENDENTE   e textura impecável! '],
    );
  },
  (err) => err.code === '55000' || /já enviou este mesmo comentário/.test(err.message),
  'Fingerprint deve bloquear duplicata mesmo em outro produto ou com espaçamento diferente nas últimas 24h',
);

// 5.3 Limite de 3 comentários pendentes por usuário no mesmo produto
// Insere termo restrito no Noma para testar fila de moderação e limite de pendentes
await db.exec(`
  insert into public.restaurant_comment_restricted_terms (restaurant_id, term, normalized_term)
  values ('${nomaId}', 'pendente', 'pendente');
`);

const [c2Res] = await q('select public.create_product_comment($1, $2, $3, $4) as res', [nomaSlug, prod1.id, 'Marina Alves', 'Segundo comentário pendente neste prato']);
assert.equal(c2Res.res.status, 'pending', 'Comentário com termo restrito nasce como pending');
await db.exec(`update public.product_comments set created_at = clock_timestamp() - interval '20 seconds' where id = '${c2Res.res.id}';`);

const [c3Res] = await q('select public.create_product_comment($1, $2, $3, $4) as res', [nomaSlug, prod1.id, 'Marina Alves', 'Terceiro comentário pendente neste prato']);
assert.equal(c3Res.res.status, 'pending', 'Comentário com termo restrito nasce como pending');
await db.exec(`update public.product_comments set created_at = clock_timestamp() - interval '20 seconds' where id = '${c3Res.res.id}';`);

// Ajusta comment1 para status pending com termo restrito atualizado para testar limite e moderação
await db.exec(`update public.product_comments set status = 'pending', moderated_at = null, moderated_by = null where id = '${comment1.id}';`);

await assert.rejects(
  async () => {
    await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod1.id, 'Marina Alves', 'Quarto comentário pendente no mesmo prato']);
  },
  (err) => err.code === '55000' || /aguardando avaliação neste prato/.test(err.message),
  'Deve bloquear quando o usuário já possui 3 comentários pendentes no mesmo produto',
);

// 5.4 Rate limit global por janela no restaurante (máximo 5 comentários em 10 minutos)
const [c4Res] = await q('select public.create_product_comment($1, $2, $3, $4) as res', [nomaSlug, prod2.id, 'Marina Alves', 'Quarto comentário em outro prato pendente']);
await db.exec(`update public.product_comments set created_at = clock_timestamp() - interval '20 seconds' where id = '${c4Res.res.id}';`);

const [c5Res] = await q('select public.create_product_comment($1, $2, $3, $4) as res', [nomaSlug, prod3.id, 'Marina Alves', 'Quinto comentário na janela pendente']);
await db.exec(`update public.product_comments set created_at = clock_timestamp() - interval '20 seconds' where id = '${c5Res.res.id}';`);

await assert.rejects(
  async () => {
    await q('select public.create_product_comment($1, $2, $3, $4)', [nomaSlug, prod2.id, 'Marina Alves', 'Sexto comentário dentro de 10 minutos']);
  },
  (err) => err.code === '55000' || /Muitos comentários enviados em sequência/.test(err.message),
  'Rate limit de 5 comentários por 10 minutos no restaurante deve bloquear o 6º envio',
);

console.log('PASS: Cooldown, bloqueio de duplicatas, limite de pendentes e rate-limit por janela validados.');

// ============================================================================
// TESTE 6: MODERAÇÃO ADMINISTRATIVA, VISIBILIDADE PÚBLICA E PAGINAÇÃO POR CURSOR
// ============================================================================
console.log('\n--- Teste 6: Moderação Administrativa, Paginação por Cursor e Visibilidade Pública ---');

// 6.1 Leitura pública antes da aprovação retorna lista vazia (todos estão pending)
const [pubBefore] = await q('select public.get_public_product_comments($1, $2) as res', [nomaSlug, prod1.id]);
assert.equal(pubBefore.res.items.length, 0, 'Nenhum comentário pending pode aparecer publicamente');
assert.equal(pubBefore.res.hasMore, false);
assert.equal(pubBefore.res.nextCursor, null);

// 6.2 Admin de outro restaurante (Brasa) não pode listar nem moderar comentários do Noma
await setSession(brasaAdmin, false);
await assert.rejects(
  async () => { await q('select public.list_admin_product_comments($1)', [nomaSlug]); },
  (err) => err.code === '42501' || /administrador deste restaurante/.test(err.message),
  'Admin de outro restaurante não pode listar comentários do Noma',
);
await assert.rejects(
  async () => { await q('select public.moderate_product_comment($1, $2, $3)', [nomaSlug, comment1.id, 'approved']); },
  (err) => err.code === '42501' || /administrador deste restaurante/.test(err.message),
  'Admin de outro restaurante não pode moderar comentários do Noma',
);

// 6.3 Garçom do próprio restaurante não pode moderar comentários
await setSession(nomaWaiter, false);
await assert.rejects(
  async () => { await q('select public.moderate_product_comment($1, $2, $3)', [nomaSlug, comment1.id, 'approved']); },
  (err) => err.code === '42501' || /administrador deste restaurante/.test(err.message),
  'Garçom não pode moderar comentários',
);

// 6.4 Admin legítimo do Noma lista e modera comentários
await setSession(nomaAdmin, false);
const [adminListPending] = await q('select public.list_admin_product_comments($1, $2) as res', [nomaSlug, 'pending']);
assert.equal(adminListPending.res.counts.pending, 5);
assert.equal(adminListPending.res.counts.approved, 0);
assert.equal(adminListPending.res.items.length, 5);

const [revBeforeModeration] = await q('select revision from public.menu_products where id = $1', [prod1.id]);

// Aprovar os 3 comentários de prod1 com timestamps controlados para paginação determinística
await db.exec(`
  update public.product_comments set created_at = '2026-10-11T15:00:00Z' where id = '${comment1.id}';
  update public.product_comments set created_at = '2026-10-11T15:01:00Z' where id = '${c2Res.res.id}';
  update public.product_comments set created_at = '2026-10-11T15:02:00Z' where id = '${c3Res.res.id}';
`);

const [mod1] = await q('select public.moderate_product_comment($1, $2, $3) as res', [nomaSlug, comment1.id, 'approved']);
assert.equal(mod1.res.status, 'approved');
assert.equal(mod1.res.commentsCount, 1);

const [mod2] = await q('select public.moderate_product_comment($1, $2, $3) as res', [nomaSlug, c2Res.res.id, 'approved']);
assert.equal(mod2.res.commentsCount, 2);

const [mod3] = await q('select public.moderate_product_comment($1, $2, $3) as res', [nomaSlug, c3Res.res.id, 'approved']);
assert.equal(mod3.res.commentsCount, 3);

// Conferir que moderar comentários NÃO incrementou menu_products.revision
const [revAfterModeration] = await q('select revision, comments_count from public.menu_products where id = $1', [prod1.id]);
assert.equal(revAfterModeration.comments_count, 3);
assert.equal(revAfterModeration.revision, revBeforeModeration.revision, 'Moderar comentário NÃO deve incrementar revision do produto');

// Conferir que get_public_menu expõe commentsCount = 3
const [pubMenu] = await q('select public.get_public_menu($1) as menu', [nomaSlug]);
const menuProd1 = pubMenu.menu.products.find((p) => p.id === prod1.id);
assert.equal(menuProd1.commentsCount, 3, 'get_public_menu deve retornar commentsCount = 3');

// 6.5 Paginação pública por cursor (p_limit = 2)
await setSession(null, false);
const [page1] = await q(
  'select public.get_public_product_comments($1, $2, null, null, 2) as res',
  [nomaSlug, prod1.id],
);
assert.equal(page1.res.items.length, 2, 'Primeira página com limit 2 deve trazer 2 itens');
assert.equal(page1.res.items[0].id, c3Res.res.id, 'Mais recente primeiro');
assert.equal(page1.res.items[1].id, c2Res.res.id, 'Segundo mais recente depois');
assert.equal(page1.res.hasMore, true);
assert.ok(page1.res.nextCursor.createdAt);
assert.equal(page1.res.nextCursor.id, c2Res.res.id);

for (const item of page1.res.items) {
  assert.equal('user_id' in item, false, 'Nunca expor user_id na leitura pública');
  assert.equal('userId' in item, false, 'Nunca expor userId na leitura pública');
  assert.equal('moderated_by' in item, false, 'Nunca expor moderated_by na leitura pública');
  assert.equal('moderatedBy' in item, false, 'Nunca expor moderatedBy na leitura pública');
}

const [page2] = await q(
  'select public.get_public_product_comments($1, $2, $3::timestamptz, $4::uuid, 2) as res',
  [nomaSlug, prod1.id, page1.res.nextCursor.createdAt, page1.res.nextCursor.id],
);
assert.equal(page2.res.items.length, 1, 'Segunda página deve trazer o item restante');
assert.equal(page2.res.items[0].id, comment1.id);
assert.equal(page2.res.hasMore, false);
assert.equal(page2.res.nextCursor, null);

// Cursor incompleto deve ser rejeitado
await assert.rejects(
  async () => {
    await q('select public.get_public_product_comments($1, $2, now(), null, 10)', [nomaSlug, prod1.id]);
  },
  (err) => err.code === '22023' || /Cursor de paginação incompleto/.test(err.message),
  'Cursor incompleto deve falhar com erro 22023',
);

// 6.6 Ocultar (hidden) e Rejeitar (rejected) atualizam comments_count imediatamente
await setSession(nomaAdmin, false);
const [modHide] = await q('select public.moderate_product_comment($1, $2, $3) as res', [nomaSlug, c2Res.res.id, 'hidden']);
assert.equal(modHide.res.status, 'hidden');
assert.equal(modHide.res.commentsCount, 2, 'Ocultar comentário aprovado deve reduzir comments_count para 2');

const [modReject] = await q('select public.moderate_product_comment($1, $2, $3) as res', [nomaSlug, c3Res.res.id, 'rejected']);
assert.equal(modReject.res.status, 'rejected');
assert.equal(modReject.res.commentsCount, 1, 'Rejeitar comentário aprovado deve reduzir comments_count para 1');

const [pubAfterHide] = await q('select public.get_public_product_comments($1, $2) as res', [nomaSlug, prod1.id]);
assert.equal(pubAfterHide.res.items.length, 1, 'Apenas o comentário aprovado restante deve ser retornado');
assert.equal(pubAfterHide.res.items[0].id, comment1.id);

console.log('PASS: Moderação administrativa, paginação por cursor e atualização imediata de comments_count validadas.');

// ============================================================================
// TESTE 7: CONCORRÊNCIA E PREVENÇÃO DE DEADLOCK NA MODERAÇÃO E CONTADORES
// ============================================================================
console.log('\n--- Teste 7: Concorrência de Moderação e Criação sem Deadlock ---');

// 7.1 Verificar retenção de RowExclusiveLock em menu_products durante moderate_product_comment
await db.exec('begin;');
await setSession(nomaAdmin, false);
await q('select public.moderate_product_comment($1, $2, $3)', [nomaSlug, c4Res.res.id, 'approved']);

const modLocks = await q(`
  select locktype, mode, granted
  from pg_locks
  where pid = pg_backend_pid()
    and locktype = 'relation'
    and relation = 'public.menu_products'::regclass
    and mode = 'RowExclusiveLock'
`);
assert.equal(modLocks.some((l) => l.granted), true, 'moderate_product_comment deve reter RowExclusiveLock em menu_products');
await db.exec('commit;');

// 7.2 Disparo paralelo de moderações concorrentes no mesmo produto (prod1)
await Promise.all([
  db.exec(`
    select set_config('request.jwt.claim.sub', '${nomaAdmin}', false);
    select set_config('request.jwt.claims', '{"sub":"${nomaAdmin}","is_anonymous":false,"role":"authenticated"}', false);
    select public.moderate_product_comment('${nomaSlug}', '${c2Res.res.id}', 'approved');
  `),
  db.exec(`
    select set_config('request.jwt.claim.sub', '${nomaAdmin}', false);
    select set_config('request.jwt.claims', '{"sub":"${nomaAdmin}","is_anonymous":false,"role":"authenticated"}', false);
    select public.moderate_product_comment('${nomaSlug}', '${c3Res.res.id}', 'approved');
  `),
  db.exec(`
    select set_config('request.jwt.claim.sub', '${guest2}', false);
    select set_config('request.jwt.claims', '{"sub":"${guest2}","is_anonymous":true,"role":"authenticated"}', false);
    select public.create_product_comment('${nomaSlug}', '${prod1.id}', 'Carlos Eduardo', 'Excelente apresentação e aroma!');
  `),
]);

const [prod1AfterConc] = await q('select comments_count from public.menu_products where id = $1', [prod1.id]);
const [approvedRows] = await q(
  "select count(*)::int as c from public.product_comments where product_id = $1 and status = 'approved'",
  [prod1.id],
);
// prod1 agora tem 4 comentários aprovados (c2, c3 moderados + Carlos Eduardo auto-publicado + comment1 que foi moderado)
assert.equal(prod1AfterConc.comments_count, approvedRows.c);
assert.equal(approvedRows.c, 4);

console.log('PASS: Concorrência entre moderação e novos comentários executada sem deadlock e com contagem exata.');

// ============================================================================
// TESTE 8: CICLO COMPLETO DE BACKUP v3 + COMPATIBILIDADE COM v2 e v1 + REJEIÇÃO DE ADULTERAÇÃO
// ============================================================================
console.log('\n--- Teste 8: Backups v3, Compatibilidade v1/v2 e Exclusão/Recuperação ---');

const v3RestId = '77777777-3333-4333-8333-333333333333';
const v3CatId = '66666666-3333-4333-8333-333333333333';
const v3ProdId = '55555555-3333-4333-8333-333333333333';
const v3BackupId = '88888888-3333-4333-8333-333333333333';

await db.exec(`
insert into public.restaurants (id, slug, name, active, archived_at)
values ('${v3RestId}', 'restaurante-v3', 'Restaurante V3', true, null);

insert into public.restaurant_members (restaurant_id, user_id, role, active)
values ('${v3RestId}', '${nomaAdmin}', 'admin', true);

insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
values ('${v3CatId}', '${v3RestId}', 'cat-v3', 'Categoria V3', 'cat-v3', 1, true);

insert into public.menu_products (
  id, restaurant_id, category_id, catalog_key, slug, name, short_description, description, price_in_cents, available, featured, sort_order
) values (
  '${v3ProdId}', '${v3RestId}', '${v3CatId}', 'prod-v3', 'prod-v3', 'Prato V3', 'desc', 'desc', 4500, true, true, 1
);
`);

// Criar 1 curtida e 2 comentários (1 aprovado e 1 pendente) em Restaurante V3
await setSession(guest2, true);
await q('select public.toggle_product_like($1, $2, true)', ['restaurante-v3', v3ProdId]);
const [v3Comm1] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  ['restaurante-v3', v3ProdId, 'Fernanda Lima', 'O melhor prato da casa, voltarei sempre!'],
);

await setSession(guest3, true);
const [v3Comm2] = await q(
  'select public.create_product_comment($1, $2, $3, $4) as res',
  ['restaurante-v3', v3ProdId, 'Rafael Souza', 'Atendimento impecável e ponto perfeito.'],
);

await setSession(nomaAdmin, false);
await q('select public.moderate_product_comment($1, $2, $3)', ['restaurante-v3', v3Comm1.res.id, 'approved']);

// Arquivar restaurante para criar snapshot v3
await db.exec(`update public.restaurants set active = false, archived_at = now() where id = '${v3RestId}';`);

await setSession(platformAdmin, false);
const [v3SnapCreated] = await q('select public.create_platform_backup_snapshot($1, $2) as res', [v3RestId, v3BackupId]);
assert.equal(v3SnapCreated.res.id, v3BackupId);
assert.equal(v3SnapCreated.res.status, 'snapshot_created');

const [v3Meta] = await q(
  "select format_version, snapshot->>'version' as snap_ver, snapshot->'tables'->'product_comments' as comm_rows from public.platform_restaurant_backups where id = $1",
  [v3BackupId],
);
assert.ok([4, 5].includes(Number(v3Meta.format_version)), 'Novo backup pós-6.3-D1 deve ser format_version 4 ou 5');
assert.ok(['4', '5'].includes(String(v3Meta.snap_ver)), 'Snapshot JSON deve ter version 4 ou 5');
assert.equal(v3Meta.comm_rows.length, 2, 'Snapshot deve incluir os 2 comentários');

await db.exec(`
update public.platform_restaurant_backups
set status = 'ready',
    files_initialized_at = now(),
    completed_at = now(),
    snapshot_sha256 = repeat('a', 64),
    manifest_sha256 = repeat('b', 64)
where id = '${v3BackupId}';
`);

// 8.1B Proteção contra exclusão desatualizada: adicionar comentário após o backup bloqueia check_platform_deletion_backup
await db.exec(`
  insert into public.product_comments (
    id, restaurant_id, product_id, user_id, author_name, body, content_fingerprint, status
  ) values (
    '99999999-3333-4333-8333-333333333333', '${v3RestId}', '${v3ProdId}', '${guest2}',
    'Cliente Extra', 'Comentário pós-backup', md5('comentario pos-backup'), 'pending'
  );
`);

await assert.rejects(
  async () => { await q('select public.check_platform_deletion_backup($1, $2)', [v3RestId, v3BackupId]); },
  (err) => err.code === '55000' || /Os dados mudaram depois deste backup/.test(err.message),
  'check_platform_deletion_backup deve bloquear exclusão se um comentário surgir após o backup',
);

await db.exec(`delete from public.product_comments where id = '99999999-3333-4333-8333-333333333333';`);

// Excluir restaurante V3 usando o backup v4
const v3DelId = '33333333-3333-4333-8333-333333333333';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v3DelId}', '${v3RestId}', 'Restaurante V3', 'restaurante-v3', '${v3BackupId}', '${platformAdmin}', 'Exclusão V3', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v3DelId}', 'snapshot'),
  ('${v3DelId}', 'manifest');
`);

// 8.1C Verificar trigger guard_platform_deletion em product_comments quando exclusão está em andamento (deleting_data)
await db.exec('begin;');
await db.exec(`update public.platform_restaurant_deletions set status = 'deleting_data' where id = '${v3DelId}';`);
await assert.rejects(
  async () => {
    await q(
      `insert into public.product_comments (
        restaurant_id, product_id, user_id, author_name, body, content_fingerprint, status
      ) values ($1, $2, $3, 'Teste', 'Bloqueado durante deleção', md5('bloqueado'), 'pending')`,
      [v3RestId, v3ProdId, guest2],
    );
  },
  (err) => err.code === '55000' || /exclusão/.test(err.message),
  'guard_platform_deletion deve bloquear escrita em product_comments durante exclusão ativa',
);
await db.exec('rollback;');

await q('select public.delete_platform_restaurant_data($1, $2)', [v3DelId, platformAdmin]);
await db.exec(`update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v3DelId}';`);

// Remover guest3 do auth.users para comprovar que a recuperação funciona sem FK para auth.users
await db.exec(`delete from auth.users where id = '${guest3}';`);

const [v3RecRes] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [v3BackupId, platformAdmin]);
assert.equal(v3RecRes.res.recovered, true);
assert.equal(v3RecRes.res.tableCount, 22, 'Recuperação v4 deve restaurar todas as 22 tabelas');

const [v3ProdAfter] = await q('select likes_count, comments_count from public.menu_products where id = $1', [v3ProdId]);
assert.equal(v3ProdAfter.likes_count, 1, 'Prato V3 recuperado deve preservar likes_count = 1');
assert.equal(v3ProdAfter.comments_count, 2, 'Prato V3 recuperado deve preservar comments_count = 2');

const [v3CommentsAfter] = await q('select count(*)::int as c from public.product_comments where product_id = $1', [v3ProdId]);
assert.equal(v3CommentsAfter.c, 2, 'Ambos os comentários foram restaurados no backup');

// 8.2 Testar rejeição de snapshots adulterados
const tamperedV3Id = '44444444-3333-4333-8333-333333333333';
const [v3SnapFull] = await q('select snapshot from public.platform_restaurant_backups where id = $1', [v3BackupId]);
const badV3Snap = structuredClone(v3SnapFull.snapshot);
badV3Snap.tables.menu_products[0].comments_count = 99;

await db.exec(`
insert into public.platform_restaurant_backups (
  id, source_restaurant_id, source_name, source_slug, format_version, status, snapshot,
  files_initialized_at, completed_at, snapshot_sha256, manifest_sha256, storage_inventory, media_references
) values (
  '${tamperedV3Id}', '${v3RestId}', 'Tampered V3', 'tampered-v3', ${v3Meta.format_version}, 'ready', '${JSON.stringify(badV3Snap).replace(/'/g, "''")}'::jsonb,
  now(), now(), repeat('c', 64), repeat('d', 64), '[]'::jsonb, '[]'::jsonb
);
`);

await assert.rejects(
  async () => { await q('select public.stage_platform_backup_recovery($1)', [tamperedV3Id]); },
  /Contagem de comentários inconsistente/,
  'Snapshot com comments_count inconsistente deve ser rejeitado em staging',
);

const missingTableV3Snap = structuredClone(v3SnapFull.snapshot);
delete missingTableV3Snap.tables.product_comments;
await q('update public.platform_restaurant_backups set snapshot = $1 where id = $2', [missingTableV3Snap, tamperedV3Id]);

await assert.rejects(
  async () => { await q('select public.stage_platform_backup_recovery($1)', [tamperedV3Id]); },
  /Tabela ausente no snapshot: product_comments/,
  'Snapshot sem product_comments deve ser rejeitado',
);

// 8.3 Testar restauração completa (complete_platform_backup_recovery) de backup histórico v2 (19 tabelas, preservando likes)
const compatV2Snap = structuredClone(v3SnapFull.snapshot);
compatV2Snap.version = 2;
delete compatV2Snap.tables.product_comments;
delete compatV2Snap.tables.restaurant_comment_restricted_terms;
delete compatV2Snap.tables.product_comment_likes;
for (const prod of compatV2Snap.tables.menu_products) {
  delete prod.comments_count;
}
await q('update public.platform_restaurant_backups set format_version = 2, snapshot = $1 where id = $2', [compatV2Snap, tamperedV3Id]);

const [v2StageRes] = await q('select public.stage_platform_backup_recovery($1) as res', [tamperedV3Id]);
assert.equal(v2StageRes.res.tableCount, 19, 'Snapshot v2 legítimo deve ser aceito com tableCount = 19');

// Excluir restaurante V3 novamente para restaurar a partir do snapshot v2 histórico
const v3DelForV2 = '33333333-3333-4333-8333-444444444444';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v3DelForV2}', '${v3RestId}', 'Restaurante V3', 'restaurante-v3', '${v3BackupId}', '${platformAdmin}', 'Exclusão para teste V2', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v3DelForV2}', 'snapshot'),
  ('${v3DelForV2}', 'manifest');
`);
await q('select public.delete_platform_restaurant_data($1, $2)', [v3DelForV2, platformAdmin]);
await db.exec(`update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v3DelForV2}';`);

const [v2FullRec] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [tamperedV3Id, platformAdmin]);
assert.equal(v2FullRec.res.recovered, true);
assert.equal(v2FullRec.res.tableCount, 19);

const [v2RestoredProd] = await q('select likes_count, comments_count from public.menu_products where id = $1', [v3ProdId]);
assert.equal(v2RestoredProd.likes_count, 1, 'Restauração v2 preserva likes_count = 1');
assert.equal(v2RestoredProd.comments_count, 0, 'Restauração v2 inicializa comments_count = 0');

// 8.4 Testar restauração completa (complete_platform_backup_recovery) de backup legado v1 (17 tabelas)
// Também confirmar que novo snapshot criado sobre restaurante SEM comentários gera v4!
const v3NoCommentsBackupId = '88888888-3333-4333-8333-555555555555';
await q('select public.create_platform_backup_snapshot($1, $2)', [v3RestId, v3NoCommentsBackupId]);
const [v3NoCommMeta] = await q(
  "select format_version, snapshot->>'version' as snap_ver from public.platform_restaurant_backups where id = $1",
  [v3NoCommentsBackupId],
);
assert.ok([4, 5].includes(Number(v3NoCommMeta.format_version)), 'Mesmo sem comentários, novo backup deve ser v4 ou v5');
assert.ok(['4', '5'].includes(String(v3NoCommMeta.snap_ver)), 'Mesmo sem comentários, snapshot JSON deve ter version 4 ou 5');

await db.exec(`
update public.platform_restaurant_backups
set status = 'ready',
    files_initialized_at = now(),
    completed_at = now(),
    snapshot_sha256 = repeat('a', 64),
    manifest_sha256 = repeat('b', 64)
where id = '${v3NoCommentsBackupId}';
`);

// Excluir usando o backup v4 sem comentários e restaurar a partir da fixture v1 (17 tabelas)
const v3DelForV1 = '33333333-3333-4333-8333-555555555555';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v3DelForV1}', '${v3RestId}', 'Restaurante V3', 'restaurante-v3', '${v3NoCommentsBackupId}', '${platformAdmin}', 'Exclusão para teste V1', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v3DelForV1}', 'snapshot'),
  ('${v3DelForV1}', 'manifest');
`);
await q('select public.delete_platform_restaurant_data($1, $2)', [v3DelForV1, platformAdmin]);
await db.exec(`update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v3DelForV1}';`);

const compatV1Snap = structuredClone(compatV2Snap);
compatV1Snap.version = 1;
delete compatV1Snap.tables.product_likes;
delete compatV1Snap.tables.product_like_events;
for (const prod of compatV1Snap.tables.menu_products) {
  delete prod.likes_count;
}
const v1HistBackupId = '44444444-1111-4111-8111-111111111111';
await db.exec(`
insert into public.platform_restaurant_backups (
  id, source_restaurant_id, source_name, source_slug, format_version, status, snapshot,
  files_initialized_at, completed_at, snapshot_sha256, manifest_sha256, storage_inventory, media_references
) values (
  '${v1HistBackupId}', '${v3RestId}', 'Hist V1', 'restaurante-v3', 1, 'ready', '${JSON.stringify(compatV1Snap).replace(/'/g, "''")}'::jsonb,
  now(), now(), repeat('e', 64), repeat('f', 64), '[]'::jsonb, '[]'::jsonb
);
`);

const [v1FullRec] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [v1HistBackupId, platformAdmin]);
assert.equal(v1FullRec.res.recovered, true);
assert.equal(v1FullRec.res.tableCount, 17, 'Restauração v1 deve recuperar as 17 tabelas legadas');

const [v1RestoredProd] = await q('select likes_count, comments_count from public.menu_products where id = $1', [v3ProdId]);
assert.equal(v1RestoredProd.likes_count, 0, 'Restauração v1 inicializa likes_count = 0');
assert.equal(v1RestoredProd.comments_count, 0, 'Restauração v1 inicializa comments_count = 0');

console.log('PASS: Ciclo de vida completo de backups v3 e restauração integral de fixtures históricas v1 e v2 validados.');

console.log('\n========================================================================');
console.log('TODOS OS TESTES DO BLOCO 6.3-A (COMENTÁRIOS REAIS) FORAM APROVADOS!');
console.log('========================================================================\n');

await db.close();
