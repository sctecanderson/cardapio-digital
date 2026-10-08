import { supabase } from '../../lib/supabase';
import { ensureGuestIdentity } from '../auth/guestAuth';

export interface ServiceRequest {
    id: string;
    restaurant_id: string;
    restaurant_table_id: string;
    table_visit_id: string | null;
    request_type: 'waiter' | 'bill';
    status: 'pending' | 'attended' | 'cancelled';
    created_at: string;
    resolved_at: string | null;
    resolved_by_member_id: string | null;
}

export interface WaiterRequestState {
    guestSessionId: string | null;
    request: ServiceRequest | null;
}

export type RequestWaiterResult =
    | {
          status: 'created' | 'existing';
          guestSessionId: string;
          request: ServiceRequest;
      }
    | {
          status: 'rate_limited';
          retryAfterSeconds: number;
      };

export interface PendingWaiterRequest extends ServiceRequest {
    table: {
        table_number: number;
    };
    visit: {
        assigned_member_id: string | null;
    } | null;
}

function isRecord(
    value: unknown,
): value is Record<string, unknown> {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
    );
}

function isNullableString(
    value: unknown,
): value is string | null {
    return value === null || typeof value === 'string';
}

function validateTableNumber(tableNumber: number) {
    if (
        !Number.isInteger(tableNumber) ||
        tableNumber < 1 ||
        tableNumber > 999
    ) {
        throw new Error('Informe um número de mesa válido.');
    }
}

function parseServiceRequest(value: unknown): ServiceRequest {
    if (!isRecord(value)) {
        throw new Error('O servidor retornou um chamado inválido.');
    }

    const {
        id,
        restaurant_id,
        restaurant_table_id,
        table_visit_id,
        request_type,
        status,
        created_at,
        resolved_at,
        resolved_by_member_id,
    } = value;

    if (
        typeof id !== 'string' ||
        typeof restaurant_id !== 'string' ||
        typeof restaurant_table_id !== 'string' ||
        !isNullableString(table_visit_id) ||
        (request_type !== 'waiter' && request_type !== 'bill') ||
        (
            status !== 'pending' &&
            status !== 'attended' &&
            status !== 'cancelled'
        ) ||
        typeof created_at !== 'string' ||
        !isNullableString(resolved_at) ||
        !isNullableString(resolved_by_member_id)
    ) {
        throw new Error('O servidor retornou um chamado inválido.');
    }

    return {
        id,
        restaurant_id,
        restaurant_table_id,
        table_visit_id,
        request_type,
        status,
        created_at,
        resolved_at,
        resolved_by_member_id,
    };
}

export async function requestWaiter(
    restaurantSlug: string,
    tableNumber: number,
): Promise<RequestWaiterResult> {
    validateTableNumber(tableNumber);

    // A identidade anônima é criada somente ao realizar a ação.
    await ensureGuestIdentity();

    const { data, error } = await supabase.rpc('request_waiter', {
        p_restaurant_slug: restaurantSlug,
        p_table_number: tableNumber,
    });

    if (error) {
        if (error.code === '42501' || error.code === '22023') {
            throw new Error(error.message);
        }

        throw new Error(
            'Não foi possível chamar o garçom. Tente novamente.',
        );
    }

    if (!isRecord(data)) {
        throw new Error('O servidor não confirmou sua solicitação.');
    }

    if (data.status === 'rate_limited') {
        const seconds = data.retry_after_seconds;

        if (
            typeof seconds !== 'number' ||
            !Number.isInteger(seconds) ||
            seconds < 1
        ) {
            throw new Error(
                'O servidor retornou um tempo de espera inválido.',
            );
        }

        return {
            status: 'rate_limited',
            retryAfterSeconds: seconds,
        };
    }

    if (
        (data.status !== 'created' && data.status !== 'existing') ||
        typeof data.guest_session_id !== 'string'
    ) {
        throw new Error('O servidor não confirmou sua solicitação.');
    }

    const request = parseServiceRequest(data.request);

    if (request.request_type !== 'waiter') {
        throw new Error('O servidor retornou outro tipo de chamado.');
    }

    return {
        status: data.status,
        guestSessionId: data.guest_session_id,
        request,
    };
}

export async function getWaiterRequestState(
    restaurantSlug: string,
    tableNumber: number,
): Promise<WaiterRequestState> {
    validateTableNumber(tableNumber);

    // Recuperar o estado não cria uma identidade anônima.
    const { data: authData, error: authError } =
        await supabase.auth.getSession();

    if (authError) {
        throw new Error('Não foi possível verificar sua sessão.');
    }

    if (!authData.session?.user.is_anonymous) {
        return {
            guestSessionId: null,
            request: null,
        };
    }

    const { data, error } = await supabase.rpc(
        'get_waiter_request_state',
        {
            p_restaurant_slug: restaurantSlug,
            p_table_number: tableNumber,
        },
    );

    if (error) {
        throw new Error(
            'Não foi possível recuperar seu chamado. Tente novamente.',
        );
    }

    if (
        !isRecord(data) ||
        !isNullableString(data.guest_session_id)
    ) {
        throw new Error('O servidor retornou um estado inválido.');
    }

    const request =
        data.request === null
            ? null
            : parseServiceRequest(data.request);

    if (
        request &&
        (
            request.request_type !== 'waiter' ||
            data.guest_session_id === null
        )
    ) {
        throw new Error('O servidor retornou um estado inválido.');
    }

    return {
        guestSessionId: data.guest_session_id,
        request,
    };
}

export async function listPendingWaiterRequests(
    restaurantId: string,
): Promise<PendingWaiterRequest[]> {
    const { data, error } = await supabase
        .from('service_requests')
        .select(`
            *,
            table:restaurant_tables!inner(table_number),
            visit:table_visits(assigned_member_id)
        `)
        .eq('restaurant_id', restaurantId)
        .eq('request_type', 'waiter')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .overrideTypes<PendingWaiterRequest[], { merge: false }>();

    if (error) {
        throw new Error(
            'Não foi possível carregar os chamados. Tente novamente.',
        );
    }

    return data ?? [];
}

export async function attendWaiterRequest(
    restaurantSlug: string,
    serviceRequestId: string,
): Promise<ServiceRequest> {
    if (!serviceRequestId.trim()) {
        throw new Error('Informe o chamado que deseja atender.');
    }

    const { data, error } = await supabase
        .rpc('attend_waiter_request', {
            p_restaurant_slug: restaurantSlug,
            p_service_request_id: serviceRequestId,
        })
        .single()
        .overrideTypes<ServiceRequest, { merge: false }>();

    if (error) {
        if (error.code === '42501' || error.code === '22023') {
            throw new Error(error.message);
        }

        throw new Error(
            'Não foi possível atender o chamado. Tente novamente.',
        );
    }

    const request = parseServiceRequest(data);

    if (
        request.id !== serviceRequestId ||
        request.request_type !== 'waiter' ||
        request.status !== 'attended'
    ) {
        throw new Error(
            'O atendimento do chamado não foi confirmado pelo servidor.',
        );
    }

    return request;
}