import type { TabConsumptionItem } from './tabConsumption';

export interface GroupedConsumptionItem {
  key: string;
  productId: string;
  productName: string;
  unitPriceInCents: number;
  quantity: number;
  lineTotalInCents: number;
  status: 'active' | 'cancelled';
  isCancelled: boolean;
  productionStatus: 'pending' | 'preparing' | 'ready' | 'delivered';
  preparationStation: 'kitchen' | 'bar' | 'none';
  originalItems: TabConsumptionItem[];
  latestItem: TabConsumptionItem;
  earliestCreatedAt: string;
  latestCreatedAt: string;
}

/**
 * Função pura que consolida lançamentos de itens idênticos.
 *
 * Regras:
 * 1. Itens ativos ('active') do mesmo produto, preço unitário e status de produção
 *    são somados em uma única linha (ex.: 1x Água + 4x Água entregues = 5x Água entregues).
 * 2. Lançamentos com status de produção diferentes ('pending', 'preparing', 'ready', 'delivered')
 *    são mantidos em grupos separados para visibilidade do que está a caminho vs. o que já foi servido.
 * 3. Itens cancelados ('cancelled') mantêm registros individuais para exibição de justificativa e auditoria.
 * 4. Preserva integralmente a lista `originalItems` e identifica `latestItem` para permitir
 *    estorno e cancelamento de lote individual pela equipe sem estornar acidentalmente todo o grupo.
 */
export function groupTabConsumptionItems(items: TabConsumptionItem[]): GroupedConsumptionItem[] {
  const groupsMap = new Map<string, GroupedConsumptionItem>();
  const cancelledList: GroupedConsumptionItem[] = [];

  for (const item of items) {
    if (item.status === 'cancelled') {
      cancelledList.push({
        key: `cancelled:${item.id}`,
        productId: item.product_id,
        productName: item.product_name,
        unitPriceInCents: item.unit_price_in_cents,
        quantity: item.quantity,
        lineTotalInCents: item.line_total_in_cents,
        status: 'cancelled',
        isCancelled: true,
        productionStatus: item.production_status || 'delivered',
        preparationStation: item.preparation_station || 'kitchen',
        originalItems: [item],
        latestItem: item,
        earliestCreatedAt: item.created_at,
        latestCreatedAt: item.created_at,
      });
      continue;
    }

    const prodStatus = item.production_status || 'delivered';
    const station = item.preparation_station || 'kitchen';
    const key = `${item.product_id}:${item.unit_price_in_cents}:${item.status}:${prodStatus}`;

    const existing = groupsMap.get(key);
    if (!existing) {
      groupsMap.set(key, {
        key,
        productId: item.product_id,
        productName: item.product_name,
        unitPriceInCents: item.unit_price_in_cents,
        quantity: item.quantity,
        lineTotalInCents: item.line_total_in_cents,
        status: 'active',
        isCancelled: false,
        productionStatus: prodStatus,
        preparationStation: station,
        originalItems: [item],
        latestItem: item,
        earliestCreatedAt: item.created_at,
        latestCreatedAt: item.created_at,
      });
    } else {
      existing.quantity += item.quantity;
      existing.lineTotalInCents += item.line_total_in_cents;
      existing.originalItems.push(item);
      if (new Date(item.created_at).getTime() >= new Date(existing.latestCreatedAt).getTime()) {
        existing.latestCreatedAt = item.created_at;
        existing.latestItem = item;
      }
      if (new Date(item.created_at).getTime() < new Date(existing.earliestCreatedAt).getTime()) {
        existing.earliestCreatedAt = item.created_at;
      }
    }
  }

  // Ordena os itens ativos por data de criação inicial (do mais antigo ao mais recente)
  const activeGroups = Array.from(groupsMap.values()).sort(
    (a, b) => new Date(a.earliestCreatedAt).getTime() - new Date(b.earliestCreatedAt).getTime(),
  );

  return [...activeGroups, ...cancelledList];
}
