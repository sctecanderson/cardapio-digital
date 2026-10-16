import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 17 (Ponte Estoque-Cardápio, KDS e Liberação) ---');
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

console.log('PASS: Todas as migrações (incluindo 20261016020000) compiladas com sucesso.');

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
// SETUP: Restaurante, Estoque, Produto do Cardápio e Mesa
// ----------------------------------------------------------------------------
const testRestId = '50000000-0000-4000-8000-000000000001';
const testAdminId = '50000000-0000-4000-8000-000000000011';
const testTableId = '50000000-0000-4000-8000-000000000021';
const testInventoryItemId = '50000000-0000-4000-8000-000000000031';
const testCategoryId = '50000000-0000-4000-8000-000000000041';
const testProductId = '50000000-0000-4000-8000-000000000051';

await db.exec(`
  insert into auth.users (id, email)
  values ('${testAdminId}', 'admin@bloco17.com')
  on conflict (id) do nothing;

  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables, subscription_expires_at)
  values ('${testRestId}', 'Burger & Co', 'burger-co', true, 'pro', 15, timezone('utc', now()) + interval '30 days')
  on conflict (id) do nothing;

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${testRestId}', '${testAdminId}', 'admin', true)
  on conflict do nothing;

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values ('${testTableId}', '${testRestId}', 3, 'Mesa 03 Varanda', true, true, null)
  on conflict (id) do nothing;

  -- 1 item de estoque com quantidade inicial = 3 e limite de alerta = 2
  insert into public.inventory_items (id, restaurant_id, name, current_quantity, alert_threshold, unit_measure)
  values ('${testInventoryItemId}', '${testRestId}', 'Chopp Artesanal 500ml', 3, 2, 'un')
  on conflict (id) do nothing;

  insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
  values ('${testCategoryId}', '${testRestId}', '${testCategoryId}', 'Bebidas', 'bebidas', 1, true)
  on conflict (id) do nothing;

  -- Produto vinculado ao item de estoque
  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, preparation_station, inventory_item_id
  ) values (
    '${testProductId}', '${testRestId}', '${testCategoryId}', '${testProductId}', 'chopp-artesanal',
    'Chopp Artesanal IPA', 'Chopp gelado', '500ml de pura refrescância', 1800, true, true,
    1, 'bar', '${testInventoryItemId}'
  ) on conflict (id) do nothing;
`);

console.log('--- TESTE 1: Consulta Pública do Cardápio com Status de Estoque ---');
await runAs(null, {}, async () => {
  const menuRes = await q(`select public.get_public_menu('burger-co') as menu;`);
  const menu = menuRes[0].menu;
  assert.ok(menu.products.length > 0, 'Deve retornar produtos no cardápio público');
  const prod = menu.products.find(p => p.id === testProductId);
  assert.ok(prod, 'Produto cadastrado deve estar no cardápio');
  assert.equal(prod.inventoryItemId, testInventoryItemId);
  assert.equal(prod.isOutOfStock, false, 'Com estoque 3, não deve estar esgotado');
});
console.log('PASS: get_public_menu projeta inventoryItemId e isOutOfStock corretamente.');

console.log('--- TESTE 2: Pedido Direto da Mesa com Baixa Automática de Estoque ---');
await runAs(null, {}, async () => {
  // Cliente pede 2 Chopps diretamente na Mesa 03
  const orderRes = await q(
    `select public.create_direct_table_order('${testTableId}', '${testProductId}', 2) as res;`
  );
  const res = orderRes[0].res;
  assert.equal(res.success, true);
  assert.equal(res.tableNumber, 3);
  assert.equal(res.quantity, 2);
  assert.equal(res.preparationStation, 'bar');
  assert.equal(res.productionStatus, 'pending');
});

// Verificar se o estoque caiu de 3 para 1 (como admin do restaurante)
await runAs(testAdminId, {}, async () => {
  const invRow = (await q(`select current_quantity from public.inventory_items where id = '${testInventoryItemId}';`))[0];
  assert.equal(Number(invRow.current_quantity), 1, 'Estoque deve ser 1 após deduzir 2 unidades');

  // Verificar se disparou alerta de estoque (pois caiu de 3 para 1, abaixo do limiar 2)
  const alerts = await q(
    `select * from public.restaurant_alerts where restaurant_id = '${testRestId}' and type = 'low_stock';`
  );
  assert.ok(alerts.length >= 1, 'Trigger de alerta de estoque deve ter disparado');
});
console.log('PASS: create_direct_table_order executado com sucesso e estoque deduzido atomicamente.');

console.log('--- TESTE 3: Bloqueio de Pedido por Estoque Esgotado (ITEM_OUT_OF_STOCK) ---');
// 3.1 Tentando pedir 2 Chopps, mas só resta 1 no estoque
await assert.rejects(
  async () => {
    await runAs(null, {}, async () => {
      await q(`select public.create_direct_table_order('${testTableId}', '${testProductId}', 2);`);
    });
  },
  /ITEM_OUT_OF_STOCK/
);

// 3.2 Cliente pede o último 1 Chopp disponível
await runAs(null, {}, async () => {
  await q(`select public.create_direct_table_order('${testTableId}', '${testProductId}', 1);`);
});

await runAs(testAdminId, {}, async () => {
  const invRow = (await q(`select current_quantity from public.inventory_items where id = '${testInventoryItemId}';`))[0];
  assert.equal(Number(invRow.current_quantity), 0, 'Estoque agora deve ser 0');
});

await runAs(null, {}, async () => {
  // Cardápio público agora deve reportar isOutOfStock = true
  const menuRes = await q(`select public.get_public_menu('burger-co') as menu;`);
  const prod = menuRes[0].menu.products.find(p => p.id === testProductId);
  assert.equal(prod.isOutOfStock, true, 'isOutOfStock deve ser true quando quantidade é zero');

  // Pedir novamente com estoque zero deve ser rejeitado
  await assert.rejects(
    async () => {
      await q(`select public.create_direct_table_order('${testTableId}', '${testProductId}', 1);`);
    },
    /ITEM_OUT_OF_STOCK/
  );
});
console.log('PASS: Rejeição imediata por falta de estoque e projeção isOutOfStock no cardápio.');

console.log('--- TESTE 4: Solicitação de Assistência ("call_waiter" / "close_table_request") e Anti-spam ---');
await runAs(null, {}, async () => {
  // 1. Chamar garçom
  const assist1 = (await q(`select public.request_table_assistance('${testTableId}', 'call_waiter') as res;`))[0].res;
  assert.equal(assist1.success, true);
  assert.equal(assist1.throttled, false);

  // 2. Chamar novamente imediatamente (deve acionar anti-spam)
  const assistThrottled = (await q(`select public.request_table_assistance('${testTableId}', 'call_waiter') as res;`))[0].res;
  assert.equal(assistThrottled.success, true);
  assert.equal(assistThrottled.throttled, true);

  // 3. Solicitar encerramento da conta
  const closeReq = (await q(`select public.request_table_assistance('${testTableId}', 'close_table_request') as res;`))[0].res;
  assert.equal(closeReq.success, true);
  assert.equal(closeReq.throttled, false);
});
console.log('PASS: request_table_assistance disparou alertas com trava anti-spam de 3 minutos.');

console.log('--- TESTE 5: Reset e Liberação da Mesa (reset_and_release_table) ---');
// 5.1 Usuário anônimo/estranho não pode liberar mesa
await runAs(null, {}, async () => {
  await assert.rejects(
    async () => {
      await q(`select public.reset_and_release_table('${testTableId}');`);
    },
    /permission denied|Acesso não autorizado/i
  );
});

// 5.2 Administrador do restaurante libera a mesa
await runAs(testAdminId, {}, async () => {
  const releaseRes = (await q(`select public.reset_and_release_table('${testTableId}') as res;`))[0].res;
  assert.equal(releaseRes.success, true);
  assert.equal(releaseRes.tableNumber, 3);

  // Verificar se o atendimento e a comanda foram fechados
  const visits = await q(`select * from public.table_visits where restaurant_table_id = '${testTableId}' and status = 'open';`);
  assert.equal(visits.length, 0, 'Não deve haver atendimentos abertos');

  const tabs = await q(`select * from public.table_tabs where restaurant_table_id = '${testTableId}' and status = 'open';`);
  assert.equal(tabs.length, 0, 'Não deve haver comandas abertas');

  // Verificar se os alertas da mesa foram marcados como lidos
  const unreadAlerts = await q(`select * from public.restaurant_alerts where reference_id = '${testTableId}' and is_read = false;`);
  assert.equal(unreadAlerts.length, 0, 'Todos os alertas da mesa devem ter sido marcados como lidos');
});
console.log('PASS: reset_and_release_table limpou e liberou a mesa com sucesso sem fluxo financeiro.');

console.log('\n>>> TODOS OS TESTES DO BLOCO 17 FORAM APROVADOS COM SUCESSO! <<<');
