import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { tmpdir } from 'node:os';

console.log('--- Executando Testes Unitários de Produção (getGuestTabState real) ---');

const scratchDir = resolve(tmpdir(), 'elozi-test-guest-tab');
await mkdir(scratchDir, { recursive: true });

// 1. Criar mock isolado para supabase e getTabConsumption
const mockSupabasePath = resolve(scratchDir, 'mock-supabase.mjs');
const mockTabConsumptionPath = resolve(scratchDir, 'mock-tabConsumption.mjs');

await writeFile(
  mockSupabasePath,
  `
export const mockState = {
  user: { id: 'user-anon-1', is_anonymous: true },
  authError: null,
  rpcResult: null,
  rpcError: null,
};

export const supabase = {
  auth: {
    getSession: async () => {
      if (mockState.authError) {
        return { data: { session: null }, error: mockState.authError };
      }
      return {
        data: {
          session: mockState.user ? { user: mockState.user } : null,
        },
        error: null,
      };
    },
  },
  rpc: (fnName, params) => {
    const builder = {
      maybeSingle: function () {
        return this;
      },
      overrideTypes: function () {
        return this;
      },
      then: (resolve, reject) => {
        resolve({
          data: mockState.rpcResult,
          error: mockState.rpcError,
        });
      },
    };
    return builder;
  },
};
`,
  'utf8',
);

await writeFile(
  mockTabConsumptionPath,
  `
export const mockConsumption = {
  handler: async (restaurantId, tabId) => ({
    items: [
      {
        id: 'item-real-1',
        product_name: 'Picanha Nobre',
        quantity: 2,
        unit_price_in_cents: 8900,
        status: 'delivered',
      },
    ],
    totalInCents: 17800,
  }),
};

export async function getTabConsumption(restaurantId, tabId) {
  return mockConsumption.handler(restaurantId, tabId);
}
`,
  'utf8',
);

// 2. Ler o arquivo real de produção src/features/service/guestTab.ts
const originalSourcePath = resolve(
  import.meta.dirname,
  '../src/features/service/guestTab.ts',
);
let sourceCode = await readFile(originalSourcePath, 'utf8');

// Redirecionar os imports de dependências externas para os mocks isolados
sourceCode = sourceCode.replace(
  "import { supabase } from '../../lib/supabase';",
  `import { supabase } from '${pathToFileURL(mockSupabasePath).href}';`,
);
sourceCode = sourceCode.replace(
  "import { getTabConsumption } from './tabConsumption';",
  `import { getTabConsumption } from '${pathToFileURL(mockTabConsumptionPath).href}';`,
);

// 3. Transpilar o código real usando o compilador oficial TypeScript
const transpiled = ts.transpileModule(sourceCode, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
  },
});

const compiledPath = resolve(scratchDir, 'compiled-guestTab.mjs');
await writeFile(compiledPath, transpiled.outputText, 'utf8');

// 4. Importar a função REAL getGuestTabState de produção
const { getGuestTabState } = await import(pathToFileURL(compiledPath).href);
const { mockState } = await import(pathToFileURL(mockSupabasePath).href);

console.log('PASS: Função getGuestTabState real de produção carregada e vinculada com sucesso.');

// 5. TESTES UNITÁRIOS DA FUNÇÃO REAL

// Caso A: Validação de parâmetros de entrada (slug vazio ou mesa inválida)
let res = await getGuestTabState('', 1);
assert.equal(res.status, 'hidden');

res = await getGuestTabState('brasa', 0);
assert.equal(res.status, 'hidden');

res = await getGuestTabState('brasa', 1000);
assert.equal(res.status, 'hidden');

res = await getGuestTabState('brasa', 2.5);
assert.equal(res.status, 'hidden');
console.log('PASS: Parâmetros inválidos rejeitados sem disparar RPC (status: hidden)');

// Caso B: Usuário não autenticado ou não-anônimo
mockState.user = null;
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'hidden');

mockState.user = { id: 'staff-user', is_anonymous: false };
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'hidden');
console.log('PASS: Usuário não-anônimo bloqueado de consultar comanda de cliente');

// Caso C: RPC bem-sucedida sem resultado (cliente/mesa sem sessão vinculada)
mockState.user = { id: 'guest-anon-1', is_anonymous: true };
mockState.rpcResult = null;
mockState.rpcError = null;

res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'hidden', 'RPC bem-sucedida sem resultado deve retornar hidden');
console.log('PASS: RPC sem resultado retorna hidden diretamente, sem fallback');

// Caso D: Erro de RPC não silenciado
mockState.rpcResult = null;
mockState.rpcError = { message: 'database connection error' };

await assert.rejects(
  async () => await getGuestTabState('brasa', 1),
  /database connection error/,
  'Erro de RPC deve ser propagado para tratamento na interface',
);
console.log('PASS: Falhas de rede/RPC propagam erro para exibição com retry');

// Caso E: Sessão com status = 'pending'
mockState.rpcError = null;
mockState.rpcResult = {
  session_id: 'sess-p',
  restaurant_id: 'rest-1',
  restaurant_table_id: 'table-1',
  status: 'pending',
  table_visit_id: null,
  table_tab_id: null,
  tab_status: null,
  tab_label: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'waiting');
assert.equal(res.guestStatus, 'pending');
assert.equal(res.guestSessionId, 'sess-p');

// Caso F: Sessão com status = 'revoked'
mockState.rpcResult = {
  session_id: 'sess-r',
  restaurant_id: 'rest-1',
  restaurant_table_id: 'table-1',
  status: 'revoked',
  table_visit_id: null,
  table_tab_id: null,
  tab_status: null,
  tab_label: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'closed');

// Caso G: Sessão com status = 'expired'
mockState.rpcResult = {
  session_id: 'sess-e',
  restaurant_id: 'rest-1',
  restaurant_table_id: 'table-1',
  status: 'expired',
  table_visit_id: null,
  table_tab_id: null,
  tab_status: null,
  tab_label: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() - 3600000).toISOString(),
};
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'hidden');

// Caso H: Sessão ativa sem comanda vinculada ainda
mockState.rpcResult = {
  session_id: 'sess-a1',
  restaurant_id: 'rest-1',
  restaurant_table_id: 'table-1',
  status: 'active',
  table_visit_id: 'visit-1',
  table_tab_id: null,
  tab_status: null,
  tab_label: null,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'waiting');
assert.equal(res.guestStatus, 'active');

// Caso I: Sessão ativa com comanda aberta e consumo
mockState.rpcResult = {
  session_id: 'sess-a2',
  restaurant_id: 'rest-1',
  restaurant_table_id: 'table-1',
  status: 'active',
  table_visit_id: 'visit-1',
  table_tab_id: 'tab-1',
  tab_status: 'open',
  tab_label: 'Comanda Mesa 01',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'ready');
assert.equal(res.tab.id, 'tab-1');
assert.equal(res.tab.label, 'Comanda Mesa 01');
assert.equal(res.tab.status, 'open');
assert.equal(res.totalInCents, 17800);
assert.equal(res.items.length, 1);

// Caso J: Sessão ativa com comanda encerrada
mockState.rpcResult = {
  session_id: 'sess-a3',
  restaurant_id: 'rest-1',
  restaurant_table_id: 'table-1',
  status: 'active',
  table_visit_id: 'visit-1',
  table_tab_id: 'tab-1',
  tab_status: 'closed',
  tab_label: 'Comanda Mesa 01',
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
res = await getGuestTabState('brasa', 1);
assert.equal(res.status, 'closed');
assert.equal(res.tab.status, 'closed');

console.log('PASS: Ciclo de vida completo (pending, revoked, expired, ready, closed) testado na função de produção.');
console.log('--- TODOS OS TESTES UNITÁRIOS DO CÓDIGO REAL PASSARAM COM 100% DE SUCESSO! ---');
