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

// =============================================================================
// TESTES DO BLOCO 9.4: public.get_guest_table_tab_context
// =============================================================================
console.log('\n--- Bateria de Testes: public.get_guest_table_tab_context (KDS Client Context) ---');

// TESTE 13: anon sem autenticação é bloqueado
await assert.rejects(
  async () => {
    await runAsAnon(async () => {
      await q('select public.get_guest_table_tab_context($1, $2)', ['brasa', 1]);
    });
  },
  (err) => err.code === '42501',
  'anon sem autenticacao deve receber erro 42501'
);
console.log('PASS: Role anon sem autenticacao recebe 42501 (permissao negada)');

// TESTE 14: Funcionario staff (nao-anonimo) retorna NULL
res = await runAsAuthenticated(staffUser, false, () =>
  q('select public.get_guest_table_tab_context($1, $2) as ctx', ['brasa', 1])
);
assert.equal(res[0].ctx, null, 'Staff nao deve conseguir ler via contexto de guest');
console.log('PASS: Staff autenticado recebe NULL ao chamar get_guest_table_tab_context');

// TESTE 15: Sessão Ativa com Itens em Diferentes Estágios KDS
const visitContextId = 'bbbbbbbb-2222-4000-8000-222222222222';
const tabContextId = 'cccccccc-2222-4000-8000-222222222222';
const sessContextId = 'dddddddd-2222-4000-8000-222222222222';

await runAsSuperuser(async () => {
  // Limpa sessoes residuais do anonUser1 na mesa 1
  await db.exec(`delete from public.guest_sessions where user_id = '${anonUser1}';`);

  // Cria visita aberta
  await db.exec(`
    insert into public.table_visits (id, restaurant_id, restaurant_table_id, assigned_member_id, status, opened_at)
    values ('${visitContextId}', '${brasaId}', '${brasaTable1}', '${memberId}', 'open', now());

    insert into public.guest_sessions (id, restaurant_id, restaurant_table_id, user_id, table_visit_id, confirmed_by_member_id, confirmed_at, status, created_at, expires_at)
    values ('${sessContextId}', '${brasaId}', '${brasaTable1}', '${anonUser1}', '${visitContextId}', '${memberId}', now(), 'active', now(), now() + interval '2 hours');

    insert into public.table_tabs (id, restaurant_id, restaurant_table_id, table_visit_id, label, status, created_by_member_id, created_at)
    values ('${tabContextId}', '${brasaId}', '${brasaTable1}', '${visitContextId}', 'Mesa 01 - Contexto KDS', 'open', '${memberId}', now());

    insert into public.table_tab_guests (guest_session_id, table_tab_id, table_visit_id, restaurant_id, restaurant_table_id, linked_by_member_id)
    values ('${sessContextId}', '${tabContextId}', '${visitContextId}', '${brasaId}', '${brasaTable1}', '${memberId}');
  `);

  // Cria categoria e produtos para o restaurante brasa
  await db.exec(`
    insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, active, sort_order)
    values ('11111111-cccc-4000-8000-000000000001', '${brasaId}', 'brasa-pratos', 'Pratos', 'pratos', true, 1)
    on conflict (restaurant_id, slug) do nothing;

    insert into public.menu_products (id, restaurant_id, category_id, catalog_key, name, slug, price_in_cents, available, preparation_station)
    values
      ('11111111-dddd-4000-8000-000000000001', '${brasaId}', '11111111-cccc-4000-8000-000000000001', 'brasa-prato-principal', 'Prato Principal', 'prato-principal', 2000, true, 'kitchen'),
      ('11111111-dddd-4000-8000-000000000002', '${brasaId}', '11111111-cccc-4000-8000-000000000001', 'brasa-agua', 'Água sem Gás', 'agua-sem-gas', 1000, true, 'none'),
      ('11111111-dddd-4000-8000-000000000003', '${brasaId}', '11111111-cccc-4000-8000-000000000001', 'brasa-sobremesa', 'Sobremesa', 'sobremesa', 5000, true, 'kitchen')
    on conflict (restaurant_id, slug) do nothing;
  `);

  // Insere itens com status KDS variados
  await db.exec(`
    -- Item 1: kitchen pending (R$ 20.00 x 2 = R$ 40.00)
    insert into public.table_tab_items (
      id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
      product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
      preparation_station, production_status
    ) values (
      '11111111-0001-4000-8000-000000000001', '${brasaId}', '${brasaTable1}', '${visitContextId}', '${tabContextId}',
      '11111111-dddd-4000-8000-000000000001', 'Prato Principal', 2000, 2, '${memberId}', now() - interval '10 minutes',
      'kitchen', 'pending'
    );

    -- Item 2: kitchen preparing (R$ 20.00 x 1 = R$ 20.00)
    insert into public.table_tab_items (
      id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
      product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
      preparation_station, production_status, prep_started_at
    ) values (
      '11111111-0002-4000-8000-000000000002', '${brasaId}', '${brasaTable1}', '${visitContextId}', '${tabContextId}',
      '11111111-dddd-4000-8000-000000000001', 'Prato Principal', 2000, 1, '${memberId}', now() - interval '8 minutes',
      'kitchen', 'preparing', now() - interval '5 minutes'
    );

    -- Item 3: kitchen ready (R$ 20.00 x 1 = R$ 20.00)
    insert into public.table_tab_items (
      id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
      product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
      preparation_station, production_status, prep_started_at, prep_ready_at
    ) values (
      '11111111-0003-4000-8000-000000000003', '${brasaId}', '${brasaTable1}', '${visitContextId}', '${tabContextId}',
      '11111111-dddd-4000-8000-000000000001', 'Prato Principal', 2000, 1, '${memberId}', now() - interval '7 minutes',
      'kitchen', 'ready', now() - interval '5 minutes', now() - interval '1 minute'
    );

    -- Item 4: none delivered (R$ 10.00 x 3 = R$ 30.00)
    insert into public.table_tab_items (
      id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
      product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
      preparation_station, production_status, prep_delivered_at
    ) values (
      '11111111-0004-4000-8000-000000000004', '${brasaId}', '${brasaTable1}', '${visitContextId}', '${tabContextId}',
      '11111111-dddd-4000-8000-000000000002', 'Água sem Gás', 1000, 3, '${memberId}', now() - interval '6 minutes',
      'none', 'delivered', now() - interval '6 minutes'
    );

    -- Item 5: Inserido como active e cancelado logo depois (R$ 50.00) - NÃO deve somar no total
    insert into public.table_tab_items (
      id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
      product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
      preparation_station, production_status
    ) values (
      '11111111-0005-4000-8000-000000000005', '${brasaId}', '${brasaTable1}', '${visitContextId}', '${tabContextId}',
      '11111111-dddd-4000-8000-000000000003', 'Sobremesa', 5000, 1, '${memberId}', now() - interval '5 minutes',
      'kitchen', 'pending'
    );

    update public.table_tab_items
    set
      status = 'cancelled',
      cancelled_by_member_id = '${memberId}',
      cancelled_at = now() - interval '2 minutes',
      cancellation_reason = 'Cliente desistiu'
    where id = '11111111-0005-4000-8000-000000000005';
  `);
});

// Consulta pelo cliente anônimo
res = await runAsAuthenticated(anonUser1, true, () =>
  q('select public.get_guest_table_tab_context($1, $2) as ctx', ['brasa', 1])
);
const ctx = typeof res[0].ctx === 'string' ? JSON.parse(res[0].ctx) : res[0].ctx;

assert.ok(ctx !== null, 'Contexto retornado não pode ser nulo');
assert.equal(ctx.status, 'active');
assert.equal(ctx.table_tab_id, tabContextId);
assert.equal(ctx.tab_label, 'Mesa 01 - Contexto KDS');
assert.equal(ctx.tab_status, 'open');

// Validação dos itens e campos KDS
assert.equal(ctx.items.length, 5, 'Deve listar todos os 5 itens (ativos e cancelados)');
const pendingItem = ctx.items.find((i) => i.id === '11111111-0001-4000-8000-000000000001');
const preparingItem = ctx.items.find((i) => i.id === '11111111-0002-4000-8000-000000000002');
const readyItem = ctx.items.find((i) => i.id === '11111111-0003-4000-8000-000000000003');
const noneItem = ctx.items.find((i) => i.id === '11111111-0004-4000-8000-000000000004');
const cancelledItem = ctx.items.find((i) => i.id === '11111111-0005-4000-8000-000000000005');

assert.equal(pendingItem.production_status, 'pending');
assert.equal(pendingItem.preparation_station, 'kitchen');

assert.equal(preparingItem.production_status, 'preparing');
assert.ok(preparingItem.prep_started_at !== null);

assert.equal(readyItem.production_status, 'ready');
assert.ok(readyItem.prep_ready_at !== null);

assert.equal(noneItem.production_status, 'delivered');
assert.equal(noneItem.preparation_station, 'none');
assert.ok(noneItem.prep_delivered_at !== null);

assert.equal(cancelledItem.status, 'cancelled');
assert.equal(cancelledItem.cancellation_reason, 'Cliente desistiu');

// Total em centavos deve somar apenas os ativos: 4000 + 2000 + 2000 + 3000 = 11000
assert.equal(ctx.totalInCents, 11000, 'Total em centavos deve somar apenas itens ativos (R$ 110.00)');
console.log('PASS: get_guest_table_tab_context projeta todos os campos de KDS e calcula totalInCents atomicamente');

// TESTE 16: AnonUser2 (outro cliente) nao tem acesso ao contexto da mesa do AnonUser1
res = await runAsAuthenticated(anonUser2, true, () =>
  q('select public.get_guest_table_tab_context($1, $2) as ctx', ['brasa', 1])
);
assert.equal(res[0].ctx, null, 'Cliente sem sessao vinculada recebe null');
console.log('PASS: Isolamento multi-tenant e sessao estrita preservados no get_guest_table_tab_context');

// TESTE 17: Atualizacao de display_name pelo membro da equipe via update_own_staff_display_name
const updateRes = await runAsAuthenticated(staffUser, false, () =>
  q('select public.update_own_staff_display_name($1, $2) as name', ['brasa', 'Anderson'])
);
assert.equal(updateRes[0].name, 'Anderson', 'Nome de exibicao deve ser Anderson');

const memberCheck = await runAsSuperuser(() =>
  q('select display_name from public.restaurant_members where id = $1', [memberId])
);
assert.equal(memberCheck[0].display_name, 'Anderson', 'display_name deve ter sido persistido no banco');
console.log('PASS: Membro atualiza display_name com sucesso via update_own_staff_display_name');

// TESTE 18: Bloqueio de anonimo chamar update_own_staff_display_name
await assert.rejects(
  async () => {
    await runAsAuthenticated(anonUser1, true, () =>
      q('select public.update_own_staff_display_name($1, $2)', ['brasa', 'Hacker'])
    );
  },
  (err) => err.message.includes('42501') || err.message.includes('Acesso negado'),
  'Tentativa de anonimo alterar display_name deve ser bloqueada com 42501'
);
console.log('PASS: Tentativa de anonimo chamar update_own_staff_display_name e bloqueada com 42501');

// TESTE 19: Validacao de tamanho de display_name (menos de 2 caracteres deve falhar)
await assert.rejects(
  async () => {
    await runAsAuthenticated(staffUser, false, () =>
      q('select public.update_own_staff_display_name($1, $2)', ['brasa', 'A'])
    );
  },
  (err) => err.message.includes('22023') || err.message.includes('entre 2 e 40 caracteres'),
  'display_name com menos de 2 caracteres deve falhar com 22023'
);
console.log('PASS: display_name invalido (< 2 chars) e rejeitado com 22023');

// TESTE 20: get_guest_table_tab_context projeta assignedWaiterName corretamente para o cliente
res = await runAsAuthenticated(anonUser1, true, () =>
  q('select public.get_guest_table_tab_context($1, $2) as ctx', ['brasa', 1])
);
const ctxWithWaiter = typeof res[0].ctx === 'string' ? JSON.parse(res[0].ctx) : res[0].ctx;
assert.equal(ctxWithWaiter.assignedWaiterName, 'Anderson', 'Cliente deve receber assignedWaiterName como Anderson');
console.log('PASS: get_guest_table_tab_context projeta assignedWaiterName ("Anderson") para o cliente na mesa');

console.log('\n--- TODOS OS TESTES SQL DE PERMISSÕES E BANCO REAL PASSARAM COM 100% DE SUCESSO! ---');
