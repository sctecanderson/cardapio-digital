import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Teste do Bloco 4 (Consumo e Histórico) ---');
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
console.log('PASS: Todas as migrações (incluindo 20261010130000_restaurant_service_fee_and_timezone.sql) compiladas com sucesso.');

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function runAsSuperuser(fn) {
  await db.exec(`
    set role none;
    select set_config('request.jwt.claim.sub', '', false);
    select set_config('request.jwt.claims', '{}', false);
  `);
  return fn();
}

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
    await runAsSuperuser(() => {});
  }
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
    await runAsSuperuser(() => {});
  }
}

// ============================================================================
// TESTE 1: Schema, Defaults e Constraints de Restaurante
// ============================================================================
console.log('\n--- Teste 1: Configurações do Restaurante (Taxa e Timezone) ---');
const [demoRest] = await q(`select id, slug, service_fee_percent, timezone from public.restaurants where slug = 'brasa'`);
assert.equal(Number(demoRest.service_fee_percent), 10, 'Taxa padrão deve ser 10%');
assert.equal(demoRest.timezone, 'America/Sao_Paulo', 'Timezone padrão deve ser America/Sao_Paulo');

// Constraint de taxa (0% a 30%)
let feeRejected = false;
try {
  await db.exec(`update public.restaurants set service_fee_percent = 35 where id = '${demoRest.id}'`);
} catch {
  feeRejected = true;
}
assert.ok(feeRejected, 'Taxa de 35% deve ser rejeitada pela constraint check');

let negFeeRejected = false;
try {
  await db.exec(`update public.restaurants set service_fee_percent = -1 where id = '${demoRest.id}'`);
} catch {
  negFeeRejected = true;
}
assert.ok(negFeeRejected, 'Taxa negativa deve ser rejeitada pela constraint check');
console.log('PASS: Validação de limites da taxa de serviço (0% a 30%) garantida no banco.');

// Validação de Timezone via save_restaurant_identity (válido, inválido, vazio e nulo)
const adminUserId = '00000000-0000-0000-0000-000000000001';
await runAsSuperuser(async () => {
  await q(`insert into auth.users (id, is_anonymous) values ('${adminUserId}', false) on conflict do nothing`);
  await q(`
    insert into public.restaurant_members (restaurant_id, user_id, role, active)
    values ('${demoRest.id}', '${adminUserId}', 'admin', true)
    on conflict do nothing
  `);
});

// A. Timezone válido ('America/New_York')
const [adminSaved] = await runAsStaff(adminUserId, 'admin', async () => {
  return q(`
    select public.save_restaurant_identity('brasa', 1, jsonb_build_object(
      'name', 'Brasa & Fogo',
      'subtitle', 'Churrascaria',
      'description', 'Melhores carnes',
      'address', 'Rua das Carnes, 100',
      'phone', '11999999999',
      'opening_hours', '11h às 23h',
      'theme_primary', '#000000',
      'theme_background', '#FFFFFF',
      'theme_text', '#111111',
      'logo', null,
      'cover', null,
      'service_fee_percent', 10,
      'timezone', 'America/New_York'
    )) as res
  `);
});
assert.equal(adminSaved.res.timezone, 'America/New_York', 'Timezone deve ser atualizado para America/New_York');

// B. Timezone inválido ('Fuso/Inexistente') -> DEVE FALHAR com 22023
let invalidTzFailed = false;
try {
  await runAsStaff(adminUserId, 'admin', async () => {
    return q(`
      select public.save_restaurant_identity('brasa', 2, jsonb_build_object(
        'name', 'Brasa & Fogo',
        'subtitle', 'Churrascaria',
        'description', 'Melhores carnes',
        'address', 'Rua das Carnes, 100',
        'phone', '11999999999',
        'opening_hours', '11h às 23h',
        'theme_primary', '#000000',
        'theme_background', '#FFFFFF',
        'theme_text', '#111111',
        'logo', null,
        'cover', null,
        'service_fee_percent', 10,
        'timezone', 'Fuso/Inexistente'
      ))
    `);
  });
} catch (err) {
  invalidTzFailed = true;
  assert.ok(err.message.includes('Fuso horário não reconhecido pelo sistema.'), `Erro esperado de timezone inválido: ${err.message}`);
}
assert.ok(invalidTzFailed, 'Timezone inválido deve ser rejeitado pelo PostgreSQL');

// C. Timezone vazio ('') -> DEVE FALHAR com 22023
let emptyTzFailed = false;
try {
  await runAsStaff(adminUserId, 'admin', async () => {
    return q(`
      select public.save_restaurant_identity('brasa', 2, jsonb_build_object(
        'name', 'Brasa & Fogo',
        'subtitle', 'Churrascaria',
        'description', 'Melhores carnes',
        'address', 'Rua das Carnes, 100',
        'phone', '11999999999',
        'opening_hours', '11h às 23h',
        'theme_primary', '#000000',
        'theme_background', '#FFFFFF',
        'theme_text', '#111111',
        'logo', null,
        'cover', null,
        'service_fee_percent', 10,
        'timezone', '   '
      ))
    `);
  });
} catch (err) {
  emptyTzFailed = true;
  assert.ok(err.message.includes('Informe um fuso horário válido.'), `Erro esperado de timezone vazio: ${err.message}`);
}
assert.ok(emptyTzFailed, 'Timezone vazio deve ser rejeitado');

// D. Timezone nulo (null via SQL direto) -> rejeitado por NOT NULL
let nullTzFailed = false;
try {
  await db.exec(`update public.restaurants set timezone = null where id = '${demoRest.id}'`);
} catch (err) {
  nullTzFailed = true;
}
assert.ok(nullTzFailed, 'Timezone nulo deve ser rejeitado por NOT NULL');

// Restaura para America/Sao_Paulo
await runAsStaff(adminUserId, 'admin', async () => {
  return q(`
    select public.save_restaurant_identity('brasa', 2, jsonb_build_object(
      'name', 'Brasa & Fogo',
      'subtitle', 'Churrascaria',
      'description', 'Melhores carnes',
      'address', 'Rua das Carnes, 100',
      'phone', '11999999999',
      'opening_hours', '11h às 23h',
      'theme_primary', '#000000',
      'theme_background', '#FFFFFF',
      'theme_text', '#111111',
      'logo', null,
      'cover', null,
      'service_fee_percent', 10,
      'timezone', 'America/Sao_Paulo'
    ))
  `);
});
console.log('PASS: Validações de fuso horário IANA (válido, inválido, vazio e nulo) aprovadas.');

// ============================================================================
// TESTE 2: get_public_restaurant expõe serviceFeePercent e timezone
// ============================================================================
console.log('\n--- Teste 2: get_public_restaurant ---');
const [publicData] = await q(`select public.get_public_restaurant('brasa') as r`);
assert.equal(publicData.r.serviceFeePercent, 10);
assert.equal(publicData.r.timezone, 'America/Sao_Paulo');
console.log('PASS: get_public_restaurant retorna serviceFeePercent e timezone corretamente.');

// ============================================================================
// TESTE 3: Configurar equipe, mesas e clientes
// ============================================================================
console.log('\n--- Teste 3: Cenário com Atendimento e Consumo ---');
const staffUserId = '11111111-1111-1111-1111-111111111111';
const staffMemberId = '22222222-2222-2222-2222-222222222222';
const guestA = '33333333-3333-3333-3333-333333333333';
const guestB = '44444444-4444-4444-4444-444444444444';

await runAsSuperuser(async () => {
  await q(`insert into auth.users (id, is_anonymous) values ('${staffUserId}', false) on conflict do nothing`);
  await q(`insert into auth.users (id, is_anonymous) values ('${guestA}', true) on conflict do nothing`);
  await q(`insert into auth.users (id, is_anonymous) values ('${guestB}', true) on conflict do nothing`);
  await q(`
    insert into public.restaurant_members (id, restaurant_id, user_id, role, active)
    values ('${staffMemberId}', '${demoRest.id}', '${staffUserId}', 'waiter', true)
    on conflict do nothing
  `);
  // Garantir mesas 1 e 2
  await q(`
    insert into public.restaurant_tables (restaurant_id, table_number)
    values ('${demoRest.id}', 1), ('${demoRest.id}', 2)
    on conflict (restaurant_id, table_number) do nothing
  `);
});

// Garçom abre atendimento na Mesa 1
const [table1] = await q(`select id from public.restaurant_tables where restaurant_id = '${demoRest.id}' and table_number = 1`);
const [visit1] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`
    select * from public.open_table_visit('brasa', 1)
  `);
});
const visitId = visit1.id;
assert.ok(visitId, 'Atendimento deve ser aberto');

// Garçom cria comanda 'Mesa 01'
const tabId = '55555555-5555-5555-5555-555555555555';
const [tab1] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.create_table_tab('brasa', '${visitId}', 'Mesa 01', '${tabId}')`);
});
assert.equal(tab1.id, tabId, 'Comanda deve ser criada com o ID especificado');

// Criar sessão ativa confirmada para Guest A na Mesa 1 e vincular à comanda
const [{ id: sessionAId }] = await runAsSuperuser(async () => {
  return q(`
    insert into public.guest_sessions (
      restaurant_id, restaurant_table_id, table_visit_id, confirmed_by_member_id,
      confirmed_at, user_id, status, expires_at
    ) values (
      '${demoRest.id}', '${table1.id}', '${visitId}', '${staffMemberId}',
      now(), '${guestA}', 'active', now() + interval '2 hours'
    ) returning id
  `);
});

await runAsSuperuser(async () => {
  await q(`
    insert into public.table_tab_guests (
      guest_session_id, table_tab_id, table_visit_id,
      restaurant_id, restaurant_table_id, linked_by_member_id
    ) values (
      '${sessionAId}', '${tabId}', '${visitId}',
      '${demoRest.id}', '${table1.id}', '${staffMemberId}'
    )
  `);
});

// Inserir categorias e produtos de teste no catálogo
await runAsSuperuser(async () => {
  await q(`
    insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
    values ('11111111-2222-3333-4444-555555555555', '${demoRest.id}', 'test-cat', 'Cardápio', 'cardapio', 1, true)
    on conflict do nothing
  `);

  await q(`
    insert into public.menu_products (
      id, restaurant_id, category_id, catalog_key, slug, name,
      short_description, description, price_in_cents, available, featured, sort_order
    ) values
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '${demoRest.id}', '11111111-2222-3333-4444-555555555555', 'prod-a', 'prod-a', 'Prato Principal', '', '', 5000, true, false, 1),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '${demoRest.id}', '11111111-2222-3333-4444-555555555555', 'prod-b', 'prod-b', 'Bebida', '', '', 1500, true, false, 2),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '${demoRest.id}', '11111111-2222-3333-4444-555555555555', 'prod-c', 'prod-c', 'Sobremesa Cancelada', '', '', 2000, true, false, 3),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', '${demoRest.id}', '11111111-2222-3333-4444-555555555555', 'prod-d', 'prod-d', 'Vinho', '', '', 10000, true, false, 4)
    on conflict do nothing
  `);
});

// Garçom lança consumo via RPC oficial add_table_tab_item e cancela item de 20,00
const itemAId = 'a1111111-1111-1111-1111-111111111111';
const itemBId = 'b1111111-1111-1111-1111-111111111111';
const itemCId = 'c1111111-1111-1111-1111-111111111111';

await runAsStaff(staffUserId, 'waiter', async () => {
  await q(`select public.add_table_tab_item('brasa', '${tabId}', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '${itemAId}')`);
  await q(`select public.add_table_tab_item('brasa', '${tabId}', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 2, '${itemBId}')`);
  await q(`select public.add_table_tab_item('brasa', '${tabId}', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1, '${itemCId}')`);
  await q(`select public.cancel_table_tab_item('brasa', '${itemCId}', 'Cliente desistiu da sobremesa')`);
});

console.log('PASS: Itens de consumo lançados via RPC oficial (Subtotal ativo: 80,00; cancelado ignorado: 20,00).');

// ============================================================================
// ============================================================================
// TESTE 4: Pedido de Conta com Dois Participantes na Mesma Comanda
// Regra: Segundo participante NÃO PODE sobrescrever a preferência do primeiro.
// ============================================================================
console.log('\n--- Teste 4: Pedido de Conta com Dois Participantes (Preservação de Preferência) ---');

// Vincular Guest B também à comanda Mesa 01 (comanda compartilhada)
const [{ id: sessionA2Id }] = await runAsSuperuser(async () => {
  return q(`
    insert into public.guest_sessions (
      restaurant_id, restaurant_table_id, table_visit_id, confirmed_by_member_id,
      confirmed_at, user_id, status, expires_at
    ) values (
      '${demoRest.id}', '${table1.id}', '${visitId}', '${staffMemberId}',
      now(), '${guestB}', 'active', now() + interval '2 hours'
    ) returning id
  `);
});

await runAsSuperuser(async () => {
  await q(`
    insert into public.table_tab_guests (
      guest_session_id, table_tab_id, table_visit_id,
      restaurant_id, restaurant_table_id, linked_by_member_id
    ) values (
      '${sessionA2Id}', '${tabId}', '${visitId}',
      '${demoRest.id}', '${table1.id}', '${staffMemberId}'
    )
  `);
});

// Participante 1 (Guest A) pede a conta com taxa ACEITA (include_service_fee = true)
const [billResultA] = await runAsGuest(guestA, async () => {
  return q(`
    select public.request_table_tab_bill('brasa', '${tabId}', true) as res
  `);
});
assert.equal(billResultA.res.status, 'created');
assert.equal(billResultA.res.request.include_service_fee, true, 'Cliente 1 registrou include_service_fee como true');

// Participante 2 (Guest B) tenta pedir a conta com taxa RECUSADA (include_service_fee = false)
const [billResultB] = await runAsGuest(guestB, async () => {
  return q(`
    select public.request_table_tab_bill('brasa', '${tabId}', false) as res
  `);
});
assert.equal(billResultB.res.status, 'existing', 'Pedido deve retornar como existente');
assert.equal(billResultB.res.request.include_service_fee, true, 'A preferência original (true) NÃO pode ser sobrescrita pelo participante 2!');

// Verifica no banco se a solicitação pendente permaneceu com include_service_fee = true
const [dbRequest] = await q(`select include_service_fee from public.service_requests where id = '${billResultA.res.request.id}'`);
assert.equal(dbRequest.include_service_fee, true, 'No banco de dados include_service_fee permanece estritamente inalterado');
console.log('PASS: Imutabilidade da preferência garantida. O segundo participante não sobrescreve o primeiro.');

// ============================================================================
// TESTE 5: Fechamento da Comanda — Confirmação Obrigatória da Equipe
// ============================================================================
console.log('\n--- Teste 5: Fechamento com Confirmação Obrigatória da Taxa pela Equipe ---');

// 5.1 Tentativa de fechamento sem informar decisão da taxa quando taxa do restaurante > 0% -> deve falhar com 22023
let missingDecisionFailed = false;
try {
  await runAsStaff(staffUserId, 'waiter', async () => {
    return q(`select * from public.close_table_tab('brasa', '${tabId}')`);
  });
} catch (err) {
  missingDecisionFailed = true;
  assert.ok(err.message.includes('Informe se a taxa de serviço foi aceita pelo cliente antes de fechar a comanda.'), `Mensagem esperada obtida: ${err.message}`);
}
assert.ok(missingDecisionFailed, 'Fechamento sem p_final_service_fee_accepted deve lançar exceção 22023 quando taxa > 0%');
console.log('PASS: Fechamento rejeitado com 22023 quando equipe não informa explicitamente a decisão da taxa.');

// 5.2 Fechamento informando p_final_service_fee_accepted = true (taxa confirmada pela equipe)
const [closedTab] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`
    select * from public.close_table_tab('brasa', '${tabId}', true)
  `);
});

// Subtotal ativo: 5000 + 3000 = 8000 centavos (R$ 80,00)
// Taxa de 10%: round(8000 * 0.10) = 800 centavos (R$ 8,00)
// Total: 8000 + 800 = 8800 centavos (R$ 88,00)
assert.equal(closedTab.status, 'closed');
assert.equal(closedTab.subtotal_in_cents, 8000, 'Subtotal deve ser 8000 centavos (excluindo item cancelado)');
assert.equal(Number(closedTab.service_fee_percent), 10, 'Percentual aplicado deve ser 10%');
assert.equal(closedTab.service_fee_in_cents, 800, 'Taxa calculada deve ser 800 centavos');
assert.equal(closedTab.total_in_cents, 8800, 'Total deve ser 8800 centavos (subtotal + taxa)');
assert.equal(closedTab.service_fee_accepted, true, 'Taxa deve constar como aceita');
console.log('PASS: Comanda fechada com taxa aceita (true) calcula total = subtotal + 10%.');

// 5.3 Teste de Idempotência do Fechamento
const [closedAgain] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`
    select * from public.close_table_tab('brasa', '${tabId}', false)
  `);
});
assert.equal(closedAgain.total_in_cents, 8800, 'Segunda chamada a close_table_tab retorna snapshot idêntico');
console.log('PASS: Fechamento de comanda é estritamente idempotente.');

// 5.4 Teste de Imutabilidade Histórica: mesmo que a taxa do restaurante mude no futuro, o snapshot não se altera
await runAsSuperuser(async () => {
  await q(`update public.restaurants set service_fee_percent = 20 where id = '${demoRest.id}'`);
});
const [verifiedTab] = await q(`select subtotal_in_cents, service_fee_percent, total_in_cents from public.table_tabs where id = '${tabId}'`);
assert.equal(Number(verifiedTab.service_fee_percent), 10, 'Snapshot preserva a taxa histórica de 10%');
assert.equal(verifiedTab.total_in_cents, 8800, 'Total do snapshot permanece R$ 88,00 inalterado');
console.log('PASS: Snapshot contábil imutável e protegido contra alterações futuras na taxa do restaurante.');

// Restaura taxa para 10%
await runAsSuperuser(async () => {
  await q(`update public.restaurants set service_fee_percent = 10 where id = '${demoRest.id}'`);
});

// ============================================================================
// TESTE 6: Comanda com Taxa DISPENSADA pela Equipe (false)
// ============================================================================
console.log('\n--- Teste 6: Comanda com Taxa Dispensada pela Equipe (false) ---');
// Mesa 2
const [table2] = await q(`select id from public.restaurant_tables where restaurant_id = '${demoRest.id}' and table_number = 2`);
const [visit2] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.open_table_visit('brasa', 2)`);
});
const visitId2 = visit2.id;

// Garçom abre comanda 'Mesa 02'
const tabId2 = '66666666-6666-6666-6666-666666666666';
const [tab2] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.create_table_tab('brasa', '${visitId2}', 'Mesa 02', '${tabId2}')`);
});
assert.equal(tab2.id, tabId2, 'Comanda 2 deve ser criada');

// Criar novo guest C para a Mesa 2
const guestC = '77777777-7777-7777-7777-777777777777';
await runAsSuperuser(async () => {
  await q(`insert into auth.users (id, is_anonymous) values ('${guestC}', true) on conflict do nothing`);
});

const [{ id: sessionCId }] = await runAsSuperuser(async () => {
  return q(`
    insert into public.guest_sessions (
      restaurant_id, restaurant_table_id, table_visit_id, confirmed_by_member_id,
      confirmed_at, user_id, status, expires_at
    ) values (
      '${demoRest.id}', '${table2.id}', '${visitId2}', '${staffMemberId}',
      now(), '${guestC}', 'active', now() + interval '2 hours'
    ) returning id
  `);
});

await runAsSuperuser(async () => {
  await q(`
    insert into public.table_tab_guests (
      guest_session_id, table_tab_id, table_visit_id,
      restaurant_id, restaurant_table_id, linked_by_member_id
    ) values (
      '${sessionCId}', '${tabId2}', '${visitId2}',
      '${demoRest.id}', '${table2.id}', '${staffMemberId}'
    )
  `);
});

// Garçom lança item na Mesa 2 (Vinho 100,00) via add_table_tab_item
const itemDId = 'd1111111-1111-1111-1111-111111111111';
await runAsStaff(staffUserId, 'waiter', async () => {
  await q(`select public.add_table_tab_item('brasa', '${tabId2}', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 1, '${itemDId}')`);
});

// Mesmo que o cliente tenha manifestado interesse em pagar a taxa no pedido de conta:
await runAsGuest(guestC, async () => {
  await q(`select public.request_table_tab_bill('brasa', '${tabId2}', true) as res`);
});

// No caixa/salão, a equipe confirma que a taxa foi DISPENSADA (p_final_service_fee_accepted = false):
const [closedTab2] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.close_table_tab('brasa', '${tabId2}', false)`);
});

assert.equal(closedTab2.subtotal_in_cents, 10000);
assert.equal(Number(closedTab2.service_fee_percent), 0, 'Percentual deve ser 0% pois a equipe dispensou a taxa');
assert.equal(closedTab2.service_fee_in_cents, 0, 'Valor da taxa deve ser 0');
assert.equal(closedTab2.total_in_cents, 10000, 'Total deve ser igual ao subtotal sem acréscimo');
assert.equal(closedTab2.service_fee_accepted, false, 'service_fee_accepted deve ser false');
console.log('PASS: Equipe dispensa taxa (false) e decisão da equipe prevalece soberanamente sobre a preferência informativa.');

// ============================================================================
// TESTE 6B: Restaurante com Taxa de Serviço 0% (Não exige escolha da equipe)
// ============================================================================
console.log('\n--- Teste 6B: Restaurante com Taxa de Serviço 0% ---');
await runAsSuperuser(async () => {
  await q(`update public.restaurants set service_fee_percent = 0 where id = '${demoRest.id}'`);
});

// Garçom abre comanda 'Mesa 02 - Segunda'
const tabIdZeroFee = '88888888-8888-8888-8888-888888888888';
await runAsStaff(staffUserId, 'waiter', async () => {
  await q(`select * from public.create_table_tab('brasa', '${visitId2}', 'Mesa 02 - Segunda', '${tabIdZeroFee}')`);
});

const itemZeroFeeId = 'e1111111-1111-1111-1111-111111111111';
await runAsStaff(staffUserId, 'waiter', async () => {
  await q(`select public.add_table_tab_item('brasa', '${tabIdZeroFee}', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, '${itemZeroFeeId}')`);
});

// Fechamento sem p_final_service_fee_accepted (ou null) deve funcionar normalmente pois taxa do restaurante é 0%
const [closedTabZeroFee] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.close_table_tab('brasa', '${tabIdZeroFee}')`);
});
assert.equal(closedTabZeroFee.subtotal_in_cents, 1500);
assert.equal(Number(closedTabZeroFee.service_fee_percent), 0);
assert.equal(closedTabZeroFee.service_fee_in_cents, 0);
assert.equal(closedTabZeroFee.total_in_cents, 1500);
assert.equal(closedTabZeroFee.service_fee_accepted, false);
console.log('PASS: Restaurante com taxa 0% fecha comanda diretamente sem exigir escolha de taxa.');

// ============================================================================
// TESTE 6C: Proteção e Integridade do Snapshot Financeiro (Etapa 2)
// 1. Tentar adicionar item após fechamento (deve falhar)
// 2. Tentar cancelar item após fechamento (deve falhar)
// 3. Tentar alterar valores de comanda encerrada usando caminhos de acesso permitidos (deve falhar)
// 4. Validar snapshot parcialmente nulo (constraint check deve rejeitar)
// 5. Validar comanda histórica sem snapshot (todos os 5 campos nulos, deve ser permitida)
// 6. Verificar idempotência estrita de fechamento repetido
// ============================================================================
console.log('\n--- Teste 6C: Proteção e Integridade Financeira de Comandas Encerradas (Etapa 2) ---');

// 1. Tentar adicionar item na comanda encerrada tabId (deve falhar via RPC add_table_tab_item)
let addItemAfterCloseFailed = false;
try {
  const lateItemId = 'f1111111-1111-1111-1111-111111111111';
  await runAsStaff(staffUserId, 'waiter', async () => {
    await q(`select public.add_table_tab_item('brasa', '${tabId}', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, '${lateItemId}')`);
  });
} catch (err) {
  addItemAfterCloseFailed = true;
  assert.ok(err.message.includes('Não é possível registrar consumo em uma comanda encerrada.'), `Erro esperado ao adicionar: ${err.message}`);
}
assert.ok(addItemAfterCloseFailed, 'Adicionar item em comanda encerrada DEVE ser proibido');
console.log('PASS: Bloqueio confirmado — não é possível adicionar consumo em comanda encerrada.');

// 2. Tentar cancelar item existente (itemAId) de comanda encerrada (deve falhar via RPC cancel_table_tab_item)
let cancelItemAfterCloseFailed = false;
try {
  await runAsStaff(staffUserId, 'waiter', async () => {
    await q(`select public.cancel_table_tab_item('brasa', '${itemAId}', 'Cancelamento tardio pós-fechamento')`);
  });
} catch (err) {
  cancelItemAfterCloseFailed = true;
  assert.ok(err.message.includes('Não é possível cancelar consumo em uma comanda encerrada.'), `Erro esperado ao cancelar: ${err.message}`);
}
assert.ok(cancelItemAfterCloseFailed, 'Cancelar item em comanda encerrada DEVE ser proibido');
console.log('PASS: Bloqueio confirmado — não é possível cancelar consumo em comanda encerrada.');

// 3. Tentar alterar valores financeiros de comanda encerrada via UPDATE direto (bloqueado por trigger validate_table_tab_write)
let directUpdateFailed = false;
try {
  await db.exec(`
    update public.table_tabs
    set total_in_cents = 0, subtotal_in_cents = 0
    where id = '${tabId}'
  `);
} catch (err) {
  directUpdateFailed = true;
  assert.ok(err.message.includes('Uma comanda encerrada não pode ser alterada.'), `Erro esperado no update: ${err.message}`);
}
assert.ok(directUpdateFailed, 'UPDATE direto em comanda encerrada DEVE ser bloqueado pela trigger do banco');
console.log('PASS: Trigger validate_table_tab_write impede qualquer alteração em comanda encerrada.');

// 4. Testes da Constraint table_tabs_financial_snapshot_check com Valores Parcialmente Nulos:
// Caso 4A: Comanda fechada com subtotal presente mas total nulo -> DEVE FALHAR
let partialNullA = false;
try {
  await db.exec(`
    insert into public.table_tabs (
      id, restaurant_id, restaurant_table_id, table_visit_id, label, status,
      created_by_member_id, subtotal_in_cents, service_fee_percent, service_fee_in_cents, total_in_cents, service_fee_accepted
    ) values (
      '99999999-9999-9999-9999-999999999901', '${demoRest.id}', '${table1.id}', '${visitId}',
      'Teste Parcial A', 'closed', '${staffMemberId}',
      5000, 10, 500, null, true
    )
  `);
} catch (err) {
  partialNullA = true;
}
assert.ok(partialNullA, 'Constraint deve rejeitar comanda fechada com total_in_cents nulo');

// Caso 4B: Comanda fechada com service_fee_percent nulo mas subtotal presente -> DEVE FALHAR
let partialNullB = false;
try {
  await db.exec(`
    insert into public.table_tabs (
      id, restaurant_id, restaurant_table_id, table_visit_id, label, status,
      created_by_member_id, subtotal_in_cents, service_fee_percent, service_fee_in_cents, total_in_cents, service_fee_accepted
    ) values (
      '99999999-9999-9999-9999-999999999902', '${demoRest.id}', '${table1.id}', '${visitId}',
      'Teste Parcial B', 'closed', '${staffMemberId}',
      5000, null, 500, 5500, true
    )
  `);
} catch (err) {
  partialNullB = true;
}
assert.ok(partialNullB, 'Constraint deve rejeitar comanda fechada com service_fee_percent nulo');

// Caso 4C: Comanda fechada com service_fee_accepted nulo -> DEVE FALHAR
let partialNullC = false;
try {
  await db.exec(`
    insert into public.table_tabs (
      id, restaurant_id, restaurant_table_id, table_visit_id, label, status,
      created_by_member_id, subtotal_in_cents, service_fee_percent, service_fee_in_cents, total_in_cents, service_fee_accepted
    ) values (
      '99999999-9999-9999-9999-999999999903', '${demoRest.id}', '${table1.id}', '${visitId}',
      'Teste Parcial C', 'closed', '${staffMemberId}',
      5000, 10, 500, 5500, null
    )
  `);
} catch (err) {
  partialNullC = true;
}
assert.ok(partialNullC, 'Constraint deve rejeitar comanda fechada com service_fee_accepted nulo');

// Caso 4D: Comanda aberta com valores financeiros preenchidos -> DEVE FALHAR
let openWithSnapshot = false;
try {
  await db.exec(`
    insert into public.table_tabs (
      id, restaurant_id, restaurant_table_id, table_visit_id, label, status,
      created_by_member_id, subtotal_in_cents
    ) values (
      '99999999-9999-9999-9999-999999999904', '${demoRest.id}', '${table1.id}', '${visitId}',
      'Teste Aberta Snapshot', 'open', '${staffMemberId}',
      5000
    )
  `);
} catch (err) {
  openWithSnapshot = true;
}
assert.ok(openWithSnapshot, 'Constraint deve rejeitar comanda aberta com subtotal_in_cents preenchido');

// Caso 4E: Comanda histórica pré-existente (fechada com todos os 5 campos nulos) -> DEVE PASSAR
await db.exec(`
  insert into public.table_tabs (
    id, restaurant_id, restaurant_table_id, table_visit_id, label, status,
    created_by_member_id
  ) values (
    '99999999-9999-9999-9999-999999999905', '${demoRest.id}', '${table1.id}', '${visitId}',
    'Histórica Sem Snapshot', 'open', '${staffMemberId}'
  );
  update public.table_tabs
  set status = 'closed', closed_by_member_id = '${staffMemberId}', closed_at = now()
  where id = '99999999-9999-9999-9999-999999999905';
`);
const [historicalTab] = await q(`select id, status, total_in_cents from public.table_tabs where id = '99999999-9999-9999-9999-999999999905'`);
assert.equal(historicalTab.status, 'closed');
assert.equal(historicalTab.total_in_cents, null, 'Comanda histórica sem snapshot preservada');
console.log('PASS: Constraint table_tabs_financial_snapshot_check validada: proíbe nulos parciais e preserva dados históricos.');

// 5. Teste de fechamento repetido e idempotência contábil
const [repeatClose1] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.close_table_tab('brasa', '${tabId}', true)`);
});
const [repeatClose2] = await runAsStaff(staffUserId, 'waiter', async () => {
  return q(`select * from public.close_table_tab('brasa', '${tabId}', false)`);
});
assert.equal(repeatClose1.total_in_cents, 8800);
assert.equal(repeatClose2.total_in_cents, 8800);
assert.equal(repeatClose1.service_fee_accepted, true);
assert.equal(repeatClose2.service_fee_accepted, true, 'Mesmo passando false na segunda chamada, o snapshot original não é alterado');
console.log('PASS: Idempotência contábil estrita confirmada em fechamento repetido.');

// ============================================================================
// TESTE 7: Histórico e Filtro Semiaberto com Timezone
// ============================================================================
console.log('\n--- Teste 7: Histórico de Atendimentos e Intervalo de Datas com Timezone ---');

// Encerrar atendimentos para constarem no histórico
await runAsSuperuser(async () => {
  // Visita 1 aberta às 13:00 BRT e fechada às 15:00 BRT (18:00 UTC) em 2026-10-10
  await q(`
    update public.table_visits
    set status = 'closed',
        opened_at = '2026-10-10T16:00:00Z',
        closed_at = '2026-10-10T18:00:00Z'
    where id = '${visitId}'
  `);
  // Visita 2 aberta às 22:00 BRT e fechada às 23:30 BRT em 2026-10-09 (02:30 UTC de 2026-10-10)
  await q(`
    update public.table_visits
    set status = 'closed',
        opened_at = '2026-10-10T01:00:00Z',
        closed_at = '2026-10-10T02:30:00Z'
    where id = '${visitId2}'
  `);
});

// Para o dia 2026-10-10 no fuso America/Sao_Paulo (UTC-3):
// Início: 2026-10-10 00:00:00 BRT -> 2026-10-10 03:00:00 UTC
// Fim (próximo dia): 2026-10-11 00:00:00 BRT -> 2026-10-11 03:00:00 UTC
const startUtc10 = '2026-10-10T03:00:00.000Z';
const nextDayUtc10 = '2026-10-11T03:00:00.000Z';

const visitsDay10 = await q(`
  select id from public.table_visits
  where restaurant_id = '${demoRest.id}'
    and assigned_member_id = '${staffMemberId}'
    and status = 'closed'
    and closed_at >= '${startUtc10}'
    and closed_at < '${nextDayUtc10}'
  order by closed_at desc, id desc
`);
assert.equal(visitsDay10.length, 1, 'Apenas a visita 1 deve ser encontrada no dia 10');
assert.equal(visitsDay10[0].id, visitId);

// Para o dia 2026-10-09 no fuso America/Sao_Paulo (UTC-3):
// Início: 2026-10-09 03:00:00 UTC
// Fim: 2026-10-10 03:00:00 UTC
const startUtc09 = '2026-10-09T03:00:00.000Z';
const nextDayUtc09 = '2026-10-10T03:00:00.000Z';

const visitsDay09 = await q(`
  select id from public.table_visits
  where restaurant_id = '${demoRest.id}'
    and assigned_member_id = '${staffMemberId}'
    and status = 'closed'
    and closed_at >= '${startUtc09}'
    and closed_at < '${nextDayUtc09}'
  order by closed_at desc, id desc
`);
assert.equal(visitsDay09.length, 1, 'A visita 2 (encerrada às 23:30 BRT) deve cair no dia 09');
assert.equal(visitsDay09[0].id, visitId2);

console.log('PASS: Filtro semiaberto [gte, lt) com conversão de timezone agrupa os atendimentos com perfeição.');

// ============================================================================
// TESTE 8: Precisão da Função getTimezoneUtcRange (Viradas de Mês, Ano e Horário de Verão)
// ============================================================================
console.log('\n--- Teste 8: Precisão de Conversão de Datas e Horário de Verão ---');

function getTimezoneUtcRange(dateStr, timeZone) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
    });

    const testDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const parts = formatter.formatToParts(testDate);
    const tzYear = Number(parts.find((p) => p.type === 'year')?.value);
    const tzMonth = Number(parts.find((p) => p.type === 'month')?.value);
    const tzDay = Number(parts.find((p) => p.type === 'day')?.value);
    let tzHour = Number(parts.find((p) => p.type === 'hour')?.value);
    if (tzHour === 24) tzHour = 0;
    const tzMin = Number(parts.find((p) => p.type === 'minute')?.value);

    const tzTimeAsUtc = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMin, 0);
    const offsetMs = tzTimeAsUtc - testDate.getTime();

    const startUtcMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
    const nextDayUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

    return {
        startUtc: new Date(startUtcMs).toISOString(),
        nextDayStartUtc: new Date(nextDayUtcMs).toISOString(),
    };
}

// 8.1 Fuso Brasil (America/Sao_Paulo, UTC-3)
const rangeSP = getTimezoneUtcRange('2026-10-10', 'America/Sao_Paulo');
assert.equal(rangeSP.startUtc, '2026-10-10T03:00:00.000Z');
assert.equal(rangeSP.nextDayStartUtc, '2026-10-11T03:00:00.000Z');

// 8.2 Virada de ano e mês (31 de dezembro para 1º de janeiro)
const rangeYearEnd = getTimezoneUtcRange('2026-12-31', 'America/Sao_Paulo');
assert.equal(rangeYearEnd.startUtc, '2026-12-31T03:00:00.000Z');
assert.equal(rangeYearEnd.nextDayStartUtc, '2027-01-01T03:00:00.000Z');

// 8.3 Fuso com Horário de Verão ativo (Nova York no verão: UTC-4)
const rangeNYSummer = getTimezoneUtcRange('2026-07-01', 'America/New_York');
assert.equal(rangeNYSummer.startUtc, '2026-07-01T04:00:00.000Z');
assert.equal(rangeNYSummer.nextDayStartUtc, '2026-07-02T04:00:00.000Z');

// 8.4 Fuso com Horário de Inverno / Padrão (Nova York no inverno: UTC-5)
const rangeNYWinter = getTimezoneUtcRange('2026-01-15', 'America/New_York');
assert.equal(rangeNYWinter.startUtc, '2026-01-15T05:00:00.000Z');
assert.equal(rangeNYWinter.nextDayStartUtc, '2026-01-16T05:00:00.000Z');

// 8.5 Fuso à frente de UTC (Tóquio: UTC+9)
const rangeTokyo = getTimezoneUtcRange('2026-10-10', 'Asia/Tokyo');
assert.equal(rangeTokyo.startUtc, '2026-10-09T15:00:00.000Z');
assert.equal(rangeTokyo.nextDayStartUtc, '2026-10-10T15:00:00.000Z');

console.log('PASS: Função getTimezoneUtcRange validada em viradas de dia, mês, ano e horários de verão/inverno.');

console.log('\n--- Teste 9: Ciclo Completo de Atendimento do Garçom (pending -> attended -> completed -> novo chamado) ---');
const waiterGuestId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const waiterStaffId = '11111111-1111-1111-1111-111111111111';

await runAsSuperuser(async () => {
    await q(`insert into auth.users (id, is_anonymous) values ('${waiterGuestId}', true) on conflict do nothing;`);
    await q(`insert into auth.users (id, is_anonymous) values ('${waiterStaffId}', false) on conflict do nothing;`);
    await q(`
        insert into public.restaurant_members (restaurant_id, user_id, role, active)
        values ('${demoRest.id}', '${waiterStaffId}', 'waiter', true)
        on conflict do nothing;
    `);
});

// 9.1 Cliente anônimo chama garçom na mesa 1
const reqWaiter1 = await runAsGuest(waiterGuestId, async () => {
    const res = await q(`select public.request_waiter('brasa', 1) as data;`);
    return res[0].data;
});
assert.equal(reqWaiter1.status, 'created');
assert.ok(reqWaiter1.request.id);
const firstRequestId = reqWaiter1.request.id;

// 9.2 Garçom atende o chamado
const attendRes = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.attend_waiter_request('brasa', $1::uuid);`, [firstRequestId]);
    return res[0];
});
assert.equal(attendRes.status, 'attended');

// 9.3 Garçom conclui o atendimento (chegou à mesa)
const completeRes = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.complete_waiter_request('brasa', $1::uuid);`, [firstRequestId]);
    return res[0];
});
assert.equal(completeRes.status, 'completed');

// 9.4 Cliente consulta get_waiter_request_state: deve retornar request = null (liberado para novo chamado!)
const waiterStateAfterComplete = await runAsGuest(waiterGuestId, async () => {
    const res = await q(`select public.get_waiter_request_state('brasa', 1) as data;`);
    return res[0].data;
});
assert.equal(waiterStateAfterComplete.request, null);

// 9.5 Cliente faz novo chamado: deve gerar novo ciclo com ID diferente sem apagar histórico!
const reqWaiter2 = await runAsGuest(waiterGuestId, async () => {
    const res = await q(`select public.request_waiter('brasa', 1) as data;`);
    return res[0].data;
});
assert.equal(reqWaiter2.status, 'created');
assert.notEqual(reqWaiter2.request.id, firstRequestId);

// 9.6 Verificar histórico: ambos os chamados estão preservados na tabela
const historyCount = await runAsSuperuser(async () => {
    const res = await q(`select count(*)::int as total from public.service_requests where restaurant_id = '${demoRest.id}' and restaurant_table_id = (select id from public.restaurant_tables where restaurant_id = '${demoRest.id}' and table_number = 1 limit 1);`);
    return res[0].total;
});
assert.ok(historyCount >= 2);
console.log('PASS: Ciclo completo do chamado validado com sucesso (pending -> attended -> completed -> novo chamado independente com histórico preservado).');

console.log('\n--- Teste 10: Segurança, Atribuição e Permissões entre Garçons e Administrador ---');
const waiterStaffId2 = '22222222-2222-2222-2222-222222222222';

await runAsSuperuser(async () => {
    await q(`insert into auth.users (id, is_anonymous) values ('${waiterStaffId2}', false) on conflict do nothing;`);
    await q(`
        insert into public.restaurant_members (restaurant_id, user_id, role, active)
        values ('${demoRest.id}', '${waiterStaffId2}', 'waiter', true)
        on conflict do nothing;
    `);
});

// 10.1 Garçom 1 assume o novo chamado (reqWaiter2)
const attendRes2 = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.attend_waiter_request('brasa', $1::uuid);`, [reqWaiter2.request.id]);
    return res[0];
});
assert.equal(attendRes2.status, 'attended');

// 10.2 Garçom 2 TENTA concluir o atendimento assumido pelo Garçom 1: DEVE FALHAR com 42501!
let otherWaiterBlocked = false;
try {
    await runAsStaff(waiterStaffId2, 'waiter', async () => {
        await q(`select * from public.complete_waiter_request('brasa', $1::uuid);`, [reqWaiter2.request.id]);
    });
} catch (err) {
    otherWaiterBlocked = err.code === '42501' || err.message.includes('responsável ou um administrador');
}
assert.ok(otherWaiterBlocked, 'Outro garçom não deve conseguir concluir atendimento alheio');
console.log('PASS: Outro garçom é estritamente impedido de concluir atendimento alheio (42501).');

// 10.3 Administrador executa conclusão excepcional: DEVE TER SUCESSO!
const adminComplete = await runAsStaff(adminUserId, 'admin', async () => {
    const res = await q(`select * from public.complete_waiter_request('brasa', $1::uuid);`, [reqWaiter2.request.id]);
    return res[0];
});
assert.equal(adminComplete.status, 'completed');
console.log('PASS: Administrador autorizado pode concluir atendimento excepcionalmente.');

console.log('\n--- Teste 11: Encerramento de Mesa, Proteção Financeira e Cancelamento de Chamados ---');
// 11.1 Criar atendimento da mesa 2 com comanda aberta e chamado pendente
const waiterGuestId2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
await runAsSuperuser(async () => {
    await q(`insert into auth.users (id, is_anonymous) values ('${waiterGuestId2}', true) on conflict do nothing;`);
});

const visitMesa2 = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.open_table_visit('brasa', 2);`);
    return res[0];
});

// Criar comanda aberta na mesa 2
const tabIdMesa2 = '33333333-3333-3333-3333-333333333333';
const tabMesa2 = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.create_table_tab('brasa', $1::uuid, 'Comanda 1', $2::uuid);`, [visitMesa2.id, tabIdMesa2]);
    return res[0];
});

// Cliente chama garçom na mesa 2
const reqWaiterMesa2 = await runAsGuest(waiterGuestId2, async () => {
    const res = await q(`select public.request_waiter('brasa', 2) as data;`);
    return res[0].data;
});
assert.equal(reqWaiterMesa2.status, 'created');

// 11.2 Tentativa de fechar a mesa com comanda aberta: DEVE FALHAR (exige fechar comandas primeiro!)
let closeBlockedWithOpenTab = false;
try {
    await runAsStaff(waiterStaffId, 'waiter', async () => {
        await q(`select * from public.close_table_visit('brasa', $1::uuid);`, [visitMesa2.id]);
    });
} catch (err) {
    closeBlockedWithOpenTab = err.code === '22023' && err.message.includes('Encerre todas as comandas abertas');
}
assert.ok(closeBlockedWithOpenTab, 'Fechamento de mesa deve ser estritamente bloqueado quando há comandas abertas');
console.log('PASS: Bloqueio financeiro garantido — mesa não pode ser fechada com comandas abertas.');

// 11.3 Fechar comanda da mesa 2 (taxa dispensada pela equipe)
await runAsStaff(waiterStaffId, 'waiter', async () => {
    await q(`select * from public.close_table_tab('brasa', $1::uuid, false);`, [tabMesa2.id]);
});

// 11.4 Fechar mesa agora: DEVE TER SUCESSO e cancelar automaticamente o chamado em aberto da mesa!
const closedVisitMesa2 = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.close_table_visit('brasa', $1::uuid);`, [visitMesa2.id]);
    return res[0];
});
assert.equal(closedVisitMesa2.status, 'closed');

// Verificar se o chamado da mesa 2 foi cancelado
const [mesa2ReqStatus] = await runAsSuperuser(async () => {
    return q(`select status from public.service_requests where id = $1::uuid;`, [reqWaiterMesa2.request.id]);
});
assert.equal(mesa2ReqStatus.status, 'cancelled');
console.log('PASS: Fechamento de mesa autorizado cancela automaticamente chamados em aberto e preserva histórico.');

// 11.5 Testar RPC dismiss_table_service_requests (ação excepcional por mesa)
const reqWaiterMesa3 = await runAsGuest(waiterGuestId, async () => {
    const res = await q(`select public.request_waiter('brasa', 3) as data;`);
    return res[0].data;
});
assert.equal(reqWaiterMesa3.status, 'created');

const dismissedCount = await runAsStaff(adminUserId, 'admin', async () => {
    const res = await q(`select public.dismiss_table_service_requests('brasa', 3) as count;`);
    return res[0].count;
});
assert.ok(dismissedCount >= 1);

const [mesa3ReqStatus] = await runAsSuperuser(async () => {
    return q(`select status from public.service_requests where id = $1::uuid;`, [reqWaiterMesa3.request.id]);
});
assert.equal(mesa3ReqStatus.status, 'cancelled');
console.log('PASS: RPC dismiss_table_service_requests encerra chamados da mesa selecionada com rastreabilidade.');

// ============================================================================
// TESTE 12: Gerenciamento de Comandas por Administrador do Restaurante (Bloco 8.2)
// ============================================================================
console.log('\n--- Teste 12: Permissões de Administração de Comandas por Administradores e Garçons ---');

const inactiveUserId = '33333333-3333-3333-3333-333333333333';
const outsiderUserId = '44444444-4444-4444-4444-444444444444';
const [nomaRest] = await q(`select id from public.restaurants where slug = 'noma';`);

await runAsSuperuser(async () => {
    await q(`insert into auth.users (id, is_anonymous) values ('${inactiveUserId}', false) on conflict do nothing;`);
    await q(`insert into auth.users (id, is_anonymous) values ('${outsiderUserId}', false) on conflict do nothing;`);
    // Membro inativo no restaurante brasa
    await q(`
        insert into public.restaurant_members (restaurant_id, user_id, role, active)
        values ('${demoRest.id}', '${inactiveUserId}', 'waiter', false)
        on conflict do nothing;
    `);
    // Membro de outro restaurante (noma)
    await q(`
        insert into public.restaurant_members (restaurant_id, user_id, role, active)
        values ('${nomaRest.id}', '${outsiderUserId}', 'admin', true)
        on conflict do nothing;
    `);
    // Restaurar taxa de serviço de brasa para 10% para teste de fechamento com taxa
    await q(`update public.restaurants set service_fee_percent = 10 where id = '${demoRest.id}';`);
});

// Abrir atendimento na mesa 4 com Garçom 1
const visitMesa4 = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.open_table_visit('brasa', 4);`);
    return res[0];
});
const tabIdMesa4 = '55555555-5555-4555-8555-555555555555';
const tabMesa4 = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.create_table_tab('brasa', $1::uuid, 'Comanda Mesa 4', $2::uuid);`, [visitMesa4.id, tabIdMesa4]);
    return res[0];
});
assert.equal(tabMesa4.status, 'open');

// 12.1 Outro garçom (Garçom 2) tenta adicionar item na comanda do Garçom 1: DEVE SER BLOQUEADO (42501)
let otherWaiterTabBlocked = false;
try {
    await runAsStaff(waiterStaffId2, 'waiter', async () => {
        await q(`select * from public.add_table_tab_item('brasa', $1::uuid, $2::uuid, 1, gen_random_uuid());`, [
            tabMesa4.id,
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        ]);
    });
} catch (err) {
    otherWaiterTabBlocked = err.code === '42501' && err.message.includes('Somente o responsável');
}
assert.ok(otherWaiterTabBlocked, 'Garçom não responsável deve ser bloqueado com 42501');
console.log('PASS: Garçom não responsável continua estritamente impedido de operar comanda alheia (42501).');

// 12.2 Usuário sem vínculo ativo tenta fechar comanda: DEVE SER BLOQUEADO (42501)
let inactiveUserBlocked = false;
try {
    await runAsStaff(inactiveUserId, 'waiter', async () => {
        await q(`select * from public.close_table_tab('brasa', $1::uuid, true);`, [tabMesa4.id]);
    });
} catch (err) {
    inactiveUserBlocked = err.code === '42501' && err.message.includes('não possui acesso ativo');
}
assert.ok(inactiveUserBlocked, 'Usuário com vínculo inativo deve ser bloqueado com 42501');
console.log('PASS: Usuário sem vínculo ativo bloqueado de gerenciar comanda (42501).');

// 12.3 Usuário de outro restaurante tenta fechar comanda: DEVE SER BLOQUEADO (42501)
let outsiderBlocked = false;
try {
    await runAsStaff(outsiderUserId, 'admin', async () => {
        await q(`select * from public.close_table_tab('brasa', $1::uuid, true);`, [tabMesa4.id]);
    });
} catch (err) {
    outsiderBlocked = err.code === '42501' && err.message.includes('não possui acesso ativo');
}
assert.ok(outsiderBlocked, 'Usuário de outro restaurante deve ser bloqueado com 42501');
console.log('PASS: Usuário de outro restaurante bloqueado com isolamento multi-tenant (42501).');

// 12.4 Menor ajuste necessário: Administrador tenta adicionar item diretamente na comanda de outro garçom via add_table_tab_item.
// lock_owned_table_visit NÃO foi alargada, logo esta operação DEVE SER BLOQUEADA (42501).
let adminAddBlocked = false;
try {
    await runAsStaff(adminUserId, 'admin', async () => {
        await q(`select * from public.add_table_tab_item('brasa', $1::uuid, $2::uuid, 1, gen_random_uuid());`, [
            tabMesa4.id,
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        ]);
    });
} catch (err) {
    adminAddBlocked = err.code === '42501' && err.message.includes('Somente o responsável');
}
assert.ok(adminAddBlocked, 'add_table_tab_item deve continuar restrito ao responsável da mesa (sem alargamento indevido)');
console.log('PASS: lock_owned_table_visit preservada: outras operações (add_table_tab_item) NÃO receberam permissões indevidas.');

// Garçom responsável (Garçom 1) adiciona item legítimo na comanda
const itemMesa4Id = '66666666-6666-4666-8666-666666666666';
const itemAddedByWaiter = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const res = await q(`select * from public.add_table_tab_item('brasa', $1::uuid, $2::uuid, 2, $3::uuid);`, [
        tabMesa4.id,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        itemMesa4Id
    ]);
    return res[0];
});
assert.equal(itemAddedByWaiter.id, itemMesa4Id);
assert.equal(itemAddedByWaiter.quantity, 2);

// 12.5 Tentativa de fechar o atendimento da mesa com comanda aberta: DEVE FALHAR (22023)
let adminVisitCloseBlocked = false;
try {
    await runAsStaff(adminUserId, 'admin', async () => {
        await q(`select * from public.close_table_visit('brasa', $1::uuid);`, [visitMesa4.id]);
    });
} catch (err) {
    adminVisitCloseBlocked = err.code === '22023' && err.message.includes('Encerre todas as comandas abertas');
}
assert.ok(adminVisitCloseBlocked, 'Mesa com comanda aberta não pode ser encerrada mesmo por administrador');
console.log('PASS: Fechamento de atendimento bloqueado rigidamente enquanto houver comanda aberta.');

// 12.6 Administrador encerra a comanda com cálculo de taxa: DEVE TER SUCESSO!
// Verifica também que closed_by_member_id registra o adminMember.id com precisão
const [adminMemberRecord] = await q(`select id from public.restaurant_members where restaurant_id = '${demoRest.id}' and user_id = '${adminUserId}';`);
const closedTabByAdmin = await runAsStaff(adminUserId, 'admin', async () => {
    const res = await q(`select * from public.close_table_tab('brasa', $1::uuid, true);`, [tabMesa4.id]);
    return res[0];
});
assert.equal(closedTabByAdmin.status, 'closed');
assert.equal(closedTabByAdmin.service_fee_accepted, true);
assert.equal(closedTabByAdmin.closed_by_member_id, adminMemberRecord.id, 'closed_by_member_id deve registrar o membro administrador que encerrou');
assert.equal(closedTabByAdmin.total_in_cents, closedTabByAdmin.subtotal_in_cents + closedTabByAdmin.service_fee_in_cents);
console.log('PASS: Administrador autorizado encerra a comanda com integridade matemática e closed_by_member_id registrado.');

// 12.7 Comanda encerrada: não permite alteração posterior de consumo
let postCloseAddBlocked = false;
try {
    await runAsStaff(waiterStaffId, 'waiter', async () => {
        await q(`select * from public.add_table_tab_item('brasa', $1::uuid, $2::uuid, 1, gen_random_uuid());`, [
            tabMesa4.id,
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        ]);
    });
} catch (err) {
    postCloseAddBlocked = err.code === '22023' || err.message.includes('comanda encerrada');
}
assert.ok(postCloseAddBlocked, 'Não deve ser possível adicionar consumo após fechamento da comanda');
console.log('PASS: Comanda encerrada bloqueia estritamente novas inclusões de consumo.');

// 12.8 Com comanda fechada, encerramento da mesa pelo administrador: DEVE TER SUCESSO!
const finalClosedVisit = await runAsStaff(adminUserId, 'admin', async () => {
    const res = await q(`select * from public.close_table_visit('brasa', $1::uuid);`, [visitMesa4.id]);
    return res[0];
});
assert.equal(finalClosedVisit.status, 'closed');
console.log('PASS: Atendimento finalizado com sucesso após fechamento prévio de todas as comandas.');

// ============================================================================
// TESTE 13: Cálculo de Comissão Acumulada no Histórico e Isolamento por Perfil
// ============================================================================
console.log('\n--- Teste 13: Cálculo de Comissão Acumulada e Isolamento por Perfil (Garçom vs Admin) ---');

// 13.1 Criar atendimento para Garçom 2 com taxa aceita para comparar isolamento
const [memberRecordWaiter2] = await q(`select id from public.restaurant_members where restaurant_id = '${demoRest.id}' and user_id = '${waiterStaffId2}';`);
const visitMesa5 = await runAsStaff(waiterStaffId2, 'waiter', async () => {
    const [v] = await q(`select * from public.open_table_visit('brasa', 5);`);
    return v;
});
const tabMesa5 = await runAsStaff(waiterStaffId2, 'waiter', async () => {
    const [t] = await q(`select * from public.create_table_tab('brasa', $1::uuid, 'Mesa 05', gen_random_uuid());`, [visitMesa5.id]);
    return t;
});
await runAsStaff(waiterStaffId2, 'waiter', async () => {
    await q(`select * from public.add_table_tab_item('brasa', $1::uuid, $2::uuid, 1, gen_random_uuid());`, [
        tabMesa5.id,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' // R$ 20.00
    ]);
});
// Encerra comanda aceitando taxa de 10% (R$ 20.00 + R$ 2.00 = R$ 22.00; taxa = 200 cents)
await runAsStaff(waiterStaffId2, 'waiter', async () => {
    await q(`select * from public.close_table_tab('brasa', $1::uuid, true);`, [tabMesa5.id]);
});
// Encerra atendimento do Garçom 2
await runAsStaff(waiterStaffId2, 'waiter', async () => {
    await q(`select * from public.close_table_visit('brasa', $1::uuid);`, [visitMesa5.id]);
});

// 13.2 Função que simula a query de cálculo de comissão do frontend
async function calculateCommissionSummary(staffUserIdParam, role, memberIdParam) {
    return await runAsStaff(staffUserIdParam, role, async () => {
        let querySql = `
            select
                v.id as visit_id,
                v.status as visit_status,
                v.assigned_member_id,
                v.closed_at,
                coalesce(
                    json_agg(
                        json_build_object(
                            'id', t.id,
                            'status', t.status,
                            'service_fee_in_cents', t.service_fee_in_cents
                        )
                    ) filter (where t.id is not null),
                    '[]'::json
                ) as tabs
            from public.table_visits v
            left join public.table_tabs t on t.table_visit_id = v.id
            where v.restaurant_id = '${demoRest.id}'
              and v.status = 'closed'
        `;

        if (role === 'waiter') {
            querySql += ` and v.assigned_member_id = '${memberIdParam}'`;
        }

        querySql += ` group by v.id, v.status, v.assigned_member_id, v.closed_at`;

        const visitsRows = await q(querySql);

        let totalFeeInCents = 0;
        let distinctVisitsCount = 0;

        for (const row of visitsRows) {
            const tabs = typeof row.tabs === 'string' ? JSON.parse(row.tabs) : row.tabs;
            const closedTabs = tabs.filter((t) => t.status === 'closed');
            const visitFee = closedTabs.reduce((sum, t) => sum + (t.service_fee_in_cents || 0), 0);
            totalFeeInCents += visitFee;
            if (visitFee > 0) {
                distinctVisitsCount += 1;
            }
        }

        return { totalFeeInCents, distinctVisitsCount };
    });
}

// 13.3 Testar cálculo para Garçom 2
const waiter2Summary = await calculateCommissionSummary(waiterStaffId2, 'waiter', memberRecordWaiter2.id);
assert.equal(waiter2Summary.totalFeeInCents, 500, 'Garçom 2 deve somar exatamente R$ 5,00 (500 cents) de taxa');
assert.equal(waiter2Summary.distinctVisitsCount, 1, 'Garçom 2 deve registrar exatamente 1 atendimento com taxa');
console.log('PASS: Garçom 2 calcula comissão individual restrita ao seu assigned_member_id.');

// 13.4 Testar cálculo para Administrador (visão total da casa)
const adminSummary = await calculateCommissionSummary(adminUserId, 'admin', adminMemberRecord.id);
assert.ok(adminSummary.totalFeeInCents >= waiter2Summary.totalFeeInCents + 400, 'Admin deve somar taxas de todos os garçons');
assert.ok(adminSummary.distinctVisitsCount >= 2, 'Admin deve registrar múltiplos atendimentos com taxa');
console.log('PASS: Administrador consulta a Taxa de Serviço Total (Casa) agregando todas as comissões encerradas.');

// 13.5 Atendimentos abertos não entram no cálculo de comissão
const openVisit = await runAsStaff(waiterStaffId, 'waiter', async () => {
    const [v] = await q(`select * from public.open_table_visit('brasa', 6);`);
    return v;
});
const adminSummaryAfterOpen = await calculateCommissionSummary(adminUserId, 'admin', adminMemberRecord.id);
assert.equal(adminSummaryAfterOpen.totalFeeInCents, adminSummary.totalFeeInCents, 'Atendimento aberto não altera o total de comissão liquidada');
assert.equal(adminSummaryAfterOpen.distinctVisitsCount, adminSummary.distinctVisitsCount, 'Atendimento aberto não altera contagem de atendimentos encerrados');
console.log('PASS: Atendimentos em aberto são estritamente excluídos da comissão liquidada.');

console.log('\n======================================================');
console.log('TODOS OS TESTES DO BLOCO 4, HISTÓRICO E COMISSÃO FORAM APROVADOS COM SUCESSO!');
console.log('======================================================');
