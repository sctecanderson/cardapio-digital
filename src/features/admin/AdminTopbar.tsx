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

interface AdminTopbarProps {
  restaurant: RestaurantIdentity;
}

export function AdminTopbar({ restaurant }: AdminTopbarProps) {
  const [alerts, setAlerts] = useState<RestaurantAlert[]>([]);
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
    const unsubscribe = subscribeToAlerts(restaurant.id, () => {
      void loadAlerts();
    });
    return () => {
      unsubscribe();
    };
  }, [restaurant.id]);

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
                          color: alert.type === 'low_stock' ? '#d97706' : '#2563eb',
                          flexShrink: 0,
                        }}
                      >
                        {alert.type === 'low_stock' ? (
                          <svg
                            width="18"
                            height="18"
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
                        ) : (
                          <svg
                            width="18"
                            height="18"
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
                        )}
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
    </div>
  );
}
