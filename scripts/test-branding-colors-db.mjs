import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 15 (Paleta de Cores e Identidade) ---');
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

console.log('PASS: Todas as migrações (incluindo 20261016000000) compiladas com sucesso.');

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
// SETUP: Dono do Restaurante e Restaurante de Teste
// ----------------------------------------------------------------------------
const testOwnerId = '90000000-0000-4000-8000-000000000001';
const testRestaurantId = '90000000-0000-4000-8000-000000000002';

await db.exec(`
  insert into auth.users (id, email)
  values ('${testOwnerId}', 'owner@elozitest.com')
  on conflict (id) do nothing;

  insert into public.restaurants (
    id, name, slug, active, subscription_plan, max_tables,
    theme_primary, theme_background, theme_text,
    brand_primary_color, header_name_color, header_subtitle_color,
    subtitle, description, address, phone, opening_hours
  )
  values (
    '${testRestaurantId}',
    'Cantina do Luigi',
    'cantina-luigi',
    true,
    'pro',
    20,
    '#EA580C',
    '#FFFFFF',
    '#1C1917',
    '#EA580C',
    '#1C1917',
    '#57534E',
    'Culinária Italiana Tradicional',
    'Massas frescas e vinhos.',
    'Rua das Flores, 100',
    '(11) 99999-9999',
    'Seg-Sex: 18h-23h'
  )
  on conflict (id) do nothing;

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values ('${testRestaurantId}', '${testOwnerId}', 'admin', true)
  on conflict do nothing;
`);

console.log('--- TESTE 1: Consulta Pública do Restaurante (get_public_restaurant) ---');
await runAs(null, {}, async () => {
  const result = await q(`select public.get_public_restaurant('cantina-luigi') as data;`);
  const data = result[0].data;

  assert.ok(data, 'Deve retornar os dados do restaurante público');
  assert.equal(data.brandPrimaryColor, '#EA580C');
  assert.equal(data.headerNameColor, '#1C1917');
  assert.equal(data.headerSubtitleColor, '#57534E');
  assert.equal(data.theme.primary, '#EA580C');
});
console.log('PASS: get_public_restaurant projeta corretamente brandPrimaryColor, headerNameColor e headerSubtitleColor.');

console.log('--- TESTE 2: Atualização de Cores Personalizadas (save_restaurant_identity) ---');
await runAs(testOwnerId, {}, async () => {
  const currentRest = (await q(`select * from public.restaurants where id = '${testRestaurantId}';`))[0];

  const updatePayload = {
    name: 'Cantina do Luigi Gourmet',
    subtitle: 'Autêntica Gastronomia Italiana',
    description: 'Massas artesanais, antepastos e vinhos finos.',
    address: 'Rua das Flores, 100 - Centro',
    phone: '(11) 99999-8888',
    opening_hours: 'Ter-Dom: 19h-00h',
    theme_primary: '#2563EB',
    theme_background: '#FFFFFF',
    theme_text: '#1E293B',
    brand_primary_color: '#2563EB',
    header_name_color: '#0F172A',
    header_subtitle_color: '#64748B',
    logo: null,
    cover: null
  };

  const updatedResult = await q(
    `select public.save_restaurant_identity('cantina-luigi', $1, $2::jsonb) as res;`,
    [currentRest.revision, JSON.stringify(updatePayload)]
  );

  const res = updatedResult[0].res;
  assert.equal(res.name, 'Cantina do Luigi Gourmet');
  assert.equal(res.brandPrimaryColor, '#2563EB');
  assert.equal(res.headerNameColor, '#0F172A');
  assert.equal(res.headerSubtitleColor, '#64748B');
  assert.equal(res.theme.primary, '#2563EB');

  // Verificar diretamente no banco
  const dbRow = (await q(`select * from public.restaurants where id = '${testRestaurantId}';`))[0];
  assert.equal(dbRow.brand_primary_color, '#2563EB');
  assert.equal(dbRow.header_name_color, '#0F172A');
  assert.equal(dbRow.header_subtitle_color, '#64748B');
  assert.equal(dbRow.theme_primary, '#2563EB');
});
console.log('PASS: save_restaurant_identity persistiu as 3 cores e sincronizou com theme_primary.');

console.log('--- TESTE 3: Validação de Hex Code Inválido ---');
await runAs(testOwnerId, {}, async () => {
  const currentRest = (await q(`select * from public.restaurants where id = '${testRestaurantId}';`))[0];

  const invalidColorPayload = {
    name: 'Cantina do Luigi',
    subtitle: 'Autêntica Gastronomia Italiana',
    description: 'Massas artesanais.',
    address: 'Rua das Flores, 100',
    phone: '(11) 99999-8888',
    opening_hours: 'Ter-Dom: 19h-00h',
    theme_primary: '#2563EB',
    theme_background: '#FFFFFF',
    theme_text: '#1E293B',
    brand_primary_color: 'invalid-color-code',
    header_name_color: '#0F172A',
    header_subtitle_color: '#64748B',
    logo: null,
    cover: null
  };

  await assert.rejects(
    async () => {
      await q(
        `select public.save_restaurant_identity('cantina-luigi', $1, $2::jsonb);`,
        [currentRest.revision, JSON.stringify(invalidColorPayload)]
      );
    },
    /Cor primária da marca inválida/
  );
});
console.log('PASS: Validação de formato hex (#RRGGBB) rejeitou string inválida corretamente.');

console.log('\n>>> TODOS OS TESTES DO BLOCO 15 FORAM APROVADOS! <<<');
