import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PGLITE_MODULE_PATH =
  process.env.PGLITE_MODULE ||
  'C:\\Users\\Anderson\\.gemini\\antigravity\\brain\\6ec224d7-f161-44c2-b5ff-d8efb9ccff14\\scratch\\test-env\\node_modules\\@electric-sql\\pglite\\dist\\index.js';

const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local para Validação do Bloco 21 (Faturamento SaaS e Checkout) ---');
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

console.log('PASS: Todas as migrações (incluindo 20261016050000_saas_subscription_billing.sql) compiladas com sucesso.');

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

// -------------------------------------------------------------
// SETUP DE TESTES
// -------------------------------------------------------------
const userAdminA = '11111111-1111-4111-8111-111111111111';
const userAdminB = '22222222-2222-4222-8222-222222222222';
const userWaiterA = '33333333-3333-4333-8333-333333333333';

await db.exec(`
  insert into auth.users (id, email) values
    ('${userAdminA}', 'admin.a@elozi.com'),
    ('${userAdminB}', 'admin.b@elozi.com'),
    ('${userWaiterA}', 'waiter.a@elozi.com');
`);

const [restA] = await q(`
  insert into public.restaurants (slug, name, subscription_plan, max_tables, subscription_expires_at, active)
  values ('rest-alpha', 'Restaurante Alpha', 'basic', 10, timezone('utc', now()) + interval '5 days', true)
  returning id, slug, subscription_plan, max_tables, subscription_expires_at;
`);

const [restB] = await q(`
  insert into public.restaurants (slug, name, subscription_plan, max_tables, subscription_expires_at, active)
  values ('rest-beta', 'Restaurante Beta', 'basic', 10, timezone('utc', now()) + interval '10 days', true)
  returning id, slug, subscription_plan, max_tables, subscription_expires_at;
`);

await db.exec(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active) values
    ('${restA.id}', '${userAdminA}', 'admin', true),
    ('${restA.id}', '${userWaiterA}', 'waiter', true),
    ('${restB.id}', '${userAdminB}', 'admin', true);
`);

console.log('Setup de restaurantes e membros concluído.');

// -------------------------------------------------------------
// TESTE 1: Upgrade de Plano via Cartão de Crédito
// -------------------------------------------------------------
console.log('\n--- Teste 1: Upgrade de Plano (basic -> pro) com Cartão de Crédito ---');

const cardCheckoutResult = await runAs(userAdminA, {}, async () => {
  const rows = await q(
    `select public.create_subscription_checkout(
      $1::uuid,
      'pro',
      'monthly',
      'credit_card',
      $2::jsonb
    ) as result;`,
    [
      restA.id,
      JSON.stringify({
        holder_name: 'CARLOS SILVA',
        card_brand: 'mastercard',
        card_last4: '9876',
        exp_month: 8,
        exp_year: 2029,
        save_card: true,
      }),
    ],
  );
  return rows[0].result;
});

assert.equal(cardCheckoutResult.success, true, 'Checkout com cartão deve ser bem sucedido');
assert.equal(cardCheckoutResult.status, 'paid', 'Fatura com cartão deve ser aprovada imediatamente');
assert.equal(cardCheckoutResult.plan_id, 'pro', 'Plano retornado deve ser pro');
assert.equal(cardCheckoutResult.max_tables, 25, 'Plano pro deve expandir quota para 25 mesas');

// Verificar estado no banco
const [updatedRestA] = await q(`select subscription_plan, max_tables, subscription_expires_at from public.restaurants where id = $1`, [restA.id]);
assert.equal(updatedRestA.subscription_plan, 'pro', 'Plano no banco deve ser pro');
assert.equal(updatedRestA.max_tables, 25, 'Capacidade máxima no banco deve ser 25');

// Verificar validade estendida: era +5 dias, agora deve ser +5 + 30 = ~35 dias
const daysDiff = (new Date(updatedRestA.subscription_expires_at).getTime() - new Date(restA.subscription_expires_at).getTime()) / (1000 * 86400);
assert.ok(Math.abs(daysDiff - 30) < 0.1, `Diferença de dias (${daysDiff}) deve ser de aproximadamente 30 dias`);

// Verificar cartão salvo
const savedCards = await q(`select card_brand, card_last4, holder_name from public.restaurant_payment_methods where restaurant_id = $1`, [restA.id]);
assert.equal(savedCards.length, 1, 'Deve ter 1 cartão salvo');
assert.equal(savedCards[0].card_last4, '9876');
assert.equal(savedCards[0].card_brand, 'mastercard');

console.log('PASS: Upgrade para pro via cartão aprovado, quota atualizada para 25 mesas e validade estendida em +30 dias.');

// -------------------------------------------------------------
// TESTE 2: Geração de Cobrança PIX e Confirmação Idempotente
// -------------------------------------------------------------
console.log('\n--- Teste 2: Checkout via PIX e Confirmação Idempotente ---');

const pixCheckoutResult = await runAs(userAdminA, {}, async () => {
  const rows = await q(
    `select public.create_subscription_checkout(
      $1::uuid,
      'premium',
      'yearly',
      'pix',
      null
    ) as result;`,
    [restA.id],
  );
  return rows[0].result;
});

assert.equal(pixCheckoutResult.success, true);
assert.equal(pixCheckoutResult.status, 'pending', 'Fatura PIX inicia como pending');
assert.equal(pixCheckoutResult.plan_id, 'premium');
assert.ok(pixCheckoutResult.pix_qr_code_payload.startsWith('000201'), 'Deve conter payload EMV PIX válido');
assert.ok(pixCheckoutResult.pix_qr_code_payload.includes('67594410000189'), 'Deve conter chave Pix CNPJ da Elozi / Banco Inter');
assert.ok(pixCheckoutResult.pix_qr_code_payload.includes('6304'), 'Deve conter tag 63 do CRC16');
console.log('BR Code PIX Gerado para Banco Inter PJ:', pixCheckoutResult.pix_qr_code_payload);

const invoiceId = pixCheckoutResult.invoice_id;

// Confirmar pagamento da fatura PIX pela 1ª vez
const confirm1 = await runAs(userAdminA, {}, async () => {
  const rows = await q(`select public.confirm_subscription_invoice_payment($1::uuid, 'pix_ext_123') as result;`, [invoiceId]);
  return rows[0].result;
});

assert.equal(confirm1.success, true);
assert.equal(confirm1.status, 'paid');
assert.equal(confirm1.already_paid, false);
assert.equal(confirm1.plan_id, 'premium');
assert.equal(confirm1.max_tables, 100);

const [restAfterPix1] = await q(`select subscription_plan, max_tables, subscription_expires_at from public.restaurants where id = $1`, [restA.id]);
assert.equal(restAfterPix1.subscription_plan, 'premium');
assert.equal(restAfterPix1.max_tables, 100);

// Confirmar pagamento da MESMA fatura pela 2ª vez (Idempotência)
const confirm2 = await runAs(userAdminA, {}, async () => {
  const rows = await q(`select public.confirm_subscription_invoice_payment($1::uuid, 'pix_ext_123') as result;`, [invoiceId]);
  return rows[0].result;
});

assert.equal(confirm2.success, true);
assert.equal(confirm2.already_paid, true, 'Segunda confirmação deve registrar already_paid = true');

const [restAfterPix2] = await q(`select subscription_expires_at from public.restaurants where id = $1`, [restA.id]);
assert.equal(
  new Date(restAfterPix1.subscription_expires_at).getTime(),
  new Date(restAfterPix2.subscription_expires_at).getTime(),
  'Confirmação duplicada NÃO pode somar dias adicionais na assinatura',
);

console.log('PASS: PIX gerado com EMV Copia e Cola, confirmado com sucesso para 100 mesas e verificação idempotente validada.');

// -------------------------------------------------------------
// TESTE 3: Isolamento RLS e Restrições de Autorização
// -------------------------------------------------------------
console.log('\n--- Teste 3: Isolamento RLS e Restrição de Garçom ---');

// Garçom NÃO pode criar checkout
let waiterBlocked = false;
try {
  await runAs(userWaiterA, {}, async () => {
    await q(
      `select public.create_subscription_checkout(
        $1::uuid,
        'pro',
        'monthly',
        'pix'
      );`,
      [restA.id],
    );
  });
} catch (err) {
  waiterBlocked = true;
  assert.ok(err.message.includes('Apenas administradores'));
}
assert.ok(waiterBlocked, 'Garçom deve ser impedido de criar checkout');

// Admin B NÃO pode ver faturas do Restaurante A
const invoicesSeenByAdminB = await runAs(userAdminB, {}, async () => {
  return await q(`select id from public.subscription_invoices where restaurant_id = $1`, [restA.id]);
});
assert.equal(invoicesSeenByAdminB.length, 0, 'Admin B não pode ver faturas do Restaurante A');

// Admin B NÃO pode ver métodos de pagamento do Restaurante A
const cardsSeenByAdminB = await runAs(userAdminB, {}, async () => {
  return await q(`select id from public.restaurant_payment_methods where restaurant_id = $1`, [restA.id]);
});
assert.equal(cardsSeenByAdminB.length, 0, 'Admin B não pode ver cartões do Restaurante A');

// Summary RPC de Faturamento
const summaryA = await runAs(userAdminA, {}, async () => {
  const rows = await q(`select public.get_restaurant_billing_summary($1::uuid) as result;`, [restA.id]);
  return rows[0].result;
});

assert.equal(summaryA.restaurant.subscription_plan, 'premium');
assert.equal(summaryA.restaurant.max_tables, 100);
assert.equal(summaryA.invoices.length, 2, 'Deve listar 2 faturas no histórico do restaurante A');
assert.equal(summaryA.payment_methods.length, 1, 'Deve listar 1 cartão salvo');
assert.ok(summaryA.catalog.basic && summaryA.catalog.pro && summaryA.catalog.premium, 'Deve conter catálogo com 3 planos');

console.log('PASS: RLS isola 100% faturas e métodos de pagamento entre restaurantes e bloqueia perfis sem acesso.');

console.log('\n======================================================');
console.log('TODOS OS TESTES DO BLOCO 21 NO BANCO PASSARAM COM SUCESSO!');
console.log('======================================================\n');
process.exit(0);
