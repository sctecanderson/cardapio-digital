import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 14 (Estoque e Alertas) ---');
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

console.log('PASS: Todas as migrações compiladas com sucesso.');

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
// SETUP: Usuários e Restaurante
// ----------------------------------------------------------------------------
const superAdminId = '90000000-0000-4000-8000-000000000001';
const restAdminId = '90000000-0000-4000-8000-000000000002';
const outsiderUserId = '90000000-0000-4000-8000-000000000003';
const testRestId = '90000000-0000-4000-8000-000000000010';

await db.exec(`
  insert into auth.users (id, email, is_anonymous) values
    ('${superAdminId}', 'superadmin@elozi.com', false),
    ('${restAdminId}', 'gerente@restaurante.com', false),
    ('${outsiderUserId}', 'estranho@externo.com', false);

  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables)
  values ('${testRestId}', 'Restaurante Estoque Teste', 'restaurante-estoque', true, 'pro', 20)
  on conflict (id) do nothing;

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${testRestId}', '${restAdminId}', 'admin', true);
`);

console.log('--- TESTE 1: Inserção de Item no Estoque ---');
let itemResult = await db.query(`
  insert into public.inventory_items (
    restaurant_id,
    name,
    category,
    unit_measure,
    current_quantity,
    alert_threshold
  ) values (
    '${testRestId}',
    'Cerveja Artesanal IPA',
    'Bebidas',
    'un',
    20,
    5
  ) returning *;
`);
assert.equal(itemResult.rows.length, 1);
const itemId = itemResult.rows[0].id;
assert.equal(Number(itemResult.rows[0].current_quantity), 20);
assert.equal(Number(itemResult.rows[0].alert_threshold), 5);

// Nenhum alerta deve ter sido gerado na inserção inicial
let initialAlerts = await q(`select * from public.restaurant_alerts where reference_id = '${itemId}';`);
assert.equal(initialAlerts.length, 0, 'Não deve criar alerta na inserção se estoque inicial está acima da cota');
console.log('PASS: Item inserido sem alertas indevidos.');

console.log('--- TESTE 2: Disparo de Alerta ao Atingir Limite Crítico ---');
// Atualiza de 20 para 4 (abaixo do limiar 5)
await db.exec(`
  update public.inventory_items
  set current_quantity = 4
  where id = '${itemId}';
`);

let alertsAfterDrop = await q(`select * from public.restaurant_alerts where reference_id = '${itemId}';`);
assert.equal(alertsAfterDrop.length, 1, 'Deve disparar exatamente 1 alerta de ruptura');
assert.equal(alertsAfterDrop[0].type, 'low_stock');
assert.equal(alertsAfterDrop[0].is_read, false);
assert.match(alertsAfterDrop[0].title, /Estoque Crítico: Cerveja Artesanal IPA/);
assert.match(alertsAfterDrop[0].message, /4 un/);
console.log('PASS: Alerta gerado com sucesso ao atingir limiar.');

console.log('--- TESTE 3: Regra Anti-Spam (Deduções Sucessivas no Limiar) ---');
// Reduz de 4 para 3 e depois para 0 (ambos abaixo de 5)
await db.exec(`
  update public.inventory_items
  set current_quantity = 3
  where id = '${itemId}';
`);

let alertsAfterSecondDrop = await q(`select * from public.restaurant_alerts where reference_id = '${itemId}';`);
assert.equal(alertsAfterSecondDrop.length, 1, 'Regra anti-spam: não deve duplicar alerta enquanto já estiver abaixo do limiar');

await db.exec(`
  update public.inventory_items
  set current_quantity = 0
  where id = '${itemId}';
`);
let alertsAfterZero = await q(`select * from public.restaurant_alerts where reference_id = '${itemId}';`);
assert.equal(alertsAfterZero.length, 1, 'Regra anti-spam: quantidade zero não cria outro alerta');
console.log('PASS: Anti-spam funcionou perfeitamente.');

console.log('--- TESTE 4: Reabastecimento e Novo Ciclo de Alerta ---');
// Reabastece de 0 para 15 (acima de 5)
await db.exec(`
  update public.inventory_items
  set current_quantity = 15
  where id = '${itemId}';
`);
let alertsAfterRestock = await q(`select * from public.restaurant_alerts where reference_id = '${itemId}';`);
assert.equal(alertsAfterRestock.length, 1, 'Reabastecimento não adiciona novos alertas');

// Nova queda de 15 para 5 (atinge exatamente o limiar)
await db.exec(`
  update public.inventory_items
  set current_quantity = 5
  where id = '${itemId}';
`);
let alertsAfterSecondBreach = await q(`select * from public.restaurant_alerts where reference_id = '${itemId}' order by created_at asc;`);
assert.equal(alertsAfterSecondBreach.length, 2, 'Novo ciclo de alerta gerado após reabastecimento seguido de queda');
console.log('PASS: Novo alerta gerado após reabastecimento e nova queda.');

console.log('--- TESTE 5: RLS e Isolamento de Tenants ---');
// Gerente do restaurante pode listar itens e alertas
await runAs(restAdminId, { email: 'gerente@restaurante.com' }, async () => {
  const items = await q(`select * from public.inventory_items where restaurant_id = '${testRestId}';`);
  assert.equal(items.length, 1);

  const alerts = await q(`select * from public.restaurant_alerts where restaurant_id = '${testRestId}';`);
  assert.equal(alerts.length, 2);

  // Marcar alerta como lido
  await db.exec(`update public.restaurant_alerts set is_read = true where id = '${alerts[0].id}';`);
  const updatedAlert = await q(`select is_read from public.restaurant_alerts where id = '${alerts[0].id}';`);
  assert.equal(updatedAlert[0].is_read, true);
});

// Usuário estranho (não membro) não vê nada
await runAs(outsiderUserId, { email: 'estranho@externo.com' }, async () => {
  const items = await q(`select * from public.inventory_items where restaurant_id = '${testRestId}';`);
  assert.equal(items.length, 0, 'Usuário de fora não pode ver itens de outro restaurante');

  const alerts = await q(`select * from public.restaurant_alerts where restaurant_id = '${testRestId}';`);
  assert.equal(alerts.length, 0, 'Usuário de fora não pode ver alertas de outro restaurante');
});

console.log('PASS: RLS e isolamento validados com 100% de sucesso.');
console.log('\n>>> TODOS OS TESTES DO BLOCO 14 FORAM APROVADOS! <<<');
