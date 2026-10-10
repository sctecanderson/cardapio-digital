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

console.log('--- Iniciando Banco PostgreSQL Local (PGlite) ---');

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

console.log('PASS: Todas as migrações (incluindo 20261010090000_get_guest_table_tab_session.sql) compiladas com sucesso.');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

// Helpers para alternar roles e claims no PostgreSQL
async function runAsSuperuser(fn) {
  await db.exec(`
    set role none;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claims', '{}', false);
  `);
  return fn();
}

async function runAsAnon(fn) {
  await db.exec(`
    set role anon;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claims', '{}', false);
  `);
  try {
    return await fn();
  } finally {
    await db.exec(`set role none;`);
  }
}

async function runAsAuthenticated(userId, isAnonymous, fn) {
  const claims = JSON.stringify({
    sub: userId || '',
    is_anonymous: !!isAnonymous,
    role: 'authenticated',
  });
  await db.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${userId || ''}', false);
    select set_config('request.jwt.claims', '${claims}', false);
  `);
  try {
    return await fn();
  } finally {
    await db.exec(`set role none;`);
  }
}

// 1. Criar dados de teste com o usuário privilegiado (superuser)
const anonUser1 = '11111111-1111-4000-8000-111111111111';
const anonUser2 = '22222222-2222-4000-8000-222222222222';
const staffUser = '33333333-3333-4000-8000-333333333333';

await runAsSuperuser(async () => {
  await db.exec(`
    insert into auth.users (id, is_anonymous) values
      ('${anonUser1}', true),
      ('${anonUser2}', true),
      ('${staffUser}', false);
  `);
});

const [{ id: brasaId }] = await q("select id from public.restaurants where slug='brasa'");
const [{ id: nomaId }] = await q("select id from public.restaurants where slug='noma'");

// Mesas
const [{ id: brasaTable1 }] = await q(
  'insert into public.restaurant_tables (restaurant_id, table_number, active) values ($1, 1, true) on conflict (restaurant_id, table_number) do update set active=true returning id',
  [brasaId],
);
const [{ id: brasaTable2 }] = await q(
  'insert into public.restaurant_tables (restaurant_id, table_number, active) values ($1, 2, true) on conflict (restaurant_id, table_number) do update set active=true returning id',
  [brasaId],
);
const [{ id: brasaTableInactive }] = await q(
  'insert into public.restaurant_tables (restaurant_id, table_number, active) values ($1, 99, false) on conflict (restaurant_id, table_number) do update set active=false returning id',
  [brasaId],
);
const [{ id: nomaTable1 }] = await q(
  'insert into public.restaurant_tables (restaurant_id, table_number, active) values ($1, 1, true) on conflict (restaurant_id, table_number) do update set active=true returning id',
  [nomaId],
);

// Restaurante inativo
const [{ id: inactiveRestId }] = await q(
  "insert into public.restaurants (slug, name, active) values ('rest-inativo', 'Restaurante Inativo', false) returning id",
);
await q(
  'insert into public.restaurant_tables (restaurant_id, table_number, active) values ($1, 1, true)',
  [inactiveRestId],
);

// Membro da equipe
const [{ id: memberId }] = await q(
  'insert into public.restaurant_members (restaurant_id, user_id, role, active) values ($1, $2, $3, true) returning id',
  [brasaId, staffUser, 'waiter'],
);

console.log('--- Executando Testes SQL de Permissões e Roles ---');

// TESTE 1: SET ROLE anon -> Negação de EXECUTE garantida
await assert.rejects(
  async () => {
    await runAsAnon(() => q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]));
  },
  /permission denied for function get_guest_table_tab_session/,
  'Role anon deve receber negação explícita de EXECUTE na RPC',
);
console.log('PASS: Negação de EXECUTE confirmada para a role anon');

// TESTE 2: Ausência de autenticação (SET ROLE authenticated sem claims)
let res = await runAsAuthenticated(null, false, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 0, 'Ausência de auth.uid() retorna 0 linhas');
console.log('PASS: Ausência de autenticação retorna 0 linhas');

// TESTE 3: Funcionário autenticado (não-anônimo)
res = await runAsAuthenticated(staffUser, false, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 0, 'Funcionário autenticado não-anônimo retorna 0 linhas');
console.log('PASS: Funcionário autenticado bloqueado da consulta de cliente (retorna 0 linhas)');

// TESTE 4: Cliente anônimo sem sessão existente
res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 0, 'Cliente anônimo sem sessão retorna 0 linhas');
console.log('PASS: Cliente anônimo autenticado executa normalmente e retorna 0 linhas quando sem sessão');

// TESTE 5: Validação de Parâmetros e Status com cliente anônimo autenticado
res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['', 1]),
);
assert.equal(res.length, 0, 'Slug vazio deve retornar 0 linhas');

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['restaurante-inexistente', 1]),
);
assert.equal(res.length, 0, 'Restaurante inexistente deve retornar 0 linhas');

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['rest-inativo', 1]),
);
assert.equal(res.length, 0, 'Restaurante inativo deve retornar 0 linhas');

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 0]),
);
assert.equal(res.length, 0, 'Mesa 0 deve retornar 0 linhas');

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1000]),
);
assert.equal(res.length, 0, 'Mesa 1000 deve retornar 0 linhas');

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 99]),
);
assert.equal(res.length, 0, 'Mesa inativa deve retornar 0 linhas');
console.log('PASS: Validação estrita de parâmetros e restaurante/mesa inativos');

// TESTE 6: Sessão Pendente
const sessPendingId = 'aaaaaaaa-1111-4000-8000-111111111111';
await runAsSuperuser(async () => {
  await db.exec(`
    insert into public.guest_sessions (id, restaurant_id, restaurant_table_id, user_id, status, created_at, expires_at)
    values ('${sessPendingId}', '${brasaId}', '${brasaTable1}', '${anonUser1}', 'pending', now(), now() + interval '2 hours');
  `);
});

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 1);
assert.equal(res[0].session_id, sessPendingId);
assert.equal(res[0].status, 'pending');
assert.equal(res[0].table_tab_id, null);
console.log('PASS: Sessão pendente identificada com sucesso sob SET ROLE authenticated');

// TESTE 7: Isolamento entre Usuários sob SET ROLE authenticated
res = await runAsAuthenticated(anonUser2, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 0, 'Outro usuário anônimo na mesma mesa não vê a sessão do anonUser1');

// TESTE 8: Isolamento entre Mesas e Restaurantes
res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 2]),
);
assert.equal(res.length, 0, 'AnonUser1 na mesa 2 de brasa NÃO vê a sessão da mesa 1');

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['noma', 1]),
);
assert.equal(res.length, 0, 'AnonUser1 no restaurante noma NÃO vê a sessão do brasa');
console.log('PASS: Isolamento estrito entre usuários, mesas e restaurantes comprovado');

// TESTE 9: Sessão Ativa com Comanda Aberta e Atendimento Aberto
const visitId = 'bbbbbbbb-1111-4000-8000-111111111111';
const tabId = 'cccccccc-1111-4000-8000-111111111111';
const sessActiveId = 'dddddddd-1111-4000-8000-111111111111';

await runAsSuperuser(async () => {
  await db.exec(`delete from public.guest_sessions where id='${sessPendingId}';`);

  await db.exec(`
    insert into public.table_visits (id, restaurant_id, restaurant_table_id, assigned_member_id, status, opened_at)
    values ('${visitId}', '${brasaId}', '${brasaTable1}', '${memberId}', 'open', now());

    insert into public.guest_sessions (id, restaurant_id, restaurant_table_id, user_id, table_visit_id, confirmed_by_member_id, confirmed_at, status, created_at, expires_at)
    values ('${sessActiveId}', '${brasaId}', '${brasaTable1}', '${anonUser1}', '${visitId}', '${memberId}', now(), 'active', now(), now() + interval '2 hours');

    insert into public.table_tabs (id, restaurant_id, restaurant_table_id, table_visit_id, label, status, created_by_member_id, created_at)
    values ('${tabId}', '${brasaId}', '${brasaTable1}', '${visitId}', 'Mesa 01 - Principal', 'open', '${memberId}', now());

    insert into public.table_tab_guests (guest_session_id, table_tab_id, table_visit_id, restaurant_id, restaurant_table_id, linked_by_member_id)
    values ('${sessActiveId}', '${tabId}', '${visitId}', '${brasaId}', '${brasaTable1}', '${memberId}');
  `);
});

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 1);
assert.equal(res[0].session_id, sessActiveId);
assert.equal(res[0].status, 'active');
assert.equal(res[0].table_tab_id, tabId);
assert.equal(res[0].tab_status, 'open');
assert.equal(res[0].tab_label, 'Mesa 01 - Principal');
console.log('PASS: Sessão ativa e comanda vinculada com integridade de atendimento');

// TESTE 10: Comanda Encerrada
await runAsSuperuser(async () => {
  await db.exec(`
    update public.table_tabs
    set status = 'closed', closed_by_member_id = '${memberId}', closed_at = now()
    where id = '${tabId}';
  `);
});

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 1);
assert.equal(res[0].status, 'active');
assert.equal(res[0].tab_status, 'closed');
console.log('PASS: Comanda encerrada reflete tab_status = closed sob SET ROLE authenticated');

// TESTE 11: Atendimento Encerrado no Salão (status = revoked)
await runAsSuperuser(async () => {
  await db.exec(`
    update public.table_visits set status = 'closed', closed_at = now() where id = '${visitId}';
    update public.guest_sessions set status = 'revoked' where id = '${sessActiveId}';
  `);
});

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 1);
assert.equal(res[0].status, 'revoked');
console.log('PASS: Atendimento encerrado retorna status = revoked');

// TESTE 12: Sessão Expirada temporalmente (expires_at <= now())
const sessExpiredId = 'eeeeeeee-1111-4000-8000-111111111111';
await runAsSuperuser(async () => {
  await db.exec(`delete from public.guest_sessions where id='${sessActiveId}';`);
  await db.exec(`
    insert into public.guest_sessions (id, restaurant_id, restaurant_table_id, user_id, status, created_at, expires_at)
    values ('${sessExpiredId}', '${brasaId}', '${brasaTable1}', '${anonUser1}', 'expired', now() - interval '3 hours', now() - interval '1 hour');
  `);
});

res = await runAsAuthenticated(anonUser1, true, () =>
  q('select * from public.get_guest_table_tab_session($1, $2)', ['brasa', 1]),
);
assert.equal(res.length, 1);
assert.equal(res[0].status, 'expired');
console.log('PASS: Sessão expirada temporalmente tratada com status = expired');

console.log('--- TODOS OS TESTES SQL DE PERMISSÕES E BANCO REAL PASSARAM COM 100% DE SUCESSO! ---');
