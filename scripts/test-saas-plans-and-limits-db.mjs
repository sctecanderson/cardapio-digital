import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 11.2 (Planos SaaS e Limites) ---');
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
// SETUP: SuperAdmin, Usuário Comum, e Restaurante de Teste
// ----------------------------------------------------------------------------
const superAdminId = '90000000-0000-4000-8000-000000000001';
const regularUserId = '90000000-0000-4000-8000-000000000002';
const testRestaurantId = '90000000-0000-4000-8000-000000000010';

await db.exec(`
  insert into auth.users (id, email, is_anonymous) values
    ('${superAdminId}', 'superadmin@elozi.com', false),
    ('${regularUserId}', 'admin@cantina.com', false);

  insert into public.platform_admins (user_id, active) values
    ('${superAdminId}', true);

  insert into public.restaurants (id, name, slug, active) values
    ('${testRestaurantId}', 'Cantina do Teste', 'cantina-teste', true);

  insert into public.restaurant_members (restaurant_id, user_id, role, active) values
    ('${testRestaurantId}', '${regularUserId}', 'admin', true);
`);

// ----------------------------------------------------------------------------
// Teste 1: Estado Inicial do Restaurante (Padrões do Plano Básico)
// ----------------------------------------------------------------------------
console.log('\n--- Teste 1: Estado Inicial e Projeção do Plano Básico ---');
const [initialRest] = await q(`
  select subscription_plan, monthly_price_cents, max_tables
  from public.restaurants
  where id = '${testRestaurantId}';
`);

assert.equal(initialRest.subscription_plan, 'basic', 'Plano padrão deve ser basic');
assert.equal(initialRest.monthly_price_cents, 9900, 'Preço padrão deve ser 9900 (R$ 99,00)');
assert.equal(initialRest.max_tables, 10, 'Limite padrão de mesas deve ser 10');
console.log('PASS: Padrões de plano SaaS verificados com sucesso (basic, R$ 99,00, 10 mesas).');

// ----------------------------------------------------------------------------
// Teste 2: SuperAdmin lista restaurantes com list_platform_restaurants
// ----------------------------------------------------------------------------
console.log('\n--- Teste 2: Projeção de Planos e Mesas em list_platform_restaurants ---');
const listResult = await runAs(superAdminId, {}, async () => {
  const [{ list_platform_restaurants: data }] = await q(`select public.list_platform_restaurants();`);
  return data;
});

const found = listResult.find((r) => r.id === testRestaurantId);
assert.ok(found, 'Restaurante deve estar na listagem do SuperAdmin');
assert.equal(found.subscriptionPlan, 'basic', 'subscriptionPlan deve ser projetado');
assert.equal(found.monthlyPriceCents, 9900, 'monthlyPriceCents deve ser projetado');
assert.equal(found.maxTables, 10, 'maxTables deve ser projetado');
assert.equal(found.activeTablesCount, 0, 'activeTablesCount inicial deve ser 0');
console.log('PASS: list_platform_restaurants projeta subscriptionPlan, monthlyPriceCents, maxTables e activeTablesCount.');

// ----------------------------------------------------------------------------
// Teste 3: Usuário Comum / Anônimo Bloqueado ao tentar chamar update_restaurant_saas_plan (42501)
// ----------------------------------------------------------------------------
console.log('\n--- Teste 3: Segurança: Usuário Comum e Anônimo Bloqueados (42501) ---');
await assert.rejects(
  async () => {
    await runAs(null, {}, async () => {
      await q(`select public.update_restaurant_saas_plan('${testRestaurantId}', 'pro');`);
    });
  },
  (err) => err.code === '42501',
  'Anônimo deve ser bloqueado com 42501',
);

await assert.rejects(
  async () => {
    await runAs(regularUserId, {}, async () => {
      await q(`select public.update_restaurant_saas_plan('${testRestaurantId}', 'pro');`);
    });
  },
  (err) => err.code === '42501',
  'Usuário autenticado não-SuperAdmin deve ser bloqueado com 42501',
);
console.log('PASS: Bloqueio 42501 estrito para acessos não autorizados em update_restaurant_saas_plan.');

// ----------------------------------------------------------------------------
// Teste 4: Limite de Mesas do Plano Básico (Trigger de Enforcement P0001)
// ----------------------------------------------------------------------------
console.log('\n--- Teste 4: Enforcement de Limite de Mesas no Banco (P0001) ---');
// Inserir 10 mesas (limite do basic)
for (let i = 1; i <= 10; i++) {
  await q(`
    insert into public.restaurant_tables (restaurant_id, table_number, label, active)
    values ('${testRestaurantId}', ${i}, 'Mesa ${i}', true);
  `);
}

const [{ count: currentCount }] = await q(`
  select count(*) from public.restaurant_tables where restaurant_id = '${testRestaurantId}';
`);
assert.equal(Number(currentCount), 10, 'Deve ter inserido exatamente 10 mesas');

// Tentar inserir a 11ª mesa em restaurant_tables: DEVE FALHAR COM P0001
await assert.rejects(
  async () => {
    await q(`
      insert into public.restaurant_tables (restaurant_id, table_number, label, active)
      values ('${testRestaurantId}', 11, 'Mesa 11', true);
    `);
  },
  (err) => {
    assert.equal(err.code, 'P0001');
    assert.match(err.message, /Limite de 10 mesas (ativas )?do plano atual atingido/);
    return true;
  },
  'Tentativa de exceder max_tables deve lançar P0001',
);

// Tentar inserir na view dining_tables: DEVE FALHAR COM P0001
await assert.rejects(
  async () => {
    await q(`
      insert into public.dining_tables (restaurant_id, table_number, label, active)
      values ('${testRestaurantId}', 11, 'Mesa 11', true);
    `);
  },
  (err) => {
    assert.equal(err.code, 'P0001');
    return true;
  },
  'Inserção na view dining_tables além do limite deve lançar P0001',
);
console.log('PASS: Bloqueio automático P0001 confirmado ao tentar inserir além de max_tables.');

// ----------------------------------------------------------------------------
// Teste 5: Upgrade de Plano pelo SuperAdmin (update_restaurant_saas_plan)
// ----------------------------------------------------------------------------
console.log('\n--- Teste 5: Upgrade de Plano pelo SuperAdmin (Básico -> Pro) ---');
const updatedPro = await runAs(superAdminId, {}, async () => {
  const [{ update_restaurant_saas_plan: data }] = await q(`
    select public.update_restaurant_saas_plan('${testRestaurantId}', 'pro');
  `);
  return data;
});

assert.equal(updatedPro.subscriptionPlan, 'pro', 'Plano deve ser atualizado para pro');
assert.equal(updatedPro.monthlyPriceCents, 14900, 'Preço padrão do pro deve ser 14900 (R$ 149,00)');
assert.equal(updatedPro.maxTables, 25, 'Limite do pro deve ser 25 mesas');
assert.equal(updatedPro.activeTablesCount, 10, 'Contagem de mesas ativas deve ser 10');

// Agora inserir a mesa 11 e mesa 12 DEVE FUNCIONAR!
await db.exec(`
  insert into public.restaurant_tables (restaurant_id, table_number, label, active)
  values ('${testRestaurantId}', 11, 'Mesa 11', true);

  insert into public.dining_tables (restaurant_id, table_number, label, active)
  values ('${testRestaurantId}', 12, 'Mesa 12', true);
`);

const [{ count: newCount }] = await q(`
  select count(*) from public.restaurant_tables where restaurant_id = '${testRestaurantId}';
`);
assert.equal(Number(newCount), 12, 'Deve ter 12 mesas configuradas após upgrade');
console.log('PASS: Upgrade para plano Pro permite expansão do salão até 25 mesas.');

// ----------------------------------------------------------------------------
// Teste 6: Upgrade para Premium e Valores Customizados
// ----------------------------------------------------------------------------
console.log('\n--- Teste 6: Upgrade para Premium com Valores Padrão e Customizados ---');
const updatedPremium = await runAs(superAdminId, {}, async () => {
  const [{ update_restaurant_saas_plan: data }] = await q(`
    select public.update_restaurant_saas_plan('${testRestaurantId}', 'premium');
  `);
  return data;
});

assert.equal(updatedPremium.subscriptionPlan, 'premium');
assert.equal(updatedPremium.monthlyPriceCents, 19900);
assert.equal(updatedPremium.maxTables, 100);

// Plano com valor customizado (negociação especial pelo SuperAdmin)
const updatedCustom = await runAs(superAdminId, {}, async () => {
  const [{ update_restaurant_saas_plan: data }] = await q(`
    select public.update_restaurant_saas_plan('${testRestaurantId}', 'premium', 24900, 150);
  `);
  return data;
});

assert.equal(updatedCustom.subscriptionPlan, 'premium');
assert.equal(updatedCustom.monthlyPriceCents, 24900);
assert.equal(updatedCustom.maxTables, 150);
// ----------------------------------------------------------------------------
// Teste 7: Configurações da Plataforma e Branding (platform_settings)
// ----------------------------------------------------------------------------
console.log('\n--- Teste 7: Configurações da Plataforma e Branding (platform_settings) ---');
const initialBranding = await runAs(null, {}, async () => {
  const [{ get_platform_branding: data }] = await q(`select public.get_platform_branding();`);
  return data;
});

assert.equal(initialBranding.platformName, 'Elozi');
assert.equal(initialBranding.superadminName, 'SuperAdmin');
assert.equal(initialBranding.platformLogoUrl, null);
assert.equal(initialBranding.superadminAvatarUrl, null);
console.log('PASS: Leitura inicial de branding confirmada.');

// Bloqueio de escrita para anônimo e usuário comum
await assert.rejects(
  async () => {
    await runAs(null, {}, async () => {
      await q(`select public.update_platform_branding('Hacked Name');`);
    });
  },
  (err) => err.code === '42501',
  'Anônimo não pode alterar branding da plataforma',
);

await assert.rejects(
  async () => {
    await runAs(regularUserId, {}, async () => {
      await q(`select public.update_platform_branding('Hacked Name');`);
    });
  },
  (err) => err.code === '42501',
  'Usuário comum não pode alterar branding da plataforma',
);
console.log('PASS: Segurança 42501 estrita para update_platform_branding.');

// SuperAdmin atualiza branding com sucesso
const updatedBranding = await runAs(superAdminId, {}, async () => {
  const [{ update_platform_branding: data }] = await q(`
    select public.update_platform_branding(
      'Elozi Pro',
      'Painel Global de Controle',
      'data:image/webp;base64,mockLogoData',
      'Anderson',
      'data:image/webp;base64,mockAvatarData'
    );
  `);
  return data;
});

assert.equal(updatedBranding.platformName, 'Elozi Pro');
assert.equal(updatedBranding.platformSubtitle, 'Painel Global de Controle');
assert.equal(updatedBranding.platformLogoUrl, 'data:image/webp;base64,mockLogoData');
assert.equal(updatedBranding.superadminName, 'Anderson');
assert.equal(updatedBranding.superadminAvatarUrl, 'data:image/webp;base64,mockAvatarData');

// Restaurar padrões com flags de limpeza
const clearedBranding = await runAs(superAdminId, {}, async () => {
  const [{ update_platform_branding: data }] = await q(`
    select public.update_platform_branding(
      'Elozi',
      'Administração da Plataforma',
      null,
      'SuperAdmin',
      null,
      true,
      true
    );
  `);
  return data;
});

assert.equal(clearedBranding.platformLogoUrl, null);
assert.equal(clearedBranding.superadminAvatarUrl, null);
console.log('PASS: Atualização e restauração de branding do SuperAdmin validadas.');

// --- Teste 8: Edição Livre de Preço, Limite de Mesas e Ciclo de Vigência ---
console.log('\n--- Teste 8: Edição Livre de Preço, Limites de Mesas e Ciclo de Vigência (Bloco 11.4) ---');

const customPlanResult = await runAs(superAdminId, {}, async () => {
  const [{ update_restaurant_saas_plan: data }] = await q(`
    select public.update_restaurant_saas_plan(
      '${testRestaurantId}',
      'premium',
      30000,
      40,
      60,
      true
    );
  `);
  return data;
});

assert.equal(customPlanResult.monthlyPriceCents, 30000);
assert.equal(customPlanResult.maxTables, 40);
assert.equal(customPlanResult.billingCycleDays, 60);
assert.ok(customPlanResult.daysRemaining >= 59 && customPlanResult.daysRemaining <= 60);
console.log('PASS: Customização livre de preço (R$ 300,00) e renovação de ciclo (60 dias) confirmadas.');

// Validar que list_platform_restaurants projeta os novos campos de vigência
const listWithCycle = await runAs(superAdminId, {}, async () => {
  const [{ list_platform_restaurants: list }] = await q(`select public.list_platform_restaurants();`);
  return list;
});

const restInList = listWithCycle.find((r) => r.id === testRestaurantId);
assert.equal(restInList.monthlyPriceCents, 30000);
assert.equal(restInList.maxTables, 40);
assert.equal(restInList.billingCycleDays, 60);
assert.ok(restInList.daysRemaining >= 59 && restInList.daysRemaining <= 60);
assert.ok(restInList.subscriptionStartedAt);
assert.ok(restInList.subscriptionExpiresAt);
console.log('PASS: list_platform_restaurants projeta subscriptionStartedAt, subscriptionExpiresAt, billingCycleDays e daysRemaining.');

// --- Teste 9: Catálogo Global de Planos Editável (update_platform_plan_catalog) ---
console.log('\n--- Teste 9: Catálogo Global de Planos Editável (update_platform_plan_catalog) ---');

// Bloqueio 42501 para anônimo e usuário comum
await assert.rejects(
  async () => {
    await runAs(null, {}, async () => {
      await q(`select public.update_platform_plan_catalog(12000, 12, 18000, 30, 25000, 150);`);
    });
  },
  (err) => err.code === '42501',
  'Anônimo não pode alterar catálogo de planos',
);

await assert.rejects(
  async () => {
    await runAs(regularUserId, {}, async () => {
      await q(`select public.update_platform_plan_catalog(12000, 12, 18000, 30, 25000, 150);`);
    });
  },
  (err) => err.code === '42501',
  'Usuário comum não pode alterar catálogo de planos',
);
console.log('PASS: Bloqueio 42501 confirmado para update_platform_plan_catalog.');

// SuperAdmin atualiza catálogo sem sincronizar restaurantes existentes
const catalogResult = await runAs(superAdminId, {}, async () => {
  const [{ update_platform_plan_catalog: data }] = await q(`
    select public.update_platform_plan_catalog(
      11900,
      15,
      16900,
      35,
      24900,
      120,
      false
    );
  `);
  return data;
});

assert.equal(catalogResult.basicPriceCents, 11900);
assert.equal(catalogResult.basicMaxTables, 15);
assert.equal(catalogResult.proPriceCents, 16900);
assert.equal(catalogResult.proMaxTables, 35);
assert.equal(catalogResult.premiumPriceCents, 24900);
assert.equal(catalogResult.premiumMaxTables, 120);
assert.equal(catalogResult.syncedRestaurantsCount, 0);

// Verificar persistência em get_platform_branding()
const brandingWithCatalog = await runAs(superAdminId, {}, async () => {
  const [{ get_platform_branding: data }] = await q(`select public.get_platform_branding();`);
  return data;
});

assert.equal(brandingWithCatalog.basicPriceCents, 11900);
assert.equal(brandingWithCatalog.basicMaxTables, 15);
assert.equal(brandingWithCatalog.proPriceCents, 16900);
assert.equal(brandingWithCatalog.proMaxTables, 35);
assert.equal(brandingWithCatalog.premiumPriceCents, 24900);
assert.equal(brandingWithCatalog.premiumMaxTables, 120);
console.log('PASS: Catálogo global atualizado e refletido em get_platform_branding.');

// SuperAdmin atualiza catálogo COM sincronização de restaurantes existentes
const syncedResult = await runAs(superAdminId, {}, async () => {
  const [{ update_platform_plan_catalog: data }] = await q(`
    select public.update_platform_plan_catalog(
      12900,
      18,
      17900,
      40,
      26900,
      150,
      true
    );
  `);
  return data;
});

assert.ok(syncedResult.syncedRestaurantsCount > 0);

const syncedList = await runAs(superAdminId, {}, async () => {
  const [{ list_platform_restaurants: list }] = await q(`select public.list_platform_restaurants();`);
  return list;
});

const restUpdated = syncedList.find((r) => r.id === testRestaurantId);
if (restUpdated) {
  assert.equal(restUpdated.monthlyPriceCents, 26900); // Plano premium sincronizado
  assert.equal(restUpdated.maxTables, 150);
}
console.log('PASS: Sincronização em massa de restaurantes existentes validada com sucesso.');
console.log('PASS: Sincronização em massa de restaurantes existentes validada com sucesso.');

// --- Teste 10: Trava Efetiva de Mesas Ativas por Plano (Bloco 11.5) ---
console.log('\n--- Teste 10: Trava Efetiva de Mesas Ativas por Plano (Bloco 11.5) ---');

const quotaRestaurantId = '90000000-0000-4000-8000-000000000020';
await db.exec(`
  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables, monthly_price_cents)
  values ('${quotaRestaurantId}', 'Restaurante Cota', 'restaurante-cota', true, 'pro', 25, 14900);
`);

// Criar 20 mesas no restaurante (todas ativas inicialmente sob o plano 'pro' com max_tables = 25)
for (let i = 1; i <= 20; i++) {
  await db.exec(`
    insert into public.restaurant_tables (restaurant_id, table_number, label, active)
    values ('${quotaRestaurantId}', ${i}, 'Mesa ${i}', true);
  `);
}

const initialTables = await q(`
  select table_number, active, is_active
  from public.restaurant_tables
  where restaurant_id = '${quotaRestaurantId}'
  order by table_number asc;
`);
assert.equal(initialTables.length, 20);
assert.equal(initialTables.filter((t) => t.is_active).length, 20);
assert.equal(initialTables.filter((t) => t.active).length, 20);
console.log('PASS: 20 mesas criadas e ativas no plano Pro (max 25).');

// Downgrade para plano 'basic' (max_tables = 10) via update_restaurant_saas_plan
await runAs(superAdminId, {}, async () => {
  await q(`
    select public.update_restaurant_saas_plan(
      '${quotaRestaurantId}',
      'basic',
      9900,
      10,
      30,
      false
    );
  `);
});

// Verificar que exatamente 10 mesas permaneceram ativas (mesas 1 a 10) e 10 ficaram inativas (mesas 11 a 20)
const downgradedTables = await q(`
  select table_number, active, is_active
  from public.restaurant_tables
  where restaurant_id = '${quotaRestaurantId}'
  order by table_number asc;
`);

const activeDowngraded = downgradedTables.filter((t) => t.is_active);
const inactiveDowngraded = downgradedTables.filter((t) => !t.is_active);
assert.equal(activeDowngraded.length, 10, 'Devem restar exatamente 10 mesas ativas no plano Básico');
assert.equal(inactiveDowngraded.length, 10, 'Devem restar exatamente 10 mesas inativas no plano Básico');
assert.deepEqual(
  activeDowngraded.map((t) => t.table_number),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  'Mesas 1 a 10 devem estar ativas'
);
assert.deepEqual(
  inactiveDowngraded.map((t) => t.table_number),
  [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  'Mesas 11 a 20 devem estar inativas'
);
console.log('PASS: Downgrade sincronizou exatamente 10 mesas ativas e 10 inativas.');

// Tentar ativar a mesa 11 manualmente -> Deve disparar exceção P0001
await assert.rejects(
  async () => {
    await db.exec(`
      update public.restaurant_tables
      set is_active = true
      where restaurant_id = '${quotaRestaurantId}' and table_number = 11;
    `);
  },
  (err) => err.code === 'P0001' && err.message.includes('Limite de 10 mesas ativas do plano atual atingido'),
  'Ativação manual além do limite deve falhar com P0001'
);
console.log('PASS: UPDATE da 11ª mesa para is_active = true bloqueado com erro P0001.');

// Upgrade de volta para plano 'pro' (max_tables = 25)
await runAs(superAdminId, {}, async () => {
  await q(`
    select public.update_restaurant_saas_plan(
      '${quotaRestaurantId}',
      'pro',
      14900,
      25,
      30,
      false
    );
  `);
});

// Verificar que as 20 mesas foram reativadas automaticamente
const upgradedTables = await q(`
  select table_number, active, is_active
  from public.restaurant_tables
  where restaurant_id = '${quotaRestaurantId}'
  order by table_number asc;
`);

assert.equal(upgradedTables.filter((t) => t.is_active).length, 20, 'Todas as 20 mesas devem voltar a ficar ativas');
assert.equal(upgradedTables.filter((t) => t.active).length, 20, 'Todas as 20 mesas devem ter active = true');
console.log('PASS: Upgrade reativou automaticamente as mesas até o novo limite (20 ativas de 25 permitidas).');

// --- Teste 11: Exclusão Segura de Mesas, Bloqueio em Atendimento Aberto e Promoção Automática de Cota (Bloco 11.6) ---
console.log('\n--- Teste 11: Exclusão Segura de Mesas e Recálculo Automático de Cota (Bloco 11.6) ---');

// Vincular SuperAdmin como admin do restaurante para executar require_catalog_admin
await db.exec(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${quotaRestaurantId}', '${superAdminId}', 'admin', true)
  on conflict do nothing;
`);

// Colocar restaurante no plano 'basic' (limite 10 mesas): Mesas 1 a 10 ativas, 11 a 20 inativas
await runAs(superAdminId, {}, async () => {
  await q(`
    select public.update_restaurant_saas_plan(
      '${quotaRestaurantId}',
      'basic',
      9900,
      10,
      30,
      false
    );
  `);
});

// Criar atendimento aberto na Mesa 1
const [{ id: table1Id }] = await q(`
  select id from public.restaurant_tables
  where restaurant_id = '${quotaRestaurantId}' and table_number = 1;
`);

await db.exec(`
  insert into public.table_visits (restaurant_id, restaurant_table_id, status)
  values ('${quotaRestaurantId}', '${table1Id}', 'open');
`);

// 1. Tentar excluir a Mesa 1 com atendimento em aberto -> DEVE FALHAR COM P0001
await assert.rejects(
  async () => {
    await runAs(superAdminId, {}, async () => {
      await q(`select public.delete_restaurant_table('restaurante-cota', 1);`);
    });
  },
  (err) => err.code === 'P0001' && err.message.includes('Mesa com atendimento ativo. Feche a comanda antes de excluir.'),
  'Exclusão de mesa com atendimento aberto deve falhar com P0001'
);
console.log('PASS: Bloqueio de exclusão em mesa com visita aberta validado com sucesso.');

// 2. Encerrar o atendimento da Mesa 1
await db.exec(`
  update public.table_visits
  set status = 'closed', closed_at = timezone('utc', now())
  where restaurant_table_id = '${table1Id}' and status = 'open';
`);

// 3. Excluir a Mesa 1 (que possui histórico de atendimento fechado -> arquivamento seguro)
const deleteResult = await runAs(superAdminId, {}, async () => {
  const [{ delete_restaurant_table: res }] = await q(`
    select public.delete_restaurant_table('restaurante-cota', 1);
  `);
  return res;
});

assert.equal(deleteResult.success, true);
assert.equal(deleteResult.tableNumber, 1);
console.log('PASS: Exclusão segura da Mesa 1 realizada com sucesso.');

// 4. Verificar que a Mesa 1 não consta mais no get_admin_tables
const adminTablesAfterDelete = await runAs(superAdminId, {}, async () => {
  const [{ get_admin_tables: list }] = await q(`select public.get_admin_tables('restaurante-cota');`);
  return list;
});

assert.equal(adminTablesAfterDelete.some((t) => t.tableNumber === 1), false, 'Mesa 1 não deve constar na lista de mesas');

// 5. Verificar que a cota foi recalculada e a Mesa 11 foi AUTOMATICAMENTE PROMOVIDA a ativa
const activeTablesAfterDelete = adminTablesAfterDelete.filter((t) => t.active);
assert.equal(activeTablesAfterDelete.length, 10, 'Devem continuar exatamente 10 mesas ativas no plano Básico');
assert.deepEqual(
  activeTablesAfterDelete.map((t) => t.tableNumber),
  [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'Mesas 2 a 11 devem estar ativas (Mesa 11 foi promovida após exclusão da Mesa 1)'
);
console.log('PASS: Recálculo automático promoveu a Mesa 11 para ativa sem exceder o limite.');

// --- Teste 12: Bloqueio do KDS para Plano Básico vs Autorização para Pro e Premium (Bloco 11.6) ---
console.log('\n--- Teste 12: Bloqueio Comercial do KDS para Plano Básico e Liberação Pro/Premium (Bloco 11.6) ---');

// 1. Restaurante no plano Básico tentando acessar get_kds_active_items -> DEVE FALHAR COM 42501
await assert.rejects(
  async () => {
    await runAs(superAdminId, {}, async () => {
      await q(`select public.get_kds_active_items('restaurante-cota');`);
    });
  },
  (err) => err.code === '42501' && err.message.includes('O módulo KDS é exclusivo para planos Pro e Premium'),
  'Plano Básico deve ser bloqueado no KDS com código 42501'
);
console.log('PASS: Bloqueio comercial do KDS no plano Básico confirmado com erro 42501.');

// 2. Upgrade para Plano Pro -> Acesso ao KDS deve ser autorizado
await runAs(superAdminId, {}, async () => {
  await q(`
    select public.update_restaurant_saas_plan(
      '${quotaRestaurantId}',
      'pro',
      14900,
      25,
      30,
      false
    );
  `);
});

const kdsProResult = await runAs(superAdminId, {}, async () => {
  const [{ get_kds_active_items: items }] = await q(`select public.get_kds_active_items('restaurante-cota');`);
  return items;
});

assert.ok(Array.isArray(kdsProResult), 'KDS deve retornar array de itens no plano Pro');
console.log('PASS: Acesso ao KDS autorizado com sucesso no plano Pro.');

// 3. Upgrade para Plano Premium -> Acesso ao KDS deve ser autorizado
await runAs(superAdminId, {}, async () => {
  await q(`
    select public.update_restaurant_saas_plan(
      '${quotaRestaurantId}',
      'premium',
      19900,
      50,
      30,
      false
    );
  `);
});

const kdsPremiumResult = await runAs(superAdminId, {}, async () => {
  const [{ get_kds_active_items: items }] = await q(`select public.get_kds_active_items('restaurante-cota');`);
  return items;
});

assert.ok(Array.isArray(kdsPremiumResult), 'KDS deve retornar array de itens no plano Premium');
console.log('PASS: Acesso ao KDS autorizado com sucesso no plano Premium.');

// --- Teste 13: Paywall de Inadimplência, Tolerância Operacional (Grace Period) e Projeção de Status (Bloco 12) ---
console.log('\n--- Teste 13: Paywall de Inadimplência e Tolerância Operacional (Bloco 12) ---');

const paywallRestId = '90000000-0000-4000-8000-000000000099';
await db.exec(`
  insert into public.restaurants (id, name, slug, active, subscription_plan, max_tables, subscription_expires_at)
  values ('${paywallRestId}', 'Restaurante Paywall', 'restaurante-paywall', true, 'basic', 10, timezone('utc', now()) - interval '4 days');

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${paywallRestId}', '${regularUserId}', 'admin', true);

  insert into public.restaurant_tables (restaurant_id, table_number, active, is_active)
  values ('${paywallRestId}', 1, true, true);
`);

// 1. Status com 4 dias de vencido deve ser 'expired'
const [{ get_restaurant_billing_status: statusExpired }] = await q(`
  select public.get_restaurant_billing_status(timezone('utc', now()) - interval '4 days');
`);
assert.equal(statusExpired, 'expired', 'Vencimento há mais de 3 dias deve ser expired');

// 2. Tentar abrir atendimento em restaurante 'expired' deve ser barrado com erro P0001
await assert.rejects(
  async () => {
    await runAs(regularUserId, {}, async () => {
      await q(`select public.open_table_visit('restaurante-paywall', 1);`);
    });
  },
  (err) =>
    err.code === 'P0001' &&
    err.message.includes('A assinatura deste estabelecimento está suspensa por expiração do ciclo'),
  'Atendimento em restaurante expired deve ser bloqueado com mensagem informativa'
);
console.log('PASS: Paywall de inadimplência bloqueou comanda aberta em restaurante expirado há 4 dias.');

// 3. Atualizar para 1 dia de vencido -> deve entrar em 'grace_period'
await db.exec(`
  update public.restaurants
  set subscription_expires_at = timezone('utc', now()) - interval '1 day'
  where id = '${paywallRestId}';
`);

const [{ get_restaurant_billing_status: statusGrace }] = await q(`
  select public.get_restaurant_billing_status(timezone('utc', now()) - interval '1 day');
`);
assert.equal(statusGrace, 'grace_period', 'Vencimento em até 3 dias deve ser grace_period');

// 4. Abertura de atendimento no período de tolerância (grace period) DEVE SER PERMITIDA
const graceVisit = await runAs(regularUserId, {}, async () => {
  const [{ open_table_visit: visit }] = await q(`select public.open_table_visit('restaurante-paywall', 1);`);
  return visit;
});
assert.ok(graceVisit, 'Atendimento deve abrir com sucesso durante a tolerância operacional');
console.log('PASS: Tolerância operacional (grace period de 3 dias) autorizou abertura de atendimento.');

// 5. Regularizar assinatura (ativo) e verificar projeções em list_platform_restaurants
await runAs(superAdminId, {}, async () => {
  await q(`
    select public.update_restaurant_saas_plan(
      '${paywallRestId}',
      'basic',
      9900,
      10,
      30,
      true
    );
  `);
});

const listPlatform = await runAs(superAdminId, {}, async () => {
  const [{ list_platform_restaurants: list }] = await q(`select public.list_platform_restaurants();`);
  return list;
});

const paywallInList = listPlatform.find((r) => r.id === paywallRestId);
assert.ok(paywallInList, 'Restaurante paywall deve constar na listagem da plataforma');
assert.equal(paywallInList.billingStatus, 'active', 'Restaurante regularizado deve ter billingStatus active');
assert.ok(Array.isArray(paywallInList.adminEmails), 'adminEmails deve ser um array');
assert.ok(paywallInList.adminEmails.includes('admin@cantina.com'), 'adminEmails deve conter o email do administrador');
console.log('PASS: Projeção de billingStatus e adminEmails em list_platform_restaurants confirmada.');

// --- Teste 14: Registro Imutável de Auditoria da Plataforma (Bloco 12) ---
console.log('\n--- Teste 14: Registro Imutável de Auditoria da Plataforma (Bloco 12) ---');

// 1. Usuário comum não pode chamar a RPC list_platform_audit_logs
await assert.rejects(
  async () => {
    await runAs(regularUserId, {}, async () => {
      await q(`select public.list_platform_audit_logs(50);`);
    });
  },
  (err) => err.code === '42501',
  'Usuário comum não tem permissão para ler logs de auditoria'
);

// 2. RLS direto bloqueia leitura de usuário comum
const userLogs = await runAs(regularUserId, {}, async () => {
  return await q(`select * from public.platform_audit_logs;`);
});
assert.equal(userLogs.length, 0, 'RLS deve impedir visualização de logs por usuários comuns');
console.log('PASS: RLS e controle de permissões em platform_audit_logs validados.');

// 3. SuperAdmin lista os logs de auditoria
const auditLogsList = await runAs(superAdminId, {}, async () => {
  const [{ list_platform_audit_logs: logs }] = await q(`select public.list_platform_audit_logs(50);`);
  return logs;
});

assert.ok(Array.isArray(auditLogsList), 'list_platform_audit_logs deve retornar um array');
assert.ok(auditLogsList.length > 0, 'Deve haver registros de auditoria gravados automaticamente');

// 4. Validar ações registradas
const planChangeLog = auditLogsList.find((l) => l.action === 'plan_changed');
assert.ok(planChangeLog, 'Deve haver log de alteração de plano (plan_changed)');
assert.ok(planChangeLog.details.old_plan, 'Log de plano deve conter old_plan');
assert.ok(planChangeLog.details.new_plan, 'Log de plano deve conter new_plan');

const tableDeleteLog = auditLogsList.find((l) => l.action === 'table_deleted');
assert.ok(tableDeleteLog, 'Deve haver log de exclusão de mesa (table_deleted)');
assert.equal(tableDeleteLog.details.table_number, 1, 'Log de mesa deve registrar número da mesa');

const catalogLog = auditLogsList.find((l) => l.action === 'catalog_updated');
assert.ok(catalogLog, 'Deve haver log de atualização de catálogo (catalog_updated)');

console.log(`PASS: ${auditLogsList.length} eventos de auditoria verificados com sucesso (plan_changed, table_deleted, catalog_updated).`);

console.log('\n======================================================');
console.log('TODOS OS 14 TESTES DE PLANOS SAAS, LIMITES, BRANDING, EXCLUSÃO, KDS, PAYWALL E AUDITORIA FORAM APROVADOS!');
console.log('======================================================');
