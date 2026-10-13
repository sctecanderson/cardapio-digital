import assert from 'node:assert/strict';

console.log('--- Iniciando Testes Unitários de Coordenação de Sincronização (Etapa 5.1) ---');

/**
 * Simulador fiel do coordenador de sincronização implementado em TabOrdersPage.tsx
 */
class TabSyncCoordinator {
    constructor(fetchFn) {
        this.fetchFn = fetchFn;
        this.isMounted = true;
        this.isFetching = false;
        this.hasPendingRefresh = false;
        this.lastFetchTime = 0;
        this.requestVersion = 0;
        this.channelStatus = 'CONNECTING';
        this.realtimeDebounceTimer = null;
        this.pollingTimer = null;
        this.fetchCallsCount = 0;
        this.successfulFetchesCount = 0;
        this.stateUpdatesCount = 0;

        this.HEARTBEAT_INTERVAL_MS = 30_000;
        this.FALLBACK_INTERVAL_MS = 8_000;

        this.isDocumentHidden = false;
    }

    async executeRefresh() {
        if (!this.isMounted) return;

        if (this.isFetching) {
            this.hasPendingRefresh = true;
            return;
        }

        this.isFetching = true;
        this.hasPendingRefresh = false;
        const currentReqVersion = ++this.requestVersion;
        const isRequestValid = () => this.isMounted && currentReqVersion === this.requestVersion;

        this.fetchCallsCount++;

        try {
            const data = await this.fetchFn();
            if (isRequestValid()) {
                this.successfulFetchesCount++;
                this.stateUpdatesCount++;
                this.lastFetchTime = Date.now();
            }
        } catch (err) {
            // Trata erro de sincronização
        } finally {
            this.isFetching = false;
            if (this.isMounted && this.hasPendingRefresh) {
                this.hasPendingRefresh = false;
                void this.executeRefresh();
            }
        }
    }

    scheduleRealtimeRefresh(debounceMs = 150) {
        if (!this.isMounted) return;

        if (this.isDocumentHidden) {
            this.hasPendingRefresh = true;
            return;
        }

        if (this.realtimeDebounceTimer !== null) {
            clearTimeout(this.realtimeDebounceTimer);
        }

        this.realtimeDebounceTimer = setTimeout(async () => {
            this.realtimeDebounceTimer = null;
            if (this.isMounted) {
                await this.executeRefresh();
            }
        }, debounceMs);
    }

    scheduleNextPoll() {
        if (!this.isMounted || this.isDocumentHidden) return;

        if (this.pollingTimer !== null) {
            clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }

        const delay = this.channelStatus === 'SUBSCRIBED'
            ? this.HEARTBEAT_INTERVAL_MS
            : this.FALLBACK_INTERVAL_MS;

        this.pollingTimer = setTimeout(async () => {
            this.pollingTimer = null;
            if (!this.isMounted) return;
            if (!this.isDocumentHidden) {
                await this.executeRefresh();
            }
            this.scheduleNextPoll();
        }, delay);
    }

    onChannelStatusChange(status) {
        if (!this.isMounted) return;

        if (status === 'SUBSCRIBED') {
            const wasDisconnected = this.channelStatus !== 'SUBSCRIBED';
            this.channelStatus = 'SUBSCRIBED';

            if (wasDisconnected) {
                void this.executeRefresh();
            }
            this.scheduleNextPoll();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            this.channelStatus = 'DISCONNECTED';
            this.scheduleNextPoll();
        }
    }

    onVisibilityChange(hidden) {
        this.isDocumentHidden = hidden;
        if (!this.isMounted) return;

        if (!hidden) {
            const elapsed = Date.now() - this.lastFetchTime;
            if (this.hasPendingRefresh || elapsed >= 4_000) {
                void this.executeRefresh();
            }
            this.scheduleNextPoll();
        } else {
            if (this.pollingTimer !== null) {
                clearTimeout(this.pollingTimer);
                this.pollingTimer = null;
            }
        }
    }

    onOnline() {
        if (!this.isMounted) return;
        if (!this.isDocumentHidden) {
            void this.executeRefresh();
            this.scheduleNextPoll();
        }
    }

    unmount() {
        this.isMounted = false;
        if (this.pollingTimer !== null) {
            clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }
        if (this.realtimeDebounceTimer !== null) {
            clearTimeout(this.realtimeDebounceTimer);
            this.realtimeDebounceTimer = null;
        }
    }
}

async function runTests() {
    // Teste 1: Controle de consultas sobrepostas e preservação de pendência (In-flight request control)
    console.log('Teste 1: Controle de concorrência com pending refresh...');
    let activeResolvers = [];
    const coordinator1 = new TabSyncCoordinator(async () => {
        return new Promise((resolve) => {
            activeResolvers.push(resolve);
        });
    });

    // Inicia primeira chamada
    const p1 = coordinator1.executeRefresh();
    assert.equal(coordinator1.fetchCallsCount, 1, 'Primeira requisição deve ser iniciada');
    assert.equal(coordinator1.isFetching, true, 'Deve marcar isFetching como true');

    // Tenta disparar segunda e terceira chamada enquanto a primeira está em trânsito
    await coordinator1.executeRefresh();
    await coordinator1.executeRefresh();
    assert.equal(coordinator1.fetchCallsCount, 1, 'Não deve iniciar nova chamada concorrente em paralelo');
    assert.equal(coordinator1.hasPendingRefresh, true, 'Deve registrar que há atualização pendente');

    // Resolve a primeira requisição
    activeResolvers[0]({ data: 'ok1' });
    await p1;
    await new Promise((r) => setTimeout(r, 10));

    // A primeira chamada terminou, e o finally disparou automaticamente a chamada pendente
    assert.equal(coordinator1.fetchCallsCount, 2, 'Deve ter executado exatamente a segunda chamada após o término da primeira');
    assert.equal(activeResolvers.length, 2, 'Deve ter criado a segunda promise');

    // Resolve a segunda requisição
    activeResolvers[1]({ data: 'ok2' });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(coordinator1.isFetching, false, 'Deve finalizar isFetching');
    assert.equal(coordinator1.hasPendingRefresh, false, 'Não deve ter mais chamadas pendentes');
    assert.equal(coordinator1.successfulFetchesCount, 2, 'Ambas as chamadas devem ter sido completadas com sucesso');
    console.log('PASS: Controle de requisições sobrepostas validado com pending refresh.');

    // Teste 2: Debounce de eventos Realtime consecutivos
    console.log('Teste 2: Agrupamento (debounce) de eventos Realtime consecutivos...');
    let simpleCalls = 0;
    const coordinator2 = new TabSyncCoordinator(async () => {
        simpleCalls++;
        return { data: 'ok' };
    });

    // Dispara 5 eventos Realtime em rajada com 20ms de intervalo
    for (let i = 0; i < 5; i++) {
        coordinator2.scheduleRealtimeRefresh(50);
        await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(simpleCalls, 0, 'Nenhuma chamada deve ter sido disparada antes da expiração do debounce');

    // Aguarda expiração do debounce
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(simpleCalls, 1, 'Exatamente uma única chamada consolidada deve ser disparada para todos os 5 eventos');
    console.log('PASS: Debounce agrupou 5 eventos consecutivos em 1 única requisição.');

    // Teste 3: Transição de status do canal e recuperação imediata após reconexão
    console.log('Teste 3: Coordenação de status Realtime e reconexão imediata...');
    let reconnectCalls = 0;
    const coordinator3 = new TabSyncCoordinator(async () => {
        reconnectCalls++;
        return { data: 'reconnect' };
    });

    // Canal conecta pela primeira vez
    coordinator3.onChannelStatusChange('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(coordinator3.channelStatus, 'SUBSCRIBED');
    assert.equal(reconnectCalls, 1, 'Deve executar sincronização ao conectar');

    // Canal sofre erro (offline)
    coordinator3.onChannelStatusChange('CHANNEL_ERROR');
    assert.equal(coordinator3.channelStatus, 'DISCONNECTED');

    // Canal reconecta com sucesso
    coordinator3.onChannelStatusChange('SUBSCRIBED');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(coordinator3.channelStatus, 'SUBSCRIBED');
    assert.equal(reconnectCalls, 2, 'Deve disparar sincronização imediata após reconexão');
    console.log('PASS: Reconexão e coordenação de status Realtime validadas com sucesso.');

    // Teste 4: Visibilidade e online
    console.log('Teste 4: Controle de visibilidade da aba e evento online...');
    let visCalls = 0;
    const coordinator4 = new TabSyncCoordinator(async () => {
        visCalls++;
        return { data: 'vis' };
    });

    // Aba fica oculta
    coordinator4.onVisibilityChange(true);
    assert.equal(coordinator4.isDocumentHidden, true);
    assert.equal(coordinator4.pollingTimer, null, 'Timer periódico deve ser pausado com a aba oculta');

    // Evento Realtime recebido com aba oculta marca pendente
    coordinator4.scheduleRealtimeRefresh(10);
    assert.equal(coordinator4.hasPendingRefresh, true, 'Deve marcar pending quando oculto');

    // Usuário retorna à aba
    coordinator4.onVisibilityChange(false);
    assert.equal(coordinator4.isDocumentHidden, false);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(visCalls, 1, 'Deve sincronizar imediatamente ao retornar à aba');

    // Evento de rede volta online
    coordinator4.onOnline();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(visCalls, 2, 'Deve sincronizar imediatamente quando rede volta online');
    console.log('PASS: Comportamento de visibilidade e rede online validado.');

    // Teste 5: Desmontagem com operações pendentes
    console.log('Teste 5: Desmontagem com operações em trânsito...');
    let unmountResolver;
    const coordinator5 = new TabSyncCoordinator(async () => {
        return new Promise((r) => { unmountResolver = r; });
    });

    const unmountPromise = coordinator5.executeRefresh();
    coordinator5.scheduleRealtimeRefresh(100);

    // Desmonta componente
    coordinator5.unmount();
    assert.equal(coordinator5.isMounted, false);
    assert.equal(coordinator5.realtimeDebounceTimer, null, 'Timer de debounce deve ser limpo na desmontagem');
    assert.equal(coordinator5.pollingTimer, null, 'Timer de polling deve ser limpo na desmontagem');

    // Resolução tardia da promessa após unmount
    unmountResolver({ data: 'late' });
    await unmountPromise;

    assert.equal(coordinator5.stateUpdatesCount, 0, 'Nenhum estado deve ser alterado após desmontagem');
    console.log('PASS: Proteção estrita contra vazamento de memória e chamadas após unmount aprovada.');

    console.log('\n======================================================');
    console.log('TODOS OS TESTES DE SINCRONIZAÇÃO FORAM APROVADOS!');
    console.log('======================================================');
}

runTests().catch((err) => {
    console.error('FALHA NOS TESTES DE SINCRONIZAÇÃO:', err);
    process.exit(1);
});
