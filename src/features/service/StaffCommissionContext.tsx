import { createContext, useContext, useState, type ReactNode } from 'react';

interface StaffCommissionContextType {
  isPrivate: boolean;
  togglePrivacy: () => void;
  historyCommissionInCents: number | null;
  setHistoryCommissionInCents: (cents: number | null) => void;
}

const StaffCommissionContext = createContext<StaffCommissionContextType | undefined>(undefined);

const STORAGE_KEY = 'elozi:hide-staff-commission';

export function StaffCommissionProvider({ children }: { children: ReactNode }) {
  const [isPrivate, setIsPrivate] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const [historyCommissionInCents, setHistoryCommissionInCents] = useState<number | null>(null);

  const togglePrivacy = () => {
    setIsPrivate((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Ignora possíveis erros de localStorage
      }
      return next;
    });
  };

  return (
    <StaffCommissionContext.Provider
      value={{
        isPrivate,
        togglePrivacy,
        historyCommissionInCents,
        setHistoryCommissionInCents,
      }}
    >
      {children}
    </StaffCommissionContext.Provider>
  );
}

export function useStaffCommission() {
  const ctx = useContext(StaffCommissionContext);
  if (!ctx) {
    throw new Error('useStaffCommission deve ser usado dentro de StaffCommissionProvider');
  }
  return ctx;
}
