import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Teste do Bloco 3 (Chamados e Conta) ---');
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
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
`);

// 1. Carregar e aplicar migrations na ordem estrita
const migrationsDir = path.resolve('supabase/migrations');
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of migrationFiles) {
  if (file === '20261008141500_create_table_tab_consumption.sql') {
    await db.exec(fs.readFileSync(path.resolve('supabase/seeds/demo_restaurants.sql'), 'utf8'));
  }
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  try {
    await db.exec(sql);
  } catch (err) {
    console.error(`Erro ao aplicar migração ${file}:`, err);
    process.exit(1);
  }
}
console.log('PASS: Todas as migrações (incluindo 20261010110000_cancel_service_requests.sql) compiladas com sucesso.');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function runAsSuperuser(fn) {
  await db.exec(`
    set role none;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claims', '{}', false);
  `);
  return fn();
}

async function runAsGuest(userId, fn) {
  const claims = JSON.stringify({
    sub: userId,
    is_anonymous: true,
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

async function runAsStaff(userId, fn) {
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

// Criar usuários e fixtures
const guest1User = '11111111-1111-4000-8000-111111111111';
const guest2User = '22222222-2222-4000-8000-222222222222';
const guest3User = '33333333-3333-4000-8000-333333333333';
const staffUser = '44444444-4444-4000-8000-444444444444';

await runAsSuperuser(async () => {
  await db.exec(`
    insert into auth.users (id, is_anonymous) values
      ('${guest1User}', true),
      ('${guest2User}', true),
      ('${guest3User}', true),
      ('${staffUser}', false);
  `);
});

const [{ id: brasaId }] = await q("select id from public.restaurants where slug='brasa'");
const [{ id: waiterMemberId }] = await q(
  'insert into public.restaurant_members (restaurant_id, user_id, role, active) values ($1, $2, $3, true) returning id',
  [brasaId, staffUser, 'waiter'],
);

console.log('--- Testes de Chamados de Garçom Compartilhados e Cancelamento ---');

// TESTE 1: Cliente 1 e Cliente 2 na Mesa 1 chamam o garçom
let resCall1 = await runAsGuest(guest1User, async () => {
  const [{ request_waiter: res }] = await q("select public.request_waiter('brasa', 1) as request_waiter");
  return res;
});
assert.equal(resCall1.status, 'created');
assert.equal(resCall1.request.status, 'pending');
const waiterRequestId = resCall1.request.id;

let resCall2 = await runAsGuest(guest2User, async () => {
  const [{ request_waiter: res }] = await q("select public.request_waiter('brasa', 1) as request_waiter");
  return res;
});
assert.equal(resCall2.status, 'existing', 'Segundo cliente deve ser vinculado ao chamado existente da mesa');
assert.equal(resCall2.request.id, waiterRequestId);

// Conferir vínculos em service_request_guests
let links = await q('select * from public.service_request_guests where service_request_id = $1', [waiterRequestId]);
assert.equal(links.length, 2, 'Devem existir 2 clientes vinculados ao chamado');
console.log('PASS: Chamado compartilhado criado e vinculado para ambos os clientes');

// TESTE 2: Cliente 3 na Mesa 2 tenta cancelar o chamado da Mesa 1 -> deve ser bloqueado
await runAsGuest(guest3User, async () => {
  let errBlocked = false;
  try {
    await q("select public.cancel_waiter_request('brasa', 1)");
  } catch (err) {
    errBlocked = true;
    assert.match(err.message, /Você não possui/i);
  }
  assert.equal(errBlocked, true, 'Cliente de outra mesa não pode cancelar chamado da Mesa 1');
});
console.log('PASS: Proteção de autorização impede cancelamento de chamado por cliente não vinculado');

// TESTE 3: Cliente 1 cancela sua solicitação -> status deve ser 'unlinked'
// O chamado global deve continuar 'pending' pois o Cliente 2 ainda aguarda
let resCancel1 = await runAsGuest(guest1User, async () => {
  const [{ cancel_waiter_request: res }] = await q("select public.cancel_waiter_request('brasa', 1) as cancel_waiter_request");
  return res;
});
assert.equal(resCancel1.status, 'unlinked');
assert.equal(resCancel1.remaining_guests, 1);

// Conferir banco: chamado permanece pending
let [reqRow] = await q('select status from public.service_requests where id = $1', [waiterRequestId]);
assert.equal(reqRow.status, 'pending', 'Chamado da mesa deve continuar pending para a equipe');

// Conferir estado do Cliente 1 via get_waiter_request_state -> não vê mais o chamado
let stateGuest1 = await runAsGuest(guest1User, async () => {
  const [{ get_waiter_request_state: s }] = await q("select public.get_waiter_request_state('brasa', 1) as get_waiter_request_state");
  return s;
});
assert.equal(stateGuest1.request, null, 'Cliente 1 não deve mais ver o chamado após cancelar');

// Conferir estado do Cliente 2 -> continua vendo pending
let stateGuest2 = await runAsGuest(guest2User, async () => {
  const [{ get_waiter_request_state: s }] = await q("select public.get_waiter_request_state('brasa', 1) as get_waiter_request_state");
  return s;
});
assert.equal(stateGuest2.request.status, 'pending', 'Cliente 2 continua vendo o chamado pending');
console.log('PASS: Cancelamento parcial remove apenas o vínculo do Cliente 1 e mantém o chamado ativo para o Cliente 2');

// TESTE 4: Cliente 2 também cancela -> como não resta nenhum cliente, o chamado passa para 'cancelled'
let resCancel2 = await runAsGuest(guest2User, async () => {
  const [{ cancel_waiter_request: res }] = await q("select public.cancel_waiter_request('brasa', 1) as cancel_waiter_request");
  return res;
});
assert.equal(resCancel2.status, 'cancelled');
assert.equal(resCancel2.remaining_guests, 0);

[reqRow] = await q('select status from public.service_requests where id = $1', [waiterRequestId]);
assert.equal(reqRow.status, 'cancelled', 'Chamado global deve mudar para cancelled');
console.log('PASS: Cancelamento do último cliente cancela o chamado global da mesa');

// TESTE 5: Tentativa de cancelar chamado já cancelado ou inexistente
await runAsGuest(guest2User, async () => {
  let errInex = false;
  try {
    await q("select public.cancel_waiter_request('brasa', 1)");
  } catch (err) {
    errInex = true;
  }
  assert.equal(errInex, true);
});
console.log('PASS: Rejeição correta para cancelamento duplicado');

console.log('--- Testes de Concorrência: Atendimento vs Cancelamento ---');

// TESTE 6: Novo chamado na Mesa 2
let resCallMesa2 = await runAsGuest(guest1User, async () => {
  const [{ request_waiter: res }] = await q("select public.request_waiter('brasa', 2) as request_waiter");
  return res;
});
const reqMesa2Id = resCallMesa2.request.id;

// Garçom atende o chamado primeiro
await runAsStaff(staffUser, async () => {
  await q("select public.attend_waiter_request('brasa', $1)", [reqMesa2Id]);
});

// Cliente tenta cancelar após ter sido atendido -> deve ser rejeitado com erro 22023
await runAsGuest(guest1User, async () => {
  let errAttended = false;
  try {
    await q("select public.cancel_waiter_request('brasa', 2)");
  } catch (err) {
    errAttended = true;
    assert.match(err.message, /já foi atendido pela equipe/i);
  }
  assert.equal(errAttended, true, 'Não é permitido cancelar chamado já atendido');
});
console.log('PASS: Chamado atendido não pode ser cancelado pelo cliente');

console.log('--- Testes de Pedido de Conta e Cancelamento de Conta ---');

// Criar visita aberta na Mesa 3 e Comanda aberta
const [{ id: mesa3Id }] = await q("select id from public.restaurant_tables where restaurant_id = $1 and table_number = 3", [brasaId]);
const [{ id: visit3Id }] = await q(
  "insert into public.table_visits (restaurant_id, restaurant_table_id, assigned_member_id, status) values ($1, $2, $3, 'open') returning id",
  [brasaId, mesa3Id, waiterMemberId]
);

// Criar sessão ativa confirmada para Guest 1 e vincular à comanda
const [{ id: guest1SessionId }] = await q(
  "insert into public.guest_sessions (restaurant_id, restaurant_table_id, table_visit_id, confirmed_by_member_id, confirmed_at, user_id, status, expires_at) values ($1, $2, $3, $4, now(), $5, 'active', now() + interval '2 hours') returning id",
  [brasaId, mesa3Id, visit3Id, waiterMemberId, guest1User]
);

const [{ id: tabId }] = await q(
  "insert into public.table_tabs (restaurant_id, restaurant_table_id, table_visit_id, label, created_by_member_id, status) values ($1, $2, $3, 'Comanda 01', $4, 'open') returning id",
  [brasaId, mesa3Id, visit3Id, waiterMemberId]
);

await q(
  "insert into public.table_tab_guests (guest_session_id, table_tab_id, table_visit_id, restaurant_id, restaurant_table_id, linked_by_member_id) values ($1, $2, $3, $4, $5, $6)",
  [guest1SessionId, tabId, visit3Id, brasaId, mesa3Id, waiterMemberId]
);

// TESTE 7: Pedir conta da comanda
let resBill = await runAsGuest(guest1User, async () => {
  const [{ request_table_tab_bill: res }] = await q("select public.request_table_tab_bill('brasa', $1) as request_table_tab_bill", [tabId]);
  return res;
});
assert.equal(resBill.status, 'created');
assert.equal(resBill.request.status, 'pending');
const billRequestId = resBill.request.id;

// Conferir banco:
let [billReqRow] = await q('select status from public.service_requests where id = $1', [billRequestId]);
assert.equal(billReqRow.status, 'pending');
console.log('PASS: Pedido de conta criado com sucesso para a comanda');

// TESTE 8: Cancelar pedido de conta
let resCancelBill = await runAsGuest(guest1User, async () => {
  const [{ cancel_table_tab_bill: res }] = await q("select public.cancel_table_tab_bill('brasa', $1) as cancel_table_tab_bill", [tabId]);
  return res;
});
assert.equal(resCancelBill.status, 'cancelled');
assert.equal(resCancelBill.request_id, billRequestId);

// Conferir banco:
[billReqRow] = await q('select status from public.service_requests where id = $1', [billRequestId]);
assert.equal(billReqRow.status, 'cancelled');
console.log('PASS: Pedido de conta cancelado com sucesso pelo cliente da comanda');

// TESTE 9: Não permite cancelar conta já cancelada
await runAsGuest(guest1User, async () => {
  let errCancel = false;
  try {
    await q("select public.cancel_table_tab_bill('brasa', $1)", [tabId]);
  } catch (err) {
    errCancel = true;
    assert.match(err.message, /Não há solicitação de conta pendente/i);
  }
  assert.equal(errCancel, true);
});
console.log('PASS: Rejeição correta para cancelamento de conta inexistente ou já cancelada');

console.log('--- TODOS OS TESTES DO BLOCO 3 PASSARAM COM 100% DE SUCESSO! ---');
