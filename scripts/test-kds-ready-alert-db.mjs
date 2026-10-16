import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 19 (Alerta de Prato Pronto no KDS) ---');
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

console.log('PASS: Todas as migrações (incluindo 20261016040000_kds_dish_ready_alert.sql) compiladas com sucesso.');

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

const testRestId = '60000000-0000-4000-8000-000000000001';
const testAdminId = '60000000-0000-4000-8000-000000000011';
const testTableId = '60000000-0000-4000-8000-000000000021';
const testCategoryId = '60000000-0000-4000-8000-000000000031';
const testProductId = '60000000-0000-4000-8000-000000000041';

await db.exec(`
  insert into auth.users (id, email)
  values ('${testAdminId}', 'admin@bloco19.com')
  on conflict (id) do nothing;

  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables, subscription_expires_at)
  values ('${testRestId}', 'Pizzaria Bella', 'pizzaria-bella', true, 'pro', 15, timezone('utc', now()) + interval '30 days')
  on conflict (id) do nothing;

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${testRestId}', '${testAdminId}', 'admin', true)
  on conflict do nothing;

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values ('${testTableId}', '${testRestId}', 7, 'Mesa 07 Salão', true, true, null)
  on conflict (id) do nothing;

  insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
  values ('${testCategoryId}', '${testRestId}', '${testCategoryId}', 'Pizzas', 'pizzas', 1, true)
  on conflict (id) do nothing;

  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, preparation_station
  ) values (
    '${testProductId}', '${testRestId}', '${testCategoryId}', '${testProductId}', 'pizza-margherita',
    'Pizza Margherita', 'Molho artesanal e manjericão fresco', 'Tamanho grande 8 fatias', 6500, true, true,
    1, 'kitchen'
  ) on conflict (id) do nothing;

`);

// Criar pedido direto da mesa (gera visita, comanda e item em pending)
const orderRes = (await q(
  `select public.create_direct_table_order('${testTableId}', '${testProductId}', 1) as res;`
))[0].res;
assert.equal(orderRes.success, true);
const testItemId = orderRes.itemId;

console.log('--- TESTE 1: Avançar status para "preparing" ---');
await runAs(testAdminId, {}, async () => {
  const item = (await q(
    `select * from public.update_tab_item_production_status('pizzaria-bella', '${testItemId}', 'preparing');`
  ))[0];
  assert.equal(item.production_status, 'preparing');
  assert.ok(item.prep_started_at, 'prep_started_at deve ser preenchido');

  // Nenhum alerta de prato pronto deve ter sido emitido ainda
  const alerts = await q(
    `select * from public.restaurant_alerts where restaurant_id = '${testRestId}' and type = 'dish_ready';`
  );
  assert.equal(alerts.length, 0, 'Não deve haver alerta dish_ready no status preparing');
});
console.log('PASS: Transição para preparing realizada sem disparar alertas indevidos.');

console.log('--- TESTE 2: Avançar status para "ready" e verificar inserção do alerta dish_ready ---');
await runAs(testAdminId, {}, async () => {
  const item = (await q(
    `select * from public.update_tab_item_production_status('pizzaria-bella', '${testItemId}', 'ready');`
  ))[0];
  assert.equal(item.production_status, 'ready');
  assert.ok(item.prep_ready_at, 'prep_ready_at deve ser preenchido');

  // Verificar geração do alerta em restaurant_alerts
  const alerts = await q(
    `select * from public.restaurant_alerts where restaurant_id = '${testRestId}' and type = 'dish_ready';`
  );
  assert.equal(alerts.length, 1, 'Deve existir exatamente 1 alerta dish_ready');
  const alert = alerts[0];
  assert.equal(alert.reference_id, testItemId);
  assert.equal(alert.is_read, false);
  assert.ok(alert.title.includes('Mesa 7'), `Título deve mencionar Mesa 7: "${alert.title}"`);
  assert.ok(alert.message.includes('Pizza Margherita'), `Mensagem deve conter o nome do produto: "${alert.message}"`);
});
console.log('PASS: RPC update_tab_item_production_status gerou automaticamente o alerta dish_ready para o garçom com identificação da Mesa 7.');

console.log('--- TESTE 3: Avançar status para "delivered" (sem duplicar alertas) ---');
await runAs(testAdminId, {}, async () => {
  const item = (await q(
    `select * from public.update_tab_item_production_status('pizzaria-bella', '${testItemId}', 'delivered');`
  ))[0];
  assert.equal(item.production_status, 'delivered');
  assert.ok(item.prep_delivered_at, 'prep_delivered_at deve ser preenchido');

  const alerts = await q(
    `select * from public.restaurant_alerts where restaurant_id = '${testRestId}' and type = 'dish_ready';`
  );
  assert.equal(alerts.length, 1, 'Não deve criar alertas duplicados ao entregar');
});
console.log('PASS: Entrega concluída sem criação de novos alertas.');

console.log('\n>>> TODOS OS TESTES DO BLOCO 19 (DISPARO DE ALERTA KDS -> GARÇOM) PASSARAM COM SUCESSO! <<<');
