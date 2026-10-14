import { useState, useEffect, useMemo } from 'react';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import {
  fetchInventory,
  createInventoryItem,
  updateInventoryItem,
  updateStockQuantity,
  deleteInventoryItem,
  subscribeToInventory,
  type InventoryItem,
  type InventoryItemInput,
  type UnitMeasure,
} from './inventoryService';

type FilterType = 'all' | 'alert' | 'out_of_stock';

export function InventoryPage() {
  const { restaurant } = useRestaurant();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros e busca
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal de edição / cadastro
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [itemForm, setItemForm] = useState<InventoryItemInput>({
    name: '',
    category: 'Geral',
    unit_measure: 'un',
    current_quantity: 0,
    alert_threshold: 5,
  });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Confirmação de exclusão
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setError(null);
      const data = await fetchInventory(restaurant.id);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar estoque.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    const unsubscribe = subscribeToInventory(restaurant.id, () => {
      void loadData();
    });
    return () => {
      unsubscribe();
    };
  }, [restaurant.id]);

  // Contagens para os cards de resumo
  const metrics = useMemo(() => {
    const total = items.length;
    const outOfStock = items.filter((i) => i.current_quantity === 0).length;
    const inAlert = items.filter((i) => i.current_quantity > 0 && i.current_quantity <= i.alert_threshold).length;
    const healthy = items.filter((i) => i.current_quantity > i.alert_threshold).length;
    return { total, outOfStock, inAlert, healthy };
  }, [items]);

  // Filtragem dos itens
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      const matchesSearch =
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.category.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      if (activeFilter === 'alert') {
        return item.current_quantity > 0 && item.current_quantity <= item.alert_threshold;
      }
      if (activeFilter === 'out_of_stock') {
        return item.current_quantity === 0;
      }
      return true;
    });
  }, [items, searchQuery, activeFilter]);

  const handleOpenCreateModal = () => {
    setEditingItem(null);
    setItemForm({
      name: '',
      category: 'Geral',
      unit_measure: 'un',
      current_quantity: 0,
      alert_threshold: 5,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (item: InventoryItem) => {
    setEditingItem(item);
    setItemForm({
      name: item.name,
      category: item.category,
      unit_measure: item.unit_measure,
      current_quantity: item.current_quantity,
      alert_threshold: item.alert_threshold,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSaveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemForm.name.trim()) {
      setFormError('Informe o nome do item.');
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      if (editingItem) {
        await updateInventoryItem(editingItem.id, itemForm);
      } else {
        await createInventoryItem(restaurant.id, itemForm);
      }
      setIsModalOpen(false);
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Falha ao salvar item.');
    } finally {
      setFormBusy(false);
    }
  };

  const handleQuickAdjust = async (item: InventoryItem, delta: number) => {
    const nextVal = Math.max(0, item.current_quantity + delta);
    try {
      // Atualização otimista local
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, current_quantity: nextVal } : i))
      );
      await updateStockQuantity(item.id, nextVal);
    } catch (err) {
      console.error('Falha ao ajustar estoque:', err);
      void loadData();
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Tem certeza de que deseja remover este item do estoque?')) return;
    setDeletingId(id);
    try {
      await deleteInventoryItem(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao excluir item.');
    } finally {
      setDeletingId(null);
    }
  };

  const unitLabels: Record<UnitMeasure, string> = {
    un: 'Unidade (un)',
    kg: 'Quilograma (kg)',
    g: 'Grama (g)',
    l: 'Litro (L)',
    ml: 'Mililitro (ml)',
    cx: 'Caixa (cx)',
    pct: 'Pacote (pct)',
  };

  return (
    <div className="admin-page shell py-6" style={{ maxWidth: '1200px', margin: '0 auto' }}>
      {/* Cabeçalho */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 6px 0' }}>
            Controle de Estoque & Insumos
          </h1>
          <p style={{ margin: 0, fontSize: '14px', color: 'var(--color-text-muted, #6b7280)' }}>
            Gerencie quantidades em tempo real e receba alertas automáticos ao atingir o limite de ruptura.
          </p>
        </div>
        <button
          type="button"
          onClick={handleOpenCreateModal}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: 'var(--color-primary, #2563eb)',
            color: '#ffffff',
            padding: '10px 18px',
            borderRadius: '8px',
            fontWeight: 600,
            fontSize: '14px',
            border: 'none',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Novo Item
        </button>
      </div>

      {/* Cards de Métricas */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
          marginBottom: '24px',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderRadius: '10px',
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
          }}
        >
          <div
            style={{
              padding: '10px',
              borderRadius: '8px',
              backgroundColor: '#f3f4f6',
              color: '#374151',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #6b7280)', fontWeight: 500 }}>
              Total de Itens
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700 }}>{metrics.total}</div>
          </div>
        </div>

        <div
          style={{
            padding: '16px 20px',
            borderRadius: '10px',
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
          }}
        >
          <div
            style={{
              padding: '10px',
              borderRadius: '8px',
              backgroundColor: '#fef3c7',
              color: '#d97706',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #6b7280)', fontWeight: 500 }}>
              Em Alerta (Limite de Ruptura)
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#d97706' }}>{metrics.inAlert}</div>
          </div>
        </div>

        <div
          style={{
            padding: '16px 20px',
            borderRadius: '10px',
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
          }}
        >
          <div
            style={{
              padding: '10px',
              borderRadius: '8px',
              backgroundColor: '#fee2e2',
              color: '#dc2626',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #6b7280)', fontWeight: 500 }}>
              Esgotados (Sem Estoque)
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#dc2626' }}>{metrics.outOfStock}</div>
          </div>
        </div>

        <div
          style={{
            padding: '16px 20px',
            borderRadius: '10px',
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
          }}
        >
          <div
            style={{
              padding: '10px',
              borderRadius: '8px',
              backgroundColor: '#dcfce7',
              color: '#16a34a',
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted, #6b7280)', fontWeight: 500 }}>
              Estoque Regular
            </div>
            <div style={{ fontSize: '22px', fontWeight: 700, color: '#16a34a' }}>{metrics.healthy}</div>
          </div>
        </div>
      </div>

      {/* Barra de Filtros e Busca */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '20px',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setActiveFilter('all')}
            style={{
              padding: '6px 14px',
              borderRadius: '9999px',
              fontSize: '13px',
              fontWeight: 600,
              border: '1px solid',
              borderColor: activeFilter === 'all' ? 'var(--color-primary, #2563eb)' : 'var(--color-border, #d1d5db)',
              backgroundColor: activeFilter === 'all' ? 'var(--color-primary, #2563eb)' : 'transparent',
              color: activeFilter === 'all' ? '#ffffff' : 'inherit',
              cursor: 'pointer',
            }}
          >
            Todos ({metrics.total})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('alert')}
            style={{
              padding: '6px 14px',
              borderRadius: '9999px',
              fontSize: '13px',
              fontWeight: 600,
              border: '1px solid',
              borderColor: activeFilter === 'alert' ? '#d97706' : 'var(--color-border, #d1d5db)',
              backgroundColor: activeFilter === 'alert' ? '#d97706' : 'transparent',
              color: activeFilter === 'alert' ? '#ffffff' : 'inherit',
              cursor: 'pointer',
            }}
          >
            Em Alerta ({metrics.inAlert})
          </button>
          <button
            type="button"
            onClick={() => setActiveFilter('out_of_stock')}
            style={{
              padding: '6px 14px',
              borderRadius: '9999px',
              fontSize: '13px',
              fontWeight: 600,
              border: '1px solid',
              borderColor: activeFilter === 'out_of_stock' ? '#dc2626' : 'var(--color-border, #d1d5db)',
              backgroundColor: activeFilter === 'out_of_stock' ? '#dc2626' : 'transparent',
              color: activeFilter === 'out_of_stock' ? '#ffffff' : 'inherit',
              cursor: 'pointer',
            }}
          >
            Esgotados ({metrics.outOfStock})
          </button>
        </div>

        {/* Campo de Busca */}
        <div style={{ position: 'relative', width: '280px' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por nome ou categoria…"
            style={{
              width: '100%',
              padding: '8px 12px 8px 34px',
              borderRadius: '8px',
              border: '1px solid var(--color-border, #d1d5db)',
              fontSize: '13px',
              backgroundColor: 'var(--color-bg-panel, #ffffff)',
            }}
          />
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              position: 'absolute',
              left: '10px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--color-text-muted, #9ca3af)',
              pointerEvents: 'none',
            }}
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
      </div>

      {/* Conteúdo Principal */}
      {loading ? (
        <div style={{ padding: '48px 0', textAlign: 'center', opacity: 0.6 }}>
          Carregando estoque…
        </div>
      ) : error ? (
        <div
          role="alert"
          style={{
            padding: '16px',
            backgroundColor: '#fee2e2',
            color: '#b91c1c',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          {error}
        </div>
      ) : filteredItems.length === 0 ? (
        <div
          style={{
            padding: '48px 16px',
            textAlign: 'center',
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: '10px',
            color: 'var(--color-text-muted, #6b7280)',
          }}
        >
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ margin: '0 auto 12px', opacity: 0.5 }}
            aria-hidden="true"
          >
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          </svg>
          <h3 style={{ margin: '0 0 4px', fontSize: '16px', fontWeight: 600 }}>Nenhum item encontrado</h3>
          <p style={{ margin: 0, fontSize: '13px' }}>
            {items.length === 0
              ? 'Nenhum item cadastrado no estoque ainda. Clique em "Novo Item" para começar.'
              : 'Nenhum item corresponde ao filtro ou busca selecionada.'}
          </p>
        </div>
      ) : (
        <div
          style={{
            backgroundColor: 'var(--color-bg-panel, #ffffff)',
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: '10px',
            overflow: 'hidden',
          }}
        >
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' }}>
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--color-border, #e5e7eb)',
                    backgroundColor: 'var(--color-bg-subtle, #f9fafb)',
                    color: 'var(--color-text-muted, #4b5563)',
                    fontSize: '12px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  <th style={{ padding: '12px 16px' }}>Item & Categoria</th>
                  <th style={{ padding: '12px 16px' }}>Status</th>
                  <th style={{ padding: '12px 16px' }}>Limite de Ruptura</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center' }}>Quantidade Atual</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const isOutOfStock = item.current_quantity === 0;
                  const isLowStock = !isOutOfStock && item.current_quantity <= item.alert_threshold;

                  return (
                    <tr
                      key={item.id}
                      style={{
                        borderBottom: '1px solid var(--color-border-subtle, #f3f4f6)',
                        transition: 'background-color 0.1s ease',
                      }}
                      className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                    >
                      <td style={{ padding: '14px 16px' }}>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{item.name}</div>
                        <span
                          style={{
                            display: 'inline-block',
                            marginTop: '2px',
                            fontSize: '11px',
                            fontWeight: 500,
                            color: 'var(--color-text-muted, #6b7280)',
                            backgroundColor: 'var(--color-bg-subtle, #f3f4f6)',
                            padding: '2px 6px',
                            borderRadius: '4px',
                          }}
                        >
                          {item.category}
                        </span>
                      </td>

                      <td style={{ padding: '14px 16px' }}>
                        {isOutOfStock ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              backgroundColor: '#fee2e2',
                              color: '#991b1b',
                              fontSize: '12px',
                              fontWeight: 600,
                              padding: '3px 8px',
                              borderRadius: '9999px',
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="15" y1="9" x2="9" y2="15" />
                              <line x1="9" y1="9" x2="15" y2="15" />
                            </svg>
                            Esgotado
                          </span>
                        ) : isLowStock ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              backgroundColor: '#fef3c7',
                              color: '#92400e',
                              fontSize: '12px',
                              fontWeight: 600,
                              padding: '3px 8px',
                              borderRadius: '9999px',
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                            Limite de Ruptura
                          </span>
                        ) : (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              backgroundColor: '#dcfce7',
                              color: '#166534',
                              fontSize: '12px',
                              fontWeight: 600,
                              padding: '3px 8px',
                              borderRadius: '9999px',
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Normal
                          </span>
                        )}
                      </td>

                      <td style={{ padding: '14px 16px', fontSize: '13px' }}>
                        Alerta com &le; <strong>{item.alert_threshold}</strong> {item.unit_measure}
                      </td>

                      <td style={{ padding: '14px 16px' }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => void handleQuickAdjust(item, -1)}
                            disabled={item.current_quantity <= 0}
                            title="Diminuir 1 unidade"
                            style={{
                              width: '28px',
                              height: '28px',
                              borderRadius: '6px',
                              border: '1px solid var(--color-border, #d1d5db)',
                              backgroundColor: 'var(--color-bg-subtle, #f9fafb)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: item.current_quantity <= 0 ? 'not-allowed' : 'pointer',
                              opacity: item.current_quantity <= 0 ? 0.4 : 1,
                              fontWeight: 700,
                            }}
                          >
                            -
                          </button>

                          <span
                            style={{
                              minWidth: '60px',
                              textAlign: 'center',
                              fontWeight: 700,
                              fontSize: '15px',
                              color: isOutOfStock ? '#dc2626' : isLowStock ? '#d97706' : 'inherit',
                            }}
                          >
                            {item.current_quantity} {item.unit_measure}
                          </span>

                          <button
                            type="button"
                            onClick={() => void handleQuickAdjust(item, 1)}
                            title="Adicionar 1 unidade"
                            style={{
                              width: '28px',
                              height: '28px',
                              borderRadius: '6px',
                              border: '1px solid var(--color-border, #d1d5db)',
                              backgroundColor: 'var(--color-bg-subtle, #f9fafb)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              fontWeight: 700,
                            }}
                          >
                            +
                          </button>
                        </div>
                      </td>

                      <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <button
                            type="button"
                            onClick={() => handleOpenEditModal(item)}
                            title="Editar item"
                            aria-label={`Editar ${item.name}`}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '6px',
                              color: 'var(--color-text-muted, #4b5563)',
                              borderRadius: '6px',
                            }}
                            className="hover:bg-black/5 dark:hover:bg-white/10"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                            </svg>
                          </button>

                          <button
                            type="button"
                            onClick={() => void handleDelete(item.id)}
                            disabled={deletingId === item.id}
                            title="Excluir item"
                            aria-label={`Excluir ${item.name}`}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '6px',
                              color: '#dc2626',
                              borderRadius: '6px',
                              opacity: deletingId === item.id ? 0.4 : 1,
                            }}
                            className="hover:bg-red-50 dark:hover:bg-red-950"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal de Cadastro / Edição */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '16px',
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--color-bg-panel, #ffffff)',
              borderRadius: '12px',
              width: '100%',
              maxWidth: '480px',
              padding: '24px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
              position: 'relative',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '18px',
              }}
            >
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>
                {editingItem ? 'Editar Item de Estoque' : 'Novo Item de Estoque'}
              </h2>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px',
                  color: 'var(--color-text-muted, #6b7280)',
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {formError && (
              <div
                role="alert"
                style={{
                  padding: '10px 14px',
                  backgroundColor: '#fee2e2',
                  color: '#b91c1c',
                  borderRadius: '6px',
                  fontSize: '13px',
                  marginBottom: '16px',
                }}
              >
                {formError}
              </div>
            )}

            <form onSubmit={(e) => void handleSaveItem(e)}>
              <div style={{ marginBottom: '14px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                  Nome do Item *
                </label>
                <input
                  type="text"
                  required
                  value={itemForm.name}
                  onChange={(e) => setItemForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Ex.: Cerveja IPA 355ml, Pão de Hambúrguer, etc."
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid var(--color-border, #d1d5db)',
                    fontSize: '14px',
                  }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                    Categoria
                  </label>
                  <input
                    type="text"
                    value={itemForm.category}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, category: e.target.value }))}
                    placeholder="Ex.: Bebidas, Carnes, Insumos"
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #d1d5db)',
                      fontSize: '14px',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                    Unidade de Medida
                  </label>
                  <select
                    value={itemForm.unit_measure}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, unit_measure: e.target.value as UnitMeasure }))}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #d1d5db)',
                      fontSize: '14px',
                    }}
                  >
                    {Object.entries(unitLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                    Quantidade Atual
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.current_quantity}
                    onChange={(e) =>
                      setItemForm((prev) => ({ ...prev, current_quantity: parseFloat(e.target.value) || 0 }))
                    }
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #d1d5db)',
                      fontSize: '14px',
                    }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>
                    Limite de Ruptura (Alerta)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.alert_threshold}
                    onChange={(e) =>
                      setItemForm((prev) => ({ ...prev, alert_threshold: parseFloat(e.target.value) || 0 }))
                    }
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border, #d1d5db)',
                      fontSize: '14px',
                    }}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={formBusy}
                  style={{
                    padding: '8px 16px',
                    borderRadius: '6px',
                    border: '1px solid var(--color-border, #d1d5db)',
                    backgroundColor: 'transparent',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  style={{
                    padding: '8px 18px',
                    borderRadius: '6px',
                    border: 'none',
                    backgroundColor: 'var(--color-primary, #2563eb)',
                    color: '#ffffff',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {formBusy ? 'Salvando…' : editingItem ? 'Salvar Alterações' : 'Cadastrar Item'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
