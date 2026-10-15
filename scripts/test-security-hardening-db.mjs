import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 16 (Security Hardening) ---');
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

console.log('PASS: Todas as migrações (incluindo 20261016010000) compiladas com sucesso.');

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
// SETUP: Usuários e Restaurantes de Teste
// ----------------------------------------------------------------------------
const activeRestaurantId = '70000000-0000-4000-8000-000000000001';
const inactiveRestaurantId = '70000000-0000-4000-8000-000000000002';

const adminUserId = '70000000-0000-4000-8000-000000000011';
const waiterUserId = '70000000-0000-4000-8000-000000000012';
const strangerUserId = '70000000-0000-4000-8000-000000000013';

const activeTableId = '70000000-0000-4000-8000-000000000021';
const inactiveRestTableId = '70000000-0000-4000-8000-000000000022';

await db.exec(`
  insert into auth.users (id, email)
  values
    ('${adminUserId}', 'admin@restaurante.com'),
    ('${waiterUserId}', 'waiter@restaurante.com'),
    ('${strangerUserId}', 'stranger@outro.com')
  on conflict (id) do nothing;

  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables, subscription_expires_at)
  values
    ('${activeRestaurantId}', 'Restaurante Seguro', 'restaurante-seguro', true, 'pro', 10, timezone('utc', now()) + interval '30 days'),
    ('${inactiveRestaurantId}', 'Restaurante Bloqueado', 'restaurante-bloqueado', false, 'pro', 10, timezone('utc', now()) + interval '30 days')
  on conflict (id) do nothing;

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values
    ('${activeRestaurantId}', '${adminUserId}', 'admin', true),
    ('${activeRestaurantId}', '${waiterUserId}', 'waiter', true)
  on conflict do nothing;

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values
    ('${activeTableId}', '${activeRestaurantId}', 1, 'Mesa 01', true, true, null),
    ('${inactiveRestTableId}', '${inactiveRestaurantId}', 1, 'Mesa 01 Inativo', true, true, null)
  on conflict (id) do nothing;
`);

console.log('--- TESTE 1: RLS restaurant_tables_read_public (Bloqueio de Mesas de Restaurantes Inativos) ---');
await runAs(null, {}, async () => {
  // Consulta mesa de restaurante ativo -> permitida
  const activeRows = await q(`select id from public.restaurant_tables where id = '${activeTableId}';`);
  assert.equal(activeRows.length, 1, 'Anon deve conseguir ler mesa de restaurante ativo');

  // Consulta mesa de restaurante suspenso/inativo -> bloqueada
  const inactiveRows = await q(`select id from public.restaurant_tables where id = '${inactiveRestTableId}';`);
  assert.equal(inactiveRows.length, 0, 'Anon NÃO deve conseguir ler mesa de restaurante suspenso');
});
console.log('PASS: RLS restaurant_tables_read_public impede vazamento de mesas de restaurantes inativos.');

console.log('--- TESTE 2: get_kds_active_items Autorização Estrita ---');
// 2.1 Anônimo deve ser rejeitado (bloqueado em grant level ou função)
await runAs(null, {}, async () => {
  await assert.rejects(
    async () => {
      await q(`select public.get_kds_active_items('restaurante-seguro');`);
    },
    /permission denied|Entre com uma conta da equipe/i
  );
});

// 2.2 Usuário estranho (sem vínculo) deve ser rejeitado
await runAs(strangerUserId, {}, async () => {
  await assert.rejects(
    async () => {
      await q(`select public.get_kds_active_items('restaurante-seguro');`);
    },
    /Sua conta não possui acesso aos pedidos deste restaurante/i
  );
});

// 2.3 Garçom do próprio restaurante deve ter acesso
await runAs(waiterUserId, {}, async () => {
  const result = await q(`select public.get_kds_active_items('restaurante-seguro') as items;`);
  assert.ok(Array.isArray(result[0].items));
});

// 2.4 Administrador do próprio restaurante deve ter acesso
await runAs(adminUserId, {}, async () => {
  const result = await q(`select public.get_kds_active_items('restaurante-seguro') as items;`);
  assert.ok(Array.isArray(result[0].items));
});
console.log('PASS: get_kds_active_items restringe acesso exclusivamente à equipe do restaurante.');

console.log('--- TESTE 3: sync_restaurant_tables_to_plan_limit Autorização Estrita ---');
// 3.1 Anônimo deve ser rejeitado (bloqueado em grant level ou função)
await runAs(null, {}, async () => {
  await assert.rejects(
    async () => {
      await q(`select public.sync_restaurant_tables_to_plan_limit('${activeRestaurantId}');`);
    },
    /permission denied|Acesso não autorizado para sincronizar cotas de mesas/i
  );
});

// 3.2 Usuário estranho deve ser rejeitado
await runAs(strangerUserId, {}, async () => {
  await assert.rejects(
    async () => {
      await q(`select public.sync_restaurant_tables_to_plan_limit('${activeRestaurantId}');`);
    },
    /Acesso não autorizado para sincronizar cotas de mesas/
  );
});

// 3.3 Garçom (não admin) deve ser rejeitado
await runAs(waiterUserId, {}, async () => {
  await assert.rejects(
    async () => {
      await q(`select public.sync_restaurant_tables_to_plan_limit('${activeRestaurantId}');`);
    },
    /Acesso não autorizado para sincronizar cotas de mesas/
  );
});

// 3.4 Administrador do restaurante deve ter sucesso
await runAs(adminUserId, {}, async () => {
  const result = await q(`select public.sync_restaurant_tables_to_plan_limit('${activeRestaurantId}') as res;`);
  assert.equal(result[0].res.success, true);
});
console.log('PASS: sync_restaurant_tables_to_plan_limit protegido contra usuários não autorizados.');

console.log('\n>>> TODOS OS TESTES DO BLOCO 16 (SECURITY HARDENING) FORAM APROVADOS! <<<');
