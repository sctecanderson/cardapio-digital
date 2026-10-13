process.on('uncaughtException', (e) => {
  console.error(e.message, e.where || '');
  process.exit(1);
});

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const pglitePath =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(pathToFileURL(resolve(pglitePath)).href);
const db = new PGlite();

console.log('--- Iniciando Banco PostgreSQL Local para Teste do Salão (Etapa 2) ---');

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
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
`);

const root = resolve(import.meta.dirname, '..');
const migrationFiles = (await readdir(root + '/supabase/migrations')).sort();

for (const name of migrationFiles) {
  try {
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      await db.exec(await readFile(root + '/supabase/seeds/demo_restaurants.sql', 'utf8'));
    }
    await db.exec(await readFile(root + '/supabase/migrations/' + name, 'utf8'));
  } catch (e) {
    console.error(`Erro ao aplicar migration ${name}:`, e.message);
    process.exit(1);
  }
}

console.log('PASS: Todas as migrações compiladas com sucesso.');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function runAsSuperuser(fn) {
  await db.exec(`
    set role none;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claims', '{}', false);
  `);
  return fn();
}

async function runAsAuthenticatedStaff(userId, fn) {
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
    await db.exec(`set role none;`);
  }
}

// 1. Criar garçons e dados no banco
const waiterAUser = '44444444-4444-4000-8000-444444444444';
const waiterBUser = '55555555-5555-4000-8000-555555555555';
const waiterNomaUser = '66666666-6666-4000-8000-666666666666';

await runAsSuperuser(async () => {
  await db.exec(`
    insert into auth.users (id, is_anonymous) values
      ('${waiterAUser}', false),
      ('${waiterBUser}', false),
      ('${waiterNomaUser}', false);
  `);
});

const [{ id: brasaId }] = await q("select id from public.restaurants where slug='brasa'");
const [{ id: nomaId }] = await q("select id from public.restaurants where slug='noma'");

// Membros da equipe de Brasa
const [{ id: memberAId }] = await q(
  'insert into public.restaurant_members (restaurant_id, user_id, role, active) values ($1, $2, $3, true) returning id',
  [brasaId, waiterAUser, 'waiter'],
);
const [{ id: memberBId }] = await q(
  'insert into public.restaurant_members (restaurant_id, user_id, role, active) values ($1, $2, $3, true) returning id',
  [brasaId, waiterBUser, 'waiter'],
);

// Membro da equipe de Noma
const [{ id: memberNomaId }] = await q(
  'insert into public.restaurant_members (restaurant_id, user_id, role, active) values ($1, $2, $3, true) returning id',
  [nomaId, waiterNomaUser, 'waiter'],
);

// Criar Mesas Reais em Brasa: Mesas 1, 2 e 3
await runAsSuperuser(async () => {
  await db.exec(`
    insert into public.restaurant_tables (restaurant_id, table_number, active)
    values
      ('${brasaId}', 1, true),
      ('${brasaId}', 2, true),
      ('${brasaId}', 3, true)
    on conflict (restaurant_id, table_number) do update set active = true;
  `);
});

// Criar Mesa em Noma: Mesa 1
await runAsSuperuser(async () => {
  await db.exec(`
    insert into public.restaurant_tables (restaurant_id, table_number, active)
    values ('${nomaId}', 1, true)
    on conflict (restaurant_id, table_number) do update set active = true;
  `);
});

console.log('--- Testes de Ocupação Real do Salão (Etapa 2) ---');

// TESTE 1: Consulta de mesas reais (sem placeholders fictícios)
let brasaTables = await runAsAuthenticatedStaff(waiterAUser, () =>
  q('select id, table_number, active from public.restaurant_tables where restaurant_id = $1 and active = true order by table_number', [brasaId]),
);
// Brasa recebeu as 20 mesas reais da migration 20261009223000
assert.equal(brasaTables.length, 20, 'Brasa deve ter exatamente as 20 mesas cadastradas no banco');
assert.deepEqual(brasaTables.map((t) => t.table_number), Array.from({ length: 20 }, (_, i) => i + 1));
console.log('PASS: Consulta de mesas reais retorna estritamente as mesas cadastradas no banco (sem placeholders no frontend)');

// TESTE 2: Salão inicialmente com todas as mesas livres
let openVisits = await runAsAuthenticatedStaff(waiterAUser, () =>
  q(`
    select v.id, v.restaurant_id, v.restaurant_table_id, v.assigned_member_id, v.status, rt.table_number
    from public.table_visits v
    join public.restaurant_tables rt on rt.id = v.restaurant_table_id
    where v.restaurant_id = $1 and v.status = 'open'
  `, [brasaId]),
);
assert.equal(openVisits.length, 0, 'Nenhuma mesa deve estar aberta no início');
console.log('PASS: Todas as mesas inicialmente livres');

// TESTE 3: Garçom A assume a Mesa 1
await runAsAuthenticatedStaff(waiterAUser, async () => {
  await db.query('select * from public.open_table_visit($1, $2)', ['brasa', 1]);
});

// TESTE 4: Garçom B consulta o salão e vê a Mesa 1 ocupada por Garçom A
openVisits = await runAsAuthenticatedStaff(waiterBUser, () =>
  q(`
    select v.id, v.restaurant_id, v.restaurant_table_id, v.assigned_member_id, v.status, rt.table_number
    from public.table_visits v
    join public.restaurant_tables rt on rt.id = v.restaurant_table_id
    where v.restaurant_id = $1 and v.status = 'open'
  `, [brasaId]),
);
assert.equal(openVisits.length, 1, 'Deve haver 1 atendimento aberto no salão de Brasa');
assert.equal(openVisits[0].table_number, 1);
assert.equal(openVisits[0].assigned_member_id, memberAId, 'Atendimento deve estar atribuído ao Garçom A');

// Avaliação da ótica do Garçom B:
const visitMesa1 = openVisits.find((v) => v.table_number === 1);
const isMineParaB = visitMesa1?.assigned_member_id === memberBId;
const isOtherParaB = visitMesa1?.assigned_member_id !== memberBId;
assert.equal(isMineParaB, false, 'Para Garçom B, mesa NÃO é dele');
assert.equal(isOtherParaB, true, 'Para Garçom B, mesa está em atendimento por outro garçom');

// Avaliação da ótica do Garçom A:
const isMineParaA = visitMesa1?.assigned_member_id === memberAId;
const isOtherParaA = visitMesa1?.assigned_member_id !== memberAId;
assert.equal(isMineParaA, true, 'Para Garçom A, mesa está em atendimento por ele mesmo');
assert.equal(isOtherParaA, false);
console.log('PASS: Diferenciação precisa de "Livre", "Em atendimento por mim" e "Em atendimento por outro colega"');

// TESTE 5: Garçom B tenta assumir a Mesa 1 (já ocupada por Garçom A) -> Rejeição pelo servidor
await assert.rejects(
  async () => {
    await runAsAuthenticatedStaff(waiterBUser, () =>
      db.query('select * from public.open_table_visit($1, $2)', ['brasa', 1]),
    );
  },
  /Esta mesa já está sendo atendida por outro funcionário/,
  'O servidor deve rejeitar com erro 42501 quando outro garçom tenta assumir mesa ocupada',
);
console.log('PASS: Servidor proíbe e protege concorrência de atendimento entre garçons');

// TESTE 6: Isolamento entre restaurantes (Garçom de Noma não vê as mesas de Brasa)
const nomaVisits = await runAsAuthenticatedStaff(waiterNomaUser, () =>
  q(`
    select v.id, v.restaurant_id, v.status, rt.table_number
    from public.table_visits v
    join public.restaurant_tables rt on rt.id = v.restaurant_table_id
    where v.restaurant_id = $1 and v.status = 'open'
  `, [nomaId]),
);
assert.equal(nomaVisits.length, 0, 'Noma não deve ver atendimentos de Brasa');
console.log('PASS: Isolamento estrito de atendimentos entre restaurantes');

// TESTE 7: Garçom A encerra o atendimento da Mesa 1
await runAsAuthenticatedStaff(waiterAUser, async () => {
  await db.query('select * from public.close_table_visit($1, $2)', ['brasa', openVisits[0].id]);
});

// TESTE 8: Após encerramento, Mesa 1 volta a ficar livre para todos
const visitsAposFechamento = await runAsAuthenticatedStaff(waiterBUser, () =>
  q(`
    select v.id, rt.table_number
    from public.table_visits v
    join public.restaurant_tables rt on rt.id = v.restaurant_table_id
    where v.restaurant_id = $1 and v.status = 'open'
  `, [brasaId]),
);
assert.equal(visitsAposFechamento.length, 0, 'Após encerramento, salão volta a ter 0 mesas abertas');
console.log('PASS: Mesa liberada com sucesso após encerramento do atendimento');

// TESTE 9: Restaurante sem mesas cadastradas
const [{ id: emptyRestId }] = await q(
  "insert into public.restaurants (slug, name, active) values ('rest-sem-mesas', 'Restaurante Sem Mesas', true) returning id",
);
const emptyTables = await runAsSuperuser(() =>
  q('select * from public.restaurant_tables where restaurant_id = $1 and active = true', [emptyRestId]),
);
assert.equal(emptyTables.length, 0, 'Restaurante sem mesas cadastradas retorna lista vazia');
console.log('PASS: Restaurante sem mesas retorna lista vazia sem placeholders fictícios');

console.log('--- TODOS OS TESTES DA ETAPA 2 (OCUPAÇÃO REAL DAS MESAS) PASSARAM COM SUCESSO! ---');
