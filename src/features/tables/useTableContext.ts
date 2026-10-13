import { useParams, useSearchParams } from 'react-router';

export type TableContext =
  | {
      status: 'absent';
      restaurantSlug: string;
    }
  | {
      status: 'invalid';
      restaurantSlug: string;
    }
  | {
      status: 'unverified';
      restaurantSlug: string;
      tableNumber: string;
    };

export function useTableContext(): TableContext {
  const { restaurantSlug = '' } = useParams();
  const [searchParams] = useSearchParams();

  const values = searchParams.getAll('mesa');

  if (values.length === 0) {
    return {
      status: 'absent',
      restaurantSlug,
    };
  }

  // Rejeita parâmetros duplicados.
  if (values.length !== 1) {
    return {
      status: 'invalid',
      restaurantSlug,
    };
  }

  const value = values[0];

  // Nesta demonstração, aceitamos mesas numéricas de 1 a 999.
  if (!/^\d{1,3}$/.test(value)) {
    return {
      status: 'invalid',
      restaurantSlug,
    };
  }

  const number = Number(value);

  if (number < 1 || number > 999) {
    return {
      status: 'invalid',
      restaurantSlug,
    };
  }

  return {
    status: 'unverified',
    restaurantSlug,
    tableNumber: String(number).padStart(2, '0'),
  };
}

/**
 * Retorna a query string canônica para preservação de mesa na navegação interna.
 * Retorna `?mesa=XX` somente se o status for `unverified` e a mesa for válida.
 * Retorna string vazia caso a mesa esteja ausente ou inválida.
 */
export function getTableQueryString(table: TableContext | null | undefined): string {
  if (table && table.status === 'unverified' && table.tableNumber) {
    return `?mesa=${table.tableNumber}`;
  }
  return '';
}