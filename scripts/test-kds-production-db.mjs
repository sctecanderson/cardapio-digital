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

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 9.1 (KDS) ---');
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

async function runAsStaff(userId, role, fn) {
  const claims = JSON.stringify({
    sub: userId,
    is_anonymous: false,
    role: 'authenticated',
  });
  await db.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${userId}', false);
    select set_config('request.jwt.claims', '${claims}', false);
  `);
  try {
    return await fn();
  } finally {
    await db.exec(`
      set role none;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claims', '{}', false);
    `);
  }
}

async function runAsAnon(userId, fn) {
  const claims = JSON.stringify({
    sub: userId || '',
    is_anonymous: true,
    role: 'anon',
  });
  await db.exec(`
    set role anon;
    select set_config('request.jwt.claim.sub', '${userId || ''}', false);
    select set_config('request.jwt.claims', '${claims}', false);
  `);
  try {
    return await fn();
  } finally {
    await db.exec(`
      set role none;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claims', '{}', false);
    `);
  }
}

// -----------------------------------------------------------------------------
// Setup de Restaurantes, Usuários, Equipes, Mesas e Visitas
// -----------------------------------------------------------------------------
const nomaAdminUser = '80000000-0000-4000-8000-000000000001';
const nomaWaiterUser = '80000000-0000-4000-8000-000000000002';
const nomaInactiveUser = '80000000-0000-4000-8000-000000000003';
const restBAdminUser = '80000000-0000-4000-8000-000000000010';
const anonUser = '90000000-0000-4000-8000-000000000001';

const [{ id: nomaId, slug: nomaSlug }] = await q("select id, slug from public.restaurants where slug = 'noma'");

// Criar Restaurante B
const [{ id: restBId }] = await q(`
  insert into public.restaurants (slug, name, active)
  values ('rest-b', 'Restaurante B', true)
  returning id;
`);

// Inserir usuários no auth.users
await db.exec(`
  insert into auth.users (id, is_anonymous) values
    ('${nomaAdminUser}', false),
    ('${nomaWaiterUser}', false),
    ('${nomaInactiveUser}', false),
    ('${restBAdminUser}', false),
    ('${anonUser}', true)
  on conflict (id) do nothing;
`);

// Inserir membros
const [{ id: nomaAdminMemberId }] = await q(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${nomaId}', '${nomaAdminUser}', 'admin', true)
  returning id;
`);

const [{ id: nomaWaiterMemberId }] = await q(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${nomaId}', '${nomaWaiterUser}', 'waiter', true)
  returning id;
`);

const [{ id: nomaInactiveMemberId }] = await q(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${nomaId}', '${nomaInactiveUser}', 'waiter', false)
  returning id;
`);

const [{ id: restBMemberId }] = await q(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${restBId}', '${restBAdminUser}', 'admin', true)
  returning id;
`);

// Mesas
const [{ id: nomaTable1Id }] = await q(`
  select id from public.restaurant_tables where restaurant_id = '${nomaId}' order by table_number limit 1;
`);

// Mesas para Noma e Restaurante B (mesas 1 a 20)
await db.exec(`
  insert into public.restaurant_tables (restaurant_id, table_number)
  select '${nomaId}', s from generate_series(1, 20) s
  on conflict (restaurant_id, table_number) do nothing;

  insert into public.restaurant_tables (restaurant_id, table_number)
  select '${restBId}', s from generate_series(1, 20) s
  on conflict (restaurant_id, table_number) do nothing;
`);

// Produtos do Noma
const [{ id: nomaProdKitchenId }] = await q(`
  select id from public.menu_products
  where restaurant_id = '${nomaId}' and catalog_key = 'noma-risoto';
`);

const [{ id: nomaProdNoneId }] = await q(`
  update public.menu_products
  set preparation_station = 'none', available = true
  where restaurant_id = '${nomaId}' and catalog_key = 'noma-agua'
  returning id;
`);

// Criar produto 'bar' no Noma sob a categoria de bebidas
const [{ id: nomaProdBarId }] = await q(`
  insert into public.menu_products (
    restaurant_id, category_id, catalog_key, slug, name, short_description,
    description, price_in_cents, available, featured, sort_order, preparation_station
  )
  select
    '${nomaId}', category_id, 'noma-drink-especial', 'drink-especial', 'Drink Especial',
    'Drink artesanal', 'Drink artesanal', 3500, true, false, 99, 'bar'
  from public.menu_products where id = '${nomaProdNoneId}'
  returning id;
`);

// Helper para criar visita e comanda aberta via RPCs oficiais
let tableCounter = 1;
async function createOpenVisitAndTab(slug, waiterUserId) {
  const tableNum = tableCounter++;
  const [visit] = await runAsStaff(waiterUserId, 'waiter', async () => {
    return await q(`select * from public.open_table_visit($1, $2)`, [slug, tableNum]);
  });
  const tabId = crypto.randomUUID();
  const [tab] = await runAsStaff(waiterUserId, 'waiter', async () => {
    return await q(`select * from public.create_table_tab($1, $2, $3, $4)`, [slug, visit.id, `Mesa ${tableNum}`, tabId]);
  });
  return { visitId: visit.id, tabId };
}

// Helper para adicionar item
async function addItem(slug, tabId, prodId, qty, waiterUserId) {
  const itemId = crypto.randomUUID();
  const [item] = await runAsStaff(waiterUserId, 'waiter', async () => {
    return await q(
      `select * from public.add_table_tab_item($1, $2, $3, $4, $5)`,
      [slug, tabId, prodId, qty, itemId]
    );
  });
  return item;
}

// -----------------------------------------------------------------------------
// Teste 1: Fluxo Feliz Completo
// -----------------------------------------------------------------------------
console.log('--- Teste 1: Fluxo Feliz Completo (pending -> preparing -> ready -> delivered) ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const item = await addItem(nomaSlug, tabId, nomaProdKitchenId, 1, nomaWaiterUser);

  assert.equal(item.production_status, 'pending', 'Item novo deve ter production_status = pending');
  assert.equal(item.preparation_station, 'kitchen', 'Item de prato deve herdar preparation_station = kitchen');
  assert.equal(item.prep_started_at, null, 'prep_started_at inicial deve ser nulo');
  assert.equal(item.prep_ready_at, null, 'prep_ready_at inicial deve ser nulo');
  assert.equal(item.prep_delivered_at, null, 'prep_delivered_at inicial deve ser nulo');
  assert.equal(item.prepared_by_member_id, null, 'prepared_by_member_id inicial deve ser nulo');

  // Transição 1: pending -> preparing (acionada pelo cozinheiro/admin)
  const [prepItem] = await runAsStaff(nomaAdminUser, 'admin', async () => {
    return await q(
      `select * from public.update_tab_item_production_status($1, $2, $3)`,
      [nomaSlug, item.id, 'preparing']
    );
  });
  assert.equal(prepItem.production_status, 'preparing');
  assert.ok(prepItem.prep_started_at !== null, 'prep_started_at deve ser preenchido');
  assert.equal(prepItem.prepared_by_member_id, nomaAdminMemberId, 'prepared_by_member_id deve registrar quem iniciou');
  assert.equal(prepItem.prep_ready_at, null);
  assert.equal(prepItem.prep_delivered_at, null);

  // Transição 2: preparing -> ready
  const [readyItem] = await runAsStaff(nomaAdminUser, 'admin', async () => {
    return await q(
      `select * from public.update_tab_item_production_status($1, $2, $3)`,
      [nomaSlug, item.id, 'ready']
    );
  });
  assert.equal(readyItem.production_status, 'ready');
  assert.ok(readyItem.prep_ready_at !== null, 'prep_ready_at deve ser preenchido');
  assert.equal(new Date(readyItem.prep_started_at).toISOString(), new Date(prepItem.prep_started_at).toISOString(), 'prep_started_at deve ser preservado');
  assert.equal(readyItem.prepared_by_member_id, nomaAdminMemberId, 'prepared_by_member_id deve ser preservado');
  assert.equal(readyItem.prep_delivered_at, null);

  // Transição 3: ready -> delivered (entregue pelo garçom)
  const [deliveredItem] = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(
      `select * from public.update_tab_item_production_status($1, $2, $3)`,
      [nomaSlug, item.id, 'delivered']
    );
  });
  assert.equal(deliveredItem.production_status, 'delivered');
  assert.ok(deliveredItem.prep_delivered_at !== null, 'prep_delivered_at deve ser preenchido');
  assert.equal(new Date(deliveredItem.prep_started_at).toISOString(), new Date(prepItem.prep_started_at).toISOString(), 'prep_started_at preservado');
  assert.equal(new Date(deliveredItem.prep_ready_at).toISOString(), new Date(readyItem.prep_ready_at).toISOString(), 'prep_ready_at preservado');
  assert.equal(deliveredItem.prepared_by_member_id, nomaAdminMemberId, 'prepared_by_member_id preservado');

  console.log('PASS: Fluxo feliz completo validado com rastreabilidade integral de timestamps e membro.');
}

// -----------------------------------------------------------------------------
// Teste 2: Máquina de Estados Bloqueada (Saltos e Retrocessos Inválidos)
// -----------------------------------------------------------------------------
console.log('\n--- Teste 2: Máquina de Estados Bloqueada (Saltos e Retrocessos Inválidos) ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const item = await addItem(nomaSlug, tabId, nomaProdKitchenId, 1, nomaWaiterUser);

  // Em pending: saltar direto para ready deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'ready']);
      });
    },
    (err) => err.code === '22023',
    'Salto pending -> ready deve falhar com 22023'
  );

  // Em pending: saltar direto para delivered em item 'kitchen' deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'delivered']);
      });
    },
    (err) => err.code === '22023',
    'Salto pending -> delivered em item com preparo deve falhar com 22023'
  );

  // Avançar para preparing
  await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'preparing']);
  });

  // Em preparing: retroceder para pending deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'pending']);
      });
    },
    (err) => err.code === '22023',
    'Retrocesso preparing -> pending deve falhar com 22023'
  );

  // Em preparing: saltar direto para delivered deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'delivered']);
      });
    },
    (err) => err.code === '22023',
    'Salto preparing -> delivered deve falhar com 22023'
  );

  // Avançar para ready
  await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'ready']);
  });

  // Em ready: retroceder para preparing ou pending deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'preparing']);
      });
    },
    (err) => err.code === '22023',
    'Retrocesso ready -> preparing deve falhar com 22023'
  );
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'pending']);
      });
    },
    (err) => err.code === '22023',
    'Retrocesso ready -> pending deve falhar com 22023'
  );

  // Avançar para delivered
  await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'delivered']);
  });

  // Em delivered: qualquer alteração deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'ready']);
      });
    },
    (err) => err.code === '22023',
    'Retrocesso delivered -> ready deve falhar com 22023'
  );
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [nomaSlug, item.id, 'pending']);
      });
    },
    (err) => err.code === '22023',
    'Retrocesso delivered -> pending deve falhar com 22023'
  );

  console.log('PASS: Máquina de estados bloqueou rigorosamente todos os saltos e retrocessos ilegais (22023).');
}

// -----------------------------------------------------------------------------
// Teste 3: Imutabilidade de Cancelamento
// -----------------------------------------------------------------------------
console.log('\n--- Teste 3: Imutabilidade de Item Cancelado ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const item = await addItem(nomaSlug, tabId, nomaProdKitchenId, 1, nomaWaiterUser);

  // Cancelar o item pelo garçom responsável
  const [cancelledItem] = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(`select * from public.cancel_table_tab_item($1, $2, $3)`, [
      nomaSlug,
      item.id,
      'Cliente desistiu do prato',
    ]);
  });
  assert.equal(cancelledItem.status, 'cancelled');

  // Tentativa de alterar estado de produção de item cancelado deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
          nomaSlug,
          item.id,
          'preparing',
        ]);
      });
    },
    (err) => err.code === '22023',
    'Item cancelado não pode ter produção alterada'
  );

  console.log('PASS: Item com status = cancelled está imutável para a esteira de produção (22023).');
}

// -----------------------------------------------------------------------------
// Teste 4: Imutabilidade de Comanda Fechada
// -----------------------------------------------------------------------------
console.log('\n--- Teste 4: Imutabilidade de Comanda Fechada ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const item = await addItem(nomaSlug, tabId, nomaProdKitchenId, 1, nomaWaiterUser);

  // Fechar a comanda
  const [closedTab] = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(`select * from public.close_table_tab($1, $2, false)`, [nomaSlug, tabId]);
  });
  assert.equal(closedTab.status, 'closed');

  // Tentativa de alterar produção de item em comanda fechada deve falhar (22023)
  await assert.rejects(
    async () => {
      await runAsStaff(nomaWaiterUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
          nomaSlug,
          item.id,
          'preparing',
        ]);
      });
    },
    (err) => err.code === '22023',
    'Comanda encerrada proíbe alteração de produção de seus itens'
  );

  console.log('PASS: Comanda com status = closed proíbe alteração de produção em seus itens (22023).');
}

// -----------------------------------------------------------------------------
// Teste 5: Isolamento Multi-Tenant
// -----------------------------------------------------------------------------
console.log('\n--- Teste 5: Isolamento Multi-Tenant ---');
{
  const { tabId: tabIdA } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const itemA = await addItem(nomaSlug, tabIdA, nomaProdKitchenId, 1, nomaWaiterUser);

  // Membro do Restaurante B tentando operar item do Restaurante A usando o slug do Restaurante B
  await assert.rejects(
    async () => {
      await runAsStaff(restBAdminUser, 'admin', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
          'rest-b',
          itemA.id,
          'preparing',
        ]);
      });
    },
    (err) => err.code === '42501',
    'Membro de restaurante B não pode alterar item de restaurante A (42501)'
  );

  // Membro do Restaurante B tentando operar usando o slug do Restaurante A
  await assert.rejects(
    async () => {
      await runAsStaff(restBAdminUser, 'admin', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
          nomaSlug,
          itemA.id,
          'preparing',
        ]);
      });
    },
    (err) => err.code === '42501',
    'Membro sem vínculo no Restaurante A deve ser bloqueado com 42501'
  );

  console.log('PASS: Isolamento multi-tenant garantido com código 42501.');
}

// -----------------------------------------------------------------------------
// Teste 6: Membro Inativo / Anônimo
// -----------------------------------------------------------------------------
console.log('\n--- Teste 6: Membro Inativo / Anônimo Bloqueados (42501) ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const item = await addItem(nomaSlug, tabId, nomaProdKitchenId, 1, nomaWaiterUser);

  // Chamada anônima
  await assert.rejects(
    async () => {
      await runAsAnon(anonUser, async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
          nomaSlug,
          item.id,
          'preparing',
        ]);
      });
    },
    (err) => err.code === '42501',
    'Usuário anônimo deve ser barrado com 42501'
  );

  // Chamada de membro inativo
  await assert.rejects(
    async () => {
      await runAsStaff(nomaInactiveUser, 'waiter', async () => {
        await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
          nomaSlug,
          item.id,
          'preparing',
        ]);
      });
    },
    (err) => err.code === '42501',
    'Membro com active = false deve ser barrado com 42501'
  );

  console.log('PASS: Usuários anônimos e membros inativos bloqueados estritamente com 42501.');
}

// -----------------------------------------------------------------------------
// Teste 7: Estação 'none' (Item sem preparo avança direto para delivered)
// -----------------------------------------------------------------------------
console.log('\n--- Teste 7: Estação "none" (Item sem preparo já nasce delivered imediatamente) ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const itemNone = await addItem(nomaSlug, tabId, nomaProdNoneId, 2, nomaWaiterUser);

  assert.equal(itemNone.preparation_station, 'none', 'Item deve ter preparation_station = none');
  assert.equal(itemNone.production_status, 'delivered', 'Item com estacao none ja nasce entregue (delivered)');
  assert.ok(itemNone.prep_delivered_at !== null, 'prep_delivered_at deve ser preenchido imediatamente');
  assert.equal(itemNone.prep_started_at, null, 'prep_started_at permanece nulo');
  assert.equal(itemNone.prep_ready_at, null, 'prep_ready_at permanece nulo');

  console.log('PASS: Item com estação "none" já é criado como delivered com prep_delivered_at registrado.');
}

// -----------------------------------------------------------------------------
// Teste 8: Validação do Cadastro de Produtos (save_menu_product com preparation_station)
// -----------------------------------------------------------------------------
console.log('\n--- Teste 8: Salvar Produto com Estação de Preparo (save_menu_product) ---');
{
  // 1. Atualizar produto existente para bar
  const [cat] = await q(`select id from public.menu_categories where restaurant_id = $1 limit 1`, [nomaId]);
  const newProdId = 'd8888888-8888-8888-8888-888888888888';

  const productPayloadBar = JSON.stringify({
    category_id: cat.id,
    name: 'Caipirinha Especial',
    slug: 'caipirinha-especial',
    short_description: 'Cachaça artesanal e limão tahiti',
    description: 'Bebida preparada no bar com gelo e açúcar orgânico',
    price_in_cents: 2800,
    available: true,
    featured: false,
    sort_order: 10,
    preparation_station: 'bar',
  });

  const [savedProdId] = await runAsStaff(nomaAdminUser, 'admin', async () => {
    return await q(`select public.save_menu_product($1, $2, $3, $4::jsonb) as id`, [
      nomaSlug,
      newProdId,
      0,
      productPayloadBar,
    ]);
  });

  assert.equal(savedProdId.id, newProdId);

  const [persistedProd] = await q(`select preparation_station from public.menu_products where id = $1`, [newProdId]);
  assert.equal(persistedProd.preparation_station, 'bar', 'Produto salvo deve persistir preparation_station = bar');

  // 2. Rejeitar estação inválida com erro 22023
  const invalidPayload = JSON.stringify({
    category_id: cat.id,
    name: 'Produto Invalido',
    slug: 'prod-invalido',
    short_description: 'Desc',
    description: 'Desc',
    price_in_cents: 1000,
    available: true,
    featured: false,
    sort_order: 11,
    preparation_station: 'espaco_sideral',
  });

  await assert.rejects(
    async () => {
      await runAsStaff(nomaAdminUser, 'admin', async () => {
        await q(`select public.save_menu_product($1, $2, $3, $4::jsonb)`, [
          nomaSlug,
          'd9999999-9999-9999-9999-999999999999',
          0,
          invalidPayload,
        ]);
      });
    },
    (err) => err.code === '22023',
    'Estação inválida deve falhar com código 22023'
  );

  console.log('PASS: Estação de preparo persistida e validada no cadastro de produtos.');
}

// -----------------------------------------------------------------------------
// Teste 9: get_table_tab_consumption com Metadados KDS e Entrega pelo Garçom
// -----------------------------------------------------------------------------
console.log('\n--- Teste 9: get_table_tab_consumption expõe campos KDS e Garçom entrega na mesa ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const item = await addItem(nomaSlug, tabId, nomaProdKitchenId, 1, nomaWaiterUser);

  // Avança para ready
  await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
      nomaSlug,
      item.id,
      'preparing',
    ]);
    await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
      nomaSlug,
      item.id,
      'ready',
    ]);
  });

  // Consulta consumo da comanda via RPC
  const [consumptionJson] = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(`select public.get_table_tab_consumption($1, $2) as res`, [
      nomaId,
      tabId,
    ]);
  });

  const parsed = typeof consumptionJson.res === 'string' ? JSON.parse(consumptionJson.res) : consumptionJson.res;
  const items = parsed.items;
  assert.ok(items.length >= 1, 'Deve retornar itens na comanda');

  const readyItem = items.find((i) => i.id === item.id);
  assert.equal(readyItem.production_status, 'ready', 'Item deve retornar production_status = ready');
  assert.equal(readyItem.preparation_station, 'kitchen', 'Item deve retornar preparation_station = kitchen');
  assert.ok(readyItem.prep_ready_at !== null, 'Item deve ter prep_ready_at preenchido');

  // Garçom confirma entrega na mesa
  const [deliveredItem] = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(`select * from public.update_tab_item_production_status($1, $2, $3)`, [
      nomaSlug,
      item.id,
      'delivered',
    ]);
  });

  assert.equal(deliveredItem.production_status, 'delivered', 'Item deve avançar para delivered');
  assert.ok(deliveredItem.prep_delivered_at !== null, 'prep_delivered_at deve ser registrado');

  console.log('PASS: Consulta de consumo expõe campos KDS e Garçom realiza entrega na mesa com sucesso.');
}

// -----------------------------------------------------------------------------
// Teste 10: add_table_tab_item com produto preparation_station = 'none' nasce delivered
// -----------------------------------------------------------------------------
console.log('\n--- Teste 10: add_table_tab_item com preparation_station = none nasce delivered ---');
{
  const { tabId } = await createOpenVisitAndTab(nomaSlug, nomaWaiterUser);
  const noneItem = await addItem(nomaSlug, tabId, nomaProdNoneId, 2, nomaWaiterUser);

  assert.equal(noneItem.production_status, 'delivered', 'Produto com estacao none deve nascer delivered');
  assert.equal(noneItem.preparation_station, 'none', 'Produto deve ter preparation_station = none');
  assert.ok(noneItem.prep_delivered_at !== null, 'Item none deve registrar prep_delivered_at no momento do lancamento');

  // Verifica que o item nasce entregue e não fica na fila de preparo (pending/preparing/ready)
  const [persistedItem] = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(`select * from public.table_tab_items where id = $1`, [noneItem.id]);
  });
  assert.equal(persistedItem.production_status, 'delivered', 'Item none deve estar persistido como delivered');
  assert.ok(persistedItem.prep_delivered_at !== null, 'Item none deve ter prep_delivered_at persistido');

  const pendingOrPreparingKds = await runAsStaff(nomaWaiterUser, 'waiter', async () => {
    return await q(
      `select * from public.table_tab_items
       where id = $1 and production_status in ('pending', 'preparing', 'ready')`,
      [noneItem.id]
    );
  });
  assert.equal(pendingOrPreparingKds.length, 0, 'Item none nao deve figurar nas filas ativas de preparo KDS');

  console.log('PASS: Item com estacao none nasce delivered, com prep_delivered_at e nao polui filas KDS.');
}

console.log('\n======================================================');
console.log('TODOS OS 10 TESTES DE INTEGRAÇÃO KDS FORAM APROVADOS!');
console.log('======================================================');
