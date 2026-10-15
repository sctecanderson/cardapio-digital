import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 13.2 (Resolução Segura de Mesas) ---');
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
    email text,
    email_confirmed_at timestamptz default now(),
    is_anonymous boolean default false
  );

  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  $$;

  create function extensions.gen_random_bytes(integer) returns bytea language sql as $$
    select decode(repeat('00', $1), 'hex');
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

const migrationsDir = path.resolve(import.meta.dirname, '../supabase/migrations');
const migrationFiles = fs.readdirSync(migrationsDir).sort();

for (const file of migrationFiles) {
  if (file.endsWith('.sql')) {
    if (file === '20261008141500_create_table_tab_consumption.sql') {
      const seedSql = fs.readFileSync(path.join(migrationsDir, '../seeds/demo_restaurants.sql'), 'utf-8');
      await db.exec(seedSql);
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      await db.exec(sql);
    } catch (err) {
      console.error(`Erro compilando migration: ${file}`);
      throw err;
    }
  }
}

console.log('PASS: Todas as migrações (incluindo 20261015010000) compiladas com sucesso.');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function runAs(userId, claims, fn) {
  await db.exec('begin;');
  try {
    if (userId) {
      await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', true);`);
      await db.exec(
        `select set_config('request.jwt.claims', '${JSON.stringify({ sub: userId, role: 'authenticated', ...claims })}', true);`,
      );
      await db.exec('set local role authenticated;');
    } else {
      await db.exec(`select set_config('request.jwt.claim.sub', '', true);`);
      await db.exec(`select set_config('request.jwt.claims', '{}', true);`);
      await db.exec('set local role anon;');
    }
    const result = await fn();
    await db.exec('commit;');
    return result;
  } catch (err) {
    await db.exec('rollback;');
    throw err;
  }
}

// ----------------------------------------------------------------------------
// SETUP: Restaurante e Mesas de Teste
// ----------------------------------------------------------------------------
const testRestaurantId = '80000000-0000-4000-8000-000000000001';
const tableActiveId = '80000000-0000-4000-8000-000000000011';
const tableInactiveId = '80000000-0000-4000-8000-000000000012';
const tableDeletedId = '80000000-0000-4000-8000-000000000013';

await db.exec(`
  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables, subscription_expires_at)
  values ('${testRestaurantId}', 'Pizzaria Bella', 'pizzaria-bella', true, 'pro', 20, timezone('utc', now()) + interval '30 days')
  on conflict (id) do nothing;

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values
    ('${tableActiveId}', '${testRestaurantId}', 2, 'Mesa 02 VIP', true, true, null),
    ('${tableInactiveId}', '${testRestaurantId}', 5, 'Mesa 05 Bloqueada', false, false, null),
    ('${tableDeletedId}', '${testRestaurantId}', 9, 'Mesa 09 Excluida', true, true, timezone('utc', now()))
  on conflict (id) do nothing;
`);

console.log('--- TESTE 1: Leitura de Mesa Ativa pelo Cliente Anônimo (anon) ---');
await runAs(null, {}, async () => {
  const rows = await q(`
    select id, restaurant_id, table_number, label, active, is_active, deleted_at
    from public.restaurant_tables
    where id = '${tableActiveId}'
      and (coalesce(is_active, active, true) = true)
      and deleted_at is null;
  `);

  assert.equal(rows.length, 1, 'Visitante anon deve conseguir consultar a mesa ativa pelo UUID');
  assert.equal(rows[0].table_number, 2);
  assert.equal(rows[0].label, 'Mesa 02 VIP');
});
console.log('PASS: Mesa ativa acessível via select seguro por anon.');

console.log('--- TESTE 2: Bloqueio de Mesas Inativas e Excluídas ---');
await runAs(null, {}, async () => {
  const inactiveRows = await q(`
    select * from public.restaurant_tables where id = '${tableInactiveId}';
  `);
  assert.equal(inactiveRows.length, 0, 'RLS deve bloquear leitura de mesa inativa para visitantes');

  const deletedRows = await q(`
    select * from public.restaurant_tables where id = '${tableDeletedId}';
  `);
  assert.equal(deletedRows.length, 0, 'RLS deve bloquear leitura de mesa excluída para visitantes');
});
console.log('PASS: Mesas inativas e excluídas devidamente filtradas/bloqueadas por RLS.');

console.log('--- TESTE 3: Consulta via RPC get_public_table_by_id ---');
await runAs(null, {}, async () => {
  const activeTableRes = await q(`select public.get_public_table_by_id('${tableActiveId}') as res;`);
  assert.ok(activeTableRes[0].res, 'RPC deve retornar payload JSON para mesa ativa');
  assert.equal(activeTableRes[0].res.tableNumber, 2);
  assert.equal(activeTableRes[0].res.restaurantBillingStatus, 'active');

  const inactiveTableRes = await q(`select public.get_public_table_by_id('${tableInactiveId}') as res;`);
  assert.equal(inactiveTableRes[0].res, null, 'RPC deve retornar null para mesa inativa');

  const deletedTableRes = await q(`select public.get_public_table_by_id('${tableDeletedId}') as res;`);
  assert.equal(deletedTableRes[0].res, null, 'RPC deve retornar null para mesa excluída');
});
console.log('PASS: RPC get_public_table_by_id validada com sucesso.');

console.log('\n>>> TODOS OS TESTES DO BLOCO 13.2 FORAM APROVADOS! <<<');
