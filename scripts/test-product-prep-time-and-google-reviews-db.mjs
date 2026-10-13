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

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Fechamento Definitivo do Bloco 6 ---');
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

console.log('PASS: Todas as migrações compiladas com sucesso.\n');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const guestUser = '90000000-0000-4000-8000-000000000001';
const nomaAdmin = '80000000-0000-4000-8000-000000000001';
const platformAdmin = '80000000-0000-4000-8000-000000000099';

const [{ id: nomaId, slug: nomaSlug }] = await q("select id, slug from public.restaurants where slug = 'noma'");

await db.exec(`
insert into auth.users (id, is_anonymous) values
  ('${guestUser}', true),
  ('${nomaAdmin}', false),
  ('${platformAdmin}', false);

insert into public.platform_admins (user_id) values ('${platformAdmin}');

insert into public.restaurant_members (restaurant_id, user_id, role, active) values
  ('${nomaId}', '${nomaAdmin}', 'admin', true);
`);

const setSession = async (userId, isAnonymous) => {
  await db.exec(`
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claims', '{"sub":"${userId}","is_anonymous":${isAnonymous},"role":"authenticated"}', false);
  `);
};

// ============================================================================
// TESTE 1: TEMPO ESTIMADO DE PREPARO (CADASTRO E REGRAS DE INTEGRIDADE)
// ============================================================================
console.log('--- Teste 1: Tempo Estimado de Preparo dos Produtos ---');

const [nomaProd] = await q("select id, name, slug, category_id, revision from public.menu_products where restaurant_id = $1 limit 1", [nomaId]);

await setSession(nomaAdmin, false);

// 1.1 Salvar tempo válido (20 a 30 min) via save_menu_product
const saveValidRes = await q(
  `select public.save_menu_product(
    $1::text, $2::uuid, $3::integer,
    jsonb_build_object(
      'name', 'Prato Especial Teste',
      'slug', $4::text,
      'category_id', $5::text,
      'short_description', 'Curta',
      'description', 'Longa descrição',
      'price_in_cents', 4500,
      'available', true,
      'featured', false,
      'sort_order', 10,
      'prep_time_min_minutes', 20,
      'prep_time_max_minutes', 30
    )
  ) as res`,
  [nomaSlug, nomaProd.id, nomaProd.revision, nomaProd.slug, nomaProd.category_id]
);
assert.ok(saveValidRes[0].res, 'save_menu_product com tempo válido deve ter sucesso');

const [prodSaved] = await q("select prep_time_min_minutes, prep_time_max_minutes from public.menu_products where id = $1", [nomaProd.id]);
assert.equal(prodSaved.prep_time_min_minutes, 20);
assert.equal(prodSaved.prep_time_max_minutes, 30);

// 1.2 Rejeitar tempo inválido: min > max
const [prodUpdatedRev] = await q("select revision from public.menu_products where id = $1", [nomaProd.id]);
await assert.rejects(
  async () => {
    await q(
      `select public.save_menu_product(
        $1::text, $2::uuid, $3::integer,
        jsonb_build_object(
          'name', 'Prato Especial Teste',
          'slug', $4::text,
          'category_id', $5::text,
          'short_description', 'Curta',
          'description', 'Longa descrição',
          'price_in_cents', 4500,
          'available', true,
          'featured', false,
          'sort_order', 10,
          'prep_time_min_minutes', 40,
          'prep_time_max_minutes', 20
        )
      )`,
      [nomaSlug, nomaProd.id, prodUpdatedRev.revision, nomaProd.slug, nomaProd.category_id]
    );
  },
  /O tempo mínimo de preparo não pode ser maior que o tempo máximo/,
  'Deve rejeitar min > max'
);

// 1.3 Rejeitar tempo parcial: apenas um dos campos preenchido
await assert.rejects(
  async () => {
    await q(
      `select public.save_menu_product(
        $1::text, $2::uuid, $3::integer,
        jsonb_build_object(
          'name', 'Prato Especial Teste',
          'slug', $4::text,
          'category_id', $5::text,
          'short_description', 'Curta',
          'description', 'Longa descrição',
          'price_in_cents', 4500,
          'available', true,
          'featured', false,
          'sort_order', 10,
          'prep_time_min_minutes', 15,
          'prep_time_max_minutes', null
        )
      )`,
      [nomaSlug, nomaProd.id, prodUpdatedRev.revision, nomaProd.slug, nomaProd.category_id]
    );
  },
  /Informe o tempo de preparo mínimo e máximo ou deixe ambos em branco/,
  'Deve rejeitar tempo parcial'
);

// 1.4 Exibição na RPC get_public_menu
const [menuRes] = await q("select public.get_public_menu($1) as menu", [nomaSlug]);
const targetInMenu = menuRes.menu.products.find((p) => p.id === nomaProd.id);
assert.equal(targetInMenu.prepTimeMinMinutes, 20);
assert.equal(targetInMenu.prepTimeMaxMinutes, 30);
console.log('PASS: Cadastro, validações e leitura pública de tempo de preparo validados.');

// ============================================================================
// TESTE 2: AVALIAÇÕES NO GOOGLE (LINK OFICIAL E REGRAS DE SEGURANÇA)
// ============================================================================
console.log('\n--- Teste 2: Avaliações no Google ---');

const [nomaRest] = await q("select revision from public.restaurants where id = $1", [nomaId]);

// 2.1 Salvar link válido do Google
await q(
  `select public.save_restaurant_identity(
    $1, $2,
    jsonb_build_object(
      'name', 'Noma Gastronomia',
      'subtitle', 'Alta culinária',
      'description', 'Restaurante contemporâneo',
      'address', 'Rua das Flores, 123',
      'phone', '11999998888',
      'opening_hours', '12h às 23h',
      'logo', null,
      'cover', null,
      'theme_primary', '#111827',
      'theme_background', '#ffffff',
      'theme_text', '#111827',
      'theme_card', '#f9fafb',
      'service_fee_percent', 10,
      'timezone', 'America/Sao_Paulo',
      'google_review_url', 'https://g.page/r/CdE2345/review'
    )
  )`,
  [nomaSlug, nomaRest.revision]
);

const [restCheck] = await q("select google_review_url from public.restaurants where id = $1", [nomaId]);
assert.equal(restCheck.google_review_url, 'https://g.page/r/CdE2345/review');

// 2.2 Rejeitar link não-Google
const [nomaRest2] = await q("select revision from public.restaurants where id = $1", [nomaId]);
await assert.rejects(
  async () => {
    await q(
      `select public.save_restaurant_identity(
        $1, $2,
        jsonb_build_object(
          'name', 'Noma Gastronomia',
          'subtitle', 'Alta culinária',
          'description', 'Restaurante contemporâneo',
          'address', 'Rua das Flores, 123',
          'phone', '11999998888',
          'opening_hours', '12h às 23h',
          'logo', null,
          'cover', null,
          'theme_primary', '#111827',
          'theme_background', '#ffffff',
          'theme_text', '#111827',
          'theme_card', '#f9fafb',
          'service_fee_percent', 10,
          'timezone', 'America/Sao_Paulo',
          'google_review_url', 'https://site-malicioso.com/review'
        )
      )`,
      [nomaSlug, nomaRest2.revision]
    );
  },
  /Informe um link válido do Perfil da Empresa no Google/,
  'Deve rejeitar URL de domínio externo não-Google'
);

// 2.3 Exibição na RPC get_public_restaurant
const [pubRestRes] = await q("select public.get_public_restaurant($1) as rest", [nomaSlug]);
assert.equal(pubRestRes.rest.googleReviewUrl, 'https://g.page/r/CdE2345/review');
console.log('PASS: Cadastro de URL Google, proteção regex contra links externos e get_public_restaurant validados.');

// ============================================================================
// TESTE 3: BACKUP v5 E RECUPERAÇÃO RETROCOMPATÍVEL v1-v5
// ============================================================================
console.log('\n--- Teste 3: Plataforma de Backups v5 e Retrocompatibilidade v1-v5 ---');

const v5RestId = '77777777-5555-4555-8555-555555555555';
const v5BackupId = '88888888-5555-4555-8555-555555555555';

await db.exec(`
insert into public.restaurants (
  id, name, slug, active, archived_at, google_review_url
) values (
  '${v5RestId}', 'Restaurante Teste v5', 'rest-teste-v5', false, now(),
  'https://g.page/r/v5test/review'
);
`);

await setSession(platformAdmin, false);

const [v5SnapRes] = await q('select public.create_platform_backup_snapshot($1, $2) as res', [v5RestId, v5BackupId]);
assert.equal(v5SnapRes.res.status, 'snapshot_created');

const [v5Meta] = await q(
  "select format_version, snapshot->>'version' as snap_ver from public.platform_restaurant_backups where id = $1",
  [v5BackupId]
);
assert.equal(v5Meta.format_version, 5, 'Novo backup deve ter format_version = 5');
assert.equal(v5Meta.snap_ver, '5');

await db.exec(`
update public.platform_restaurant_backups
set status = 'ready',
    files_initialized_at = now(),
    completed_at = now(),
    snapshot_sha256 = repeat('a', 64),
    manifest_sha256 = repeat('b', 64)
where id = '${v5BackupId}';
`);

const [stageRes] = await q('select public.stage_platform_backup_recovery($1) as res', [v5BackupId]);
assert.equal(stageRes.res.tableCount, 22);

const v5DelId = '33333333-5555-4555-8555-555555555555';
await db.exec(`
insert into public.platform_restaurant_deletions (
  id, source_restaurant_id, source_name, source_slug, backup_id, requested_by, reason, status
) values (
  '${v5DelId}', '${v5RestId}', 'Restaurante Teste v5', 'rest-teste-v5', '${v5BackupId}', '${platformAdmin}', 'Exclusão V5', 'pending'
);
insert into public.platform_deletion_checks (deletion_id, file_key) values
  ('${v5DelId}', 'snapshot'),
  ('${v5DelId}', 'manifest');
`);
await q('select public.delete_platform_restaurant_data($1, $2)', [v5DelId, platformAdmin]);
await db.exec(`update public.platform_restaurant_deletions set status = 'completed', completed_at = now() where id = '${v5DelId}';`);

const [recRes] = await q('select public.complete_platform_backup_recovery($1, $2) as res', [v5BackupId, platformAdmin]);
assert.equal(recRes.res.recovered, true);

const [restoredRest] = await q('select google_review_url from public.restaurants where id = $1', [v5RestId]);
assert.equal(restoredRest.google_review_url, 'https://g.page/r/v5test/review');

console.log('PASS: Geração de backup v5, validação de staging e recuperação aprovadas.');

console.log('\n========================================================================');
console.log('TODOS OS TESTES DO FECHAMENTO DO BLOCO 6 PASSARAM COM 100% DE SUCESSO!');
console.log('========================================================================\n');
