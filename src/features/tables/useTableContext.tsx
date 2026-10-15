import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react';
import { useParams, useSearchParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useRestaurant } from '../restaurants/RestaurantProvider';

export type TableContext =
  | {
      status: 'loading';
      restaurantSlug: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
    }
  | {
      status: 'absent';
      restaurantSlug: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
    }
  | {
      status: 'invalid';
      restaurantSlug: string;
      reason?: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
    }
  | {
      status: 'expired';
      restaurantSlug: string;
      reason?: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
    }
  | {
      status: 'unverified';
      restaurantSlug: string;
      tableNumber: string;
      tableId: string;
      tableName: string;
    };

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validador estrito de formato UUID.
 * Garante que parâmetros malformados (ex.: ?t=123) não quebrem a aplicação
 * nem disparem erros de tipo no PostgreSQL.
 */
export function isValidUuid(val: string | null | undefined): val is string {
  if (!val) return false;
  return UUID_REGEX.test(val.trim());
}

const TableReactContext = createContext<TableContext | null>(null);

export function TableProvider({ children }: { children: ReactNode }) {
  const { restaurantSlug = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { restaurant } = useRestaurant();

  const tParam = searchParams.get('t');
  const legacyMesaParam = searchParams.get('mesa') || searchParams.get('table');

  const [tableState, setTableState] = useState<TableContext>(() => {
    if (!tParam && !legacyMesaParam) {
      return { status: 'absent', restaurantSlug };
    }
    return { status: 'loading', restaurantSlug };
  });

  useEffect(() => {
    let cancelled = false;

    async function resolveTable() {
      // 1. Se nenhum parâmetro de mesa foi passado
      if (!tParam && !legacyMesaParam) {
        if (!cancelled) setTableState({ status: 'absent', restaurantSlug });
        return;
      }

      // Aguarda o restaurante ser resolvido pelo Provider antes de validar
      if (!restaurant) {
        return;
      }

      // 2. Trava de inadimplência SaaS
      if (restaurant.billingStatus === 'expired') {
        if (!cancelled) {
          setTableState({
            status: 'expired',
            restaurantSlug,
            reason: 'Atendimento temporariamente indisponível.',
          });
        }
        return;
      }

      // 3. Foco primário: Parâmetro 't' (UUID seguro da mesa)
      if (tParam) {
        const trimmedT = tParam.trim();

        // Validação de formato: se não for UUID válido, assume como consulta sem mesa (balcão)
        if (!isValidUuid(trimmedT)) {
          if (!cancelled) setTableState({ status: 'absent', restaurantSlug });
          return;
        }

        try {
          const { data, error } = await supabase
            .from('restaurant_tables')
            .select('id, restaurant_id, table_number, label, active, is_active, deleted_at')
            .eq('id', trimmedT)
            .eq('restaurant_id', restaurant.id)
            .is('deleted_at', null)
            .maybeSingle();

          if (cancelled) return;

          if (error || !data) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa não encontrada ou inativa.',
            });
            return;
          }

          // Trava de segurança: is_active = true e deleted_at is null
          const isActive =
            data.is_active !== false && data.active !== false && !data.deleted_at;

          if (!isActive) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa desativada para atendimento.',
            });
            return;
          }

          setTableState({
            status: 'unverified',
            restaurantSlug,
            tableNumber: String(data.table_number).padStart(2, '0'),
            tableId: data.id,
            tableName: data.label || `Mesa ${String(data.table_number).padStart(2, '0')}`,
          });
          return;
        } catch {
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Erro ao validar a mesa.',
            });
          }
          return;
        }
      }

      // 4. Fallback legado: Parâmetro 'mesa' / 'table' (número)
      if (legacyMesaParam) {
        const trimmedMesa = legacyMesaParam.trim();
        if (!/^\d{1,3}$/.test(trimmedMesa)) {
          if (!cancelled) setTableState({ status: 'invalid', restaurantSlug });
          return;
        }
        const num = Number(trimmedMesa);
        if (num < 1 || num > 999) {
          if (!cancelled) setTableState({ status: 'invalid', restaurantSlug });
          return;
        }

        try {
          const { data, error } = await supabase
            .from('restaurant_tables')
            .select('id, restaurant_id, table_number, label, active, is_active, deleted_at')
            .eq('table_number', num)
            .eq('restaurant_id', restaurant.id)
            .is('deleted_at', null)
            .maybeSingle();

          if (cancelled) return;

          if (error || !data) {
            // Permite compatibilidade se não encontrou registro correspondente
            setTableState({
              status: 'unverified',
              restaurantSlug,
              tableNumber: String(num).padStart(2, '0'),
              tableId: '',
              tableName: `Mesa ${String(num).padStart(2, '0')}`,
            });
            return;
          }

          const isActive =
            data.is_active !== false && data.active !== false && !data.deleted_at;

          if (!isActive) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa desativada para atendimento.',
            });
            return;
          }

          setTableState({
            status: 'unverified',
            restaurantSlug,
            tableNumber: String(data.table_number).padStart(2, '0'),
            tableId: data.id,
            tableName: data.label || `Mesa ${String(data.table_number).padStart(2, '0')}`,
          });
        } catch {
          if (!cancelled) {
            setTableState({
              status: 'unverified',
              restaurantSlug,
              tableNumber: String(num).padStart(2, '0'),
              tableId: '',
              tableName: `Mesa ${String(num).padStart(2, '0')}`,
            });
          }
        }
      }
    }

    void resolveTable();

    return () => {
      cancelled = true;
    };
  }, [tParam, legacyMesaParam, restaurant?.id, restaurant?.billingStatus, restaurantSlug]);

  return (
    <TableReactContext.Provider value={tableState}>
      {children}
    </TableReactContext.Provider>
  );
}

/**
 * Hook para acessar os dados da mesa sincronizada com o QR Code.
 */
export function useTableContext(): TableContext {
  const context = useContext(TableReactContext);
  if (context) return context;

  // Fallback síncrono para componentes usados fora do TableProvider
  const { restaurantSlug = '' } = useParams();
  const [searchParams] = useSearchParams();

  const t = searchParams.get('t');
  const mesa = searchParams.get('mesa') || searchParams.get('table');

  if (t && isValidUuid(t)) {
    return {
      status: 'unverified',
      restaurantSlug,
      tableNumber: '??',
      tableId: t,
      tableName: 'Mesa',
    };
  }

  if (mesa && /^\d{1,3}$/.test(mesa)) {
    return {
      status: 'unverified',
      restaurantSlug,
      tableNumber: String(Number(mesa)).padStart(2, '0'),
      tableId: '',
      tableName: `Mesa ${String(Number(mesa)).padStart(2, '0')}`,
    };
  }

  return {
    status: 'absent',
    restaurantSlug,
  };
}

/**
 * Retorna a query string canônica para preservação da mesa na navegação interna.
 * Prioriza o UUID seguro (?t=...) emitido pelo QR Code.
 * Mantém ?mesa=XX caso seja o formato de fallback legado.
 */
export function getTableQueryString(table: TableContext | null | undefined): string {
  if (table && table.status === 'unverified') {
    if (table.tableId) {
      return `?t=${table.tableId}`;
    }
    if (table.tableNumber) {
      return `?mesa=${table.tableNumber}`;
    }
  }
  return '';
}