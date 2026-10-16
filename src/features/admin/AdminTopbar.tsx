import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';
import {
  fetchUnreadAlerts,
  markAlertAsRead,
  markAllAlertsAsRead,
  subscribeToAlerts,
  type RestaurantAlert,
} from '../alerts/alertService';
import { type RestaurantIdentity } from '../restaurants/RestaurantProvider';
import {
  playWaiterCallSound,
  playDishReadySound,
  playLowStockSound,
} from '../../lib/soundAlerts';
import { SoundSettingsControl } from '../alerts/SoundSettingsControl';

interface AdminTopbarProps {
  restaurant: RestaurantIdentity;
}

function getAlertMeta(type: RestaurantAlert['type'], slug: string) {
  switch (type) {
    case 'dish_ready':
      return {
        color: '#16a34a',
        targetLink: `/${slug}/admin/mesas`,
        linkLabel: 'Ver mesas',
      };
    case 'call_waiter':
      return {
        color: '#2563eb',
        targetLink: `/${slug}/admin/mesas`,
        linkLabel: 'Ver mesas',
      };
    case 'close_table_request':
      return {
        color: '#d97706',
        targetLink: `/${slug}/admin/mesas`,
        linkLabel: 'Ver mesas',
      };
    case 'low_stock':
      return {
        color: '#ea580c',
        targetLink: `/${slug}/admin/catalogo`,
        linkLabel: 'Ver catálogo',
      };
    default:
      return {
        color: '#6b7280',
        targetLink: `/${slug}/admin`,
        linkLabel: 'Ver detalhes',
      };
  }
}

function renderAlertIcon(type: RestaurantAlert['type'], size = 18) {
  if (type === 'dish_ready') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    );
  }
  if (type === 'call_waiter') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    );
  }
  if (type === 'close_table_request') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
        <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
        <path d="M12 6v12" />
      </svg>
    );
  }
  if (type === 'low_stock') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function AdminTopbar({ restaurant }: AdminTopbarProps) {
  const [alerts, setAlerts] = useState<RestaurantAlert[]>([]);
  const [toasts, setToasts] = useState<RestaurantAlert[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const loadAlerts = async () => {
    try {
      const data = await fetchUnreadAlerts(restaurant.id);
      setAlerts(data);
    } catch (err) {
      console.error('Falha ao carregar alertas:', err);
    }
  };

  useEffect(() => {
    void loadAlerts();
    const unsubscribe = subscribeToAlerts(
      restaurant.id,
      () => {
        void loadAlerts();
      },
      (newAlert) => {
        // Tocar áudio de acordo com a natureza do alerta
        if (newAlert.type === 'dish_ready') {
          playDishReadySound();
        } else if (newAlert.type === 'call_waiter' || newAlert.type === 'close_table_request') {
          playWaiterCallSound();
        } else if (newAlert.type === 'low_stock') {
          playLowStockSound();
        } else {
          playLowStockSound();
        }

        // Exibir Toast flutuante com auto-dismiss em 6 segundos
        setToasts((prev) => [newAlert, ...prev.filter((t) => t.id !== newAlert.id)].slice(0, 4));
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== newAlert.id));
        }, 6000);
      }
    );
    return () => {
      unsubscribe();
    };
  }, [restaurant.id]);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Fechar dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const handleMarkAsRead = async (alertId: string) => {
    setMarkingId(alertId);
    try {
      await markAlertAsRead(alertId);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      console.error('Erro ao marcar alerta como lido:', err);
    } finally {
      setMarkingId(null);
    }
  };

  const handleMarkAllAsRead = async () => {
    setMarkingAll(true);
    try {
      await markAllAlertsAsRead(restaurant.id);
      setAlerts([]);
    } catch (err) {
      console.error('Erro ao marcar todos como lidos:', err);
    } finally {
      setMarkingAll(false);
    }
  };

  const unreadCount = alerts.length;

  return (
    <div className="admin-topbar print:hidden" style={{ position: 'relative' }}>
      <span>Administração do restaurante</span>

      <div className="admin-topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        {/* Controle de Áudio e Toques Personalizáveis */}
        <SoundSettingsControl />

        {/* Central de Notificações / Alertas */}
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            aria-label={`Central de Alertas: ${unreadCount} notificações não lidas`}
            style={{
              position: 'relative',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '6px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-main, #333)',
              borderRadius: '6px',
              transition: 'background-color 0.15s ease',
            }}
            className="hover:bg-black/5 dark:hover:bg-white/10"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
            {unreadCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: '1px',
                  right: '1px',
                  backgroundColor: '#ef4444',
                  color: '#ffffff',
                  fontSize: '11px',
                  fontWeight: 700,
                  minWidth: '17px',
                  height: '17px',
                  borderRadius: '9999px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '0 4px',
                  lineHeight: 1,
                  boxShadow: '0 0 0 2px var(--color-bg-panel, #ffffff)',
                }}
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {/* Dropdown de Alertas */}
          {isOpen && (
            <div
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                right: 0,
                width: '360px',
                maxHeight: '440px',
                backgroundColor: 'var(--color-bg-panel, #ffffff)',
                color: 'var(--color-text-main, #1c1917)',
                border: '1px solid var(--color-border, #e5e7eb)',
                borderRadius: '8px',
                boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid var(--color-border, #e5e7eb)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'var(--color-bg-subtle, #f9fafb)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontWeight: 600, fontSize: '14px' }}>Alertas do Restaurante</span>
                  {unreadCount > 0 && (
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        backgroundColor: '#fee2e2',
                        color: '#991b1b',
                        padding: '2px 6px',
                        borderRadius: '9999px',
                      }}
                    >
                      {unreadCount} novo{unreadCount > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleMarkAllAsRead()}
                    disabled={markingAll}
                    style={{
                      fontSize: '12px',
                      color: 'var(--color-primary, #2563eb)',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '2px 4px',
                      fontWeight: 500,
                    }}
                  >
                    {markingAll ? 'Marcando…' : 'Marcar todos como lidos'}
                  </button>
                )}
              </div>

              <div style={{ overflowY: 'auto', flex: 1, maxHeight: '340px' }}>
                {alerts.length === 0 ? (
                  <div
                    style={{
                      padding: '32px 16px',
                      textAlign: 'center',
                      color: 'var(--color-text-muted, #6b7280)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <svg
                      width="32"
                      height="32"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ opacity: 0.5 }}
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="9 11 12 14 22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>Nenhum alerta pendente</span>
                    <span style={{ fontSize: '11px', opacity: 0.8 }}>O estoque e a operação estão regulares.</span>
                  </div>
                ) : (
                  alerts.map((alert) => (
                    <div
                      key={alert.id}
                      style={{
                        padding: '12px 16px',
                        borderBottom: '1px solid var(--color-border-subtle, #f3f4f6)',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '12px',
                        transition: 'background-color 0.15s ease',
                      }}
                      className="hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <div
                        style={{
                          marginTop: '2px',
                          color: getAlertMeta(alert.type, restaurant.slug).color,
                          flexShrink: 0,
                        }}
                      >
                        {renderAlertIcon(alert.type)}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--color-text-main, #111827)' }}>
                          {alert.title}
                        </p>
                        <p
                          style={{
                            margin: '3px 0 0',
                            fontSize: '12px',
                            color: 'var(--color-text-muted, #4b5563)',
                            lineHeight: 1.4,
                          }}
                        >
                          {alert.message}
                        </p>
                        <span style={{ fontSize: '10px', color: 'var(--color-text-muted, #9ca3af)', display: 'block', marginTop: '4px' }}>
                          {new Date(alert.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} •{' '}
                          {new Date(alert.created_at).toLocaleDateString('pt-BR')}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleMarkAsRead(alert.id)}
                        disabled={markingId === alert.id}
                        title="Marcar como lido"
                        aria-label="Marcar como lido"
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '4px',
                          color: 'var(--color-text-muted, #9ca3af)',
                          borderRadius: '4px',
                          flexShrink: 0,
                        }}
                        className="hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-950"
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Ver cardápio */}
        <Link
          to={`/${restaurant.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          <span>Ver cardápio</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </Link>

        {/* Alternador de tema */}
        <ThemeToggleButton className="admin-theme-toggle" />

        {/* Perfil */}
        <span className="admin-profile" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          Administrador
        </span>
      </div>

      {/* Toasts Flutuantes de Alertas em Tempo Real (6 segundos auto-dismiss) */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: '16px',
            right: '16px',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxWidth: '380px',
            width: 'calc(100vw - 32px)',
            pointerEvents: 'none',
          }}
          aria-live="polite"
        >
          {toasts.map((toast) => {
            const meta = getAlertMeta(toast.type, restaurant.slug);

            return (
              <div
                key={toast.id}
                style={{
                  pointerEvents: 'auto',
                  backgroundColor: 'var(--color-bg-panel, #ffffff)',
                  color: 'var(--color-text-main, #1c1917)',
                  borderRadius: '12px',
                  border: '1px solid var(--color-border, #e5e7eb)',
                  borderLeft: `4px solid ${meta.color}`,
                  boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
                  padding: '12px 14px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                }}
              >
                <div style={{ color: meta.color, flexShrink: 0, marginTop: '2px' }}>
                  {renderAlertIcon(toast.type, 20)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: '13px',
                      fontWeight: 600,
                      color: 'var(--color-text-main, #111827)',
                    }}
                  >
                    {toast.title}
                  </p>
                  <p
                    style={{
                      margin: '2px 0 6px',
                      fontSize: '12px',
                      color: 'var(--color-text-muted, #4b5563)',
                      lineHeight: 1.4,
                    }}
                  >
                    {toast.message}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Link
                      to={meta.targetLink}
                      onClick={() => removeToast(toast.id)}
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: meta.color,
                        textDecoration: 'none',
                      }}
                      className="hover:underline"
                    >
                      {meta.linkLabel} →
                    </Link>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  aria-label="Fechar notificação"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px',
                    color: 'var(--color-text-muted, #9ca3af)',
                    borderRadius: '4px',
                    flexShrink: 0,
                  }}
                  className="hover:text-stone-700 dark:hover:text-stone-300"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
