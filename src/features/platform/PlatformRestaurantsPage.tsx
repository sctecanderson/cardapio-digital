import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase } from '../../lib/supabase';
import {
  assumePlatformRestaurantSetup,
  createPlatformRestaurant,
  getPlatformBranding,
  listPlatformRestaurants,
  setPlatformRestaurantActive,
  setPlatformRestaurantArchived,
  updatePlatformBranding,
  updatePlatformPlanCatalog,
  updateRestaurantSaasPlan,
  type PlatformBrandingSettings,
  type PlatformRestaurant,
  type SubscriptionPlan,
} from './platformRestaurants';
import {
  listDeletions,
  deletionLabel,
  type DeletionRecord,
} from './platformDeletions';
import { ThemeProvider, useTheme } from '../theme/ThemeContext';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';

function formatDate(isoString?: string | null) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString('pt-BR');
  } catch {
    return isoString;
  }
}

function suggestSlug(name: string) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

type TabOption =
  | 'overview'
  | 'restaurants'
  | 'plans'
  | 'security'
  | 'deletions'
  | 'settings';

function PlanBadge({
  plan,
  onClick,
}: {
  plan: SubscriptionPlan;
  onClick?: () => void;
}) {
  const config = {
    basic: {
      label: 'Básico',
      classes:
        'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800',
    },
    pro: {
      label: 'Pro',
      classes:
        'bg-teal-50 text-teal-800 border-teal-200 dark:bg-teal-950/60 dark:text-teal-300 dark:border-teal-800',
    },
    premium: {
      label: 'Premium',
      classes:
        'bg-amber-50 text-amber-900 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
    },
  }[plan];

  return (
    <button
      type="button"
      onClick={onClick}
      title="Clique para alterar o plano SaaS deste restaurante"
      className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold border transition-transform hover:scale-105 cursor-pointer ${config.classes}`}
    >
      {config.label}
    </button>
  );
}

function compressImageToDataUrl(file: File, maxDimension = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(reader.result as string);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/webp', 0.85);
        resolve(dataUrl);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function PlatformRestaurantsPage() {
  return (
    <ThemeProvider>
      <PlatformRestaurantsContent />
    </ThemeProvider>
  );
}

function PlatformRestaurantsContent() {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const mounted = useRef(false);
  const submitting = useRef(false);
  const requestId = useRef<string | null>(null);

  // Estados principais de dados
  const [restaurants, setRestaurants] = useState<PlatformRestaurant[]>([]);
  const [deletions, setDeletions] = useState<DeletionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [refresh, setRefresh] = useState(0);

  // Perfil do SuperAdmin & Identidade Visual
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('SuperAdmin');
  const [branding, setBranding] = useState<PlatformBrandingSettings>({
    platformName: 'Elozi',
    platformSubtitle: 'Administração da Plataforma',
    platformLogoUrl: null,
    superadminName: 'SuperAdmin',
    superadminAvatarUrl: null,
    updatedAt: new Date().toISOString(),
    basicPriceCents: 9900,
    basicMaxTables: 10,
    proPriceCents: 14900,
    proMaxTables: 25,
    premiumPriceCents: 19900,
    premiumMaxTables: 100,
  });
  const [tempPlatformName, setTempPlatformName] = useState('Elozi');
  const [tempPlatformSubtitle, setTempPlatformSubtitle] = useState('Administração da Plataforma');
  const [tempSuperadminName, setTempSuperadminName] = useState('SuperAdmin');
  const [brandingBusy, setBrandingBusy] = useState(false);
  const [brandingNotice, setBrandingNotice] = useState('');
  const [brandingError, setBrandingError] = useState('');

  const logoInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Menu suspenso de ações dos cards (⋯)
  const [openMenuRestaurantId, setOpenMenuRestaurantId] = useState<string | null>(null);

  // Navegação por abas e busca
  const [activeTab, setActiveTab] = useState<TabOption>('overview');
  const [searchQuery, setSearchQuery] = useState('');
  const [restaurantFilter, setRestaurantFilter] = useState<'current' | 'archived'>('current');
  const [planFilter, setPlanFilter] = useState<'all' | 'basic' | 'pro' | 'premium'>('all');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Formulário de cadastro
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setupRestaurantId, setSetupRestaurantId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Modais / seções de suspensão e arquivamento
  const [statusTarget, setStatusTarget] = useState<PlatformRestaurant | null>(null);
  const [statusReason, setStatusReason] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState('');

  const [archiveTarget, setArchiveTarget] = useState<PlatformRestaurant | null>(null);
  const [archiveName, setArchiveName] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState('');

  // Modal / Alteração de Plano SaaS (com valores e ciclo customizados)
  const [planTarget, setPlanTarget] = useState<PlatformRestaurant | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan>('basic');
  const [planCustomPrice, setPlanCustomPrice] = useState('99,00');
  const [planCustomMaxTables, setPlanCustomMaxTables] = useState<number | string>(10);
  const [planBillingCycleDays, setPlanBillingCycleDays] = useState<number | string>(30);
  const [planRenewCycle, setPlanRenewCycle] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState('');

  // Catálogo Global de Planos Editável (Aba Planos SaaS)
  const [catalogBasicPrice, setCatalogBasicPrice] = useState('99,00');
  const [catalogBasicMaxTables, setCatalogBasicMaxTables] = useState<number | string>(10);
  const [catalogProPrice, setCatalogProPrice] = useState('149,00');
  const [catalogProMaxTables, setCatalogProMaxTables] = useState<number | string>(25);
  const [catalogPremiumPrice, setCatalogPremiumPrice] = useState('199,00');
  const [catalogPremiumMaxTables, setCatalogPremiumMaxTables] = useState<number | string>(100);
  const [catalogSyncExisting, setCatalogSyncExisting] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState('');
  const [catalogError, setCatalogError] = useState('');

  useEffect(() => {
    mounted.current = true;
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user?.email) {
        setAdminEmail(data.user.email);
        const namePart = data.user.email.split('@')[0] || 'SuperAdmin';
        setAdminName(namePart.charAt(0).toUpperCase() + namePart.slice(1));
      }
    });

    getPlatformBranding()
      .then((b) => {
        if (mounted.current) {
          setBranding(b);
          setTempPlatformName(b.platformName);
          setTempPlatformSubtitle(b.platformSubtitle);
          setTempSuperadminName(b.superadminName);
          setCatalogBasicPrice((b.basicPriceCents / 100).toFixed(2).replace('.', ','));
          setCatalogBasicMaxTables(b.basicMaxTables);
          setCatalogProPrice((b.proPriceCents / 100).toFixed(2).replace('.', ','));
          setCatalogProMaxTables(b.proMaxTables);
          setCatalogPremiumPrice((b.premiumPriceCents / 100).toFixed(2).replace('.', ','));
          setCatalogPremiumMaxTables(b.premiumMaxTables);
        }
      })
      .catch(() => {});

    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    async function loadData() {
      setLoading(true);
      setListError('');

      try {
        const [restaurantsResult, deletionsResult, brandingResult] = await Promise.all([
          listPlatformRestaurants(),
          listDeletions().catch(() => []),
          getPlatformBranding().catch(() => null),
        ]);

        if (!disposed) {
          setRestaurants(restaurantsResult);
          setDeletions(deletionsResult);
          if (brandingResult) {
            setBranding(brandingResult);
            setTempPlatformName(brandingResult.platformName);
            setTempPlatformSubtitle(brandingResult.platformSubtitle);
            setTempSuperadminName(brandingResult.superadminName);
            setCatalogBasicPrice((brandingResult.basicPriceCents / 100).toFixed(2).replace('.', ','));
            setCatalogBasicMaxTables(brandingResult.basicMaxTables);
            setCatalogProPrice((brandingResult.proPriceCents / 100).toFixed(2).replace('.', ','));
            setCatalogProMaxTables(brandingResult.proMaxTables);
            setCatalogPremiumPrice((brandingResult.premiumPriceCents / 100).toFixed(2).replace('.', ','));
            setCatalogPremiumMaxTables(brandingResult.premiumMaxTables);
          }
        }
      } catch (cause) {
        if (!disposed) {
          setListError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar os dados da plataforma.',
          );
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    void loadData();

    return () => {
      disposed = true;
    };
  }, [refresh]);


  // Contagens para os KPIs e Badges
  const activeRestaurants = useMemo(
    () => restaurants.filter((r) => r.active && r.archivedAt === null),
    [restaurants],
  );

  const activeCount = useMemo(
    () => activeRestaurants.length,
    [activeRestaurants],
  );

  const archivedCount = useMemo(
    () => restaurants.filter((r) => r.archivedAt !== null).length,
    [restaurants],
  );

  const deletionsCount = useMemo(
    () => deletions.length,
    [deletions],
  );

  // Faturamento Real (MRR): soma dos monthlyPriceCents de todos os estabelecimentos com status ativo e não arquivados
  const realMrrInCents = useMemo(
    () => activeRestaurants.reduce((sum, r) => sum + r.monthlyPriceCents, 0),
    [activeRestaurants],
  );
  const realMrr = useMemo(() => realMrrInCents / 100, [realMrrInCents]);

  // ARR (Receita Anual Projetada)
  const arr = useMemo(() => realMrr * 12, [realMrr]);

  // Ticket Médio (ARPU)
  const arpu = useMemo(
    () => (activeCount > 0 ? realMrr / activeCount : 0),
    [realMrr, activeCount],
  );

  // Capacidade Global de Mesas
  const totalActiveTables = useMemo(
    () => activeRestaurants.reduce((sum, r) => sum + r.activeTablesCount, 0),
    [activeRestaurants],
  );
  const totalMaxTables = useMemo(
    () => activeRestaurants.reduce((sum, r) => sum + r.maxTables, 0),
    [activeRestaurants],
  );
  const globalTableCapacityPercent = useMemo(
    () => (totalMaxTables > 0 ? Math.round((totalActiveTables / totalMaxTables) * 100) : 0),
    [totalActiveTables, totalMaxTables],
  );

  // Distribuição de Receita e Clientes por Plano
  const planDistribution = useMemo(() => {
    const basicRests = activeRestaurants.filter((r) => r.subscriptionPlan === 'basic');
    const proRests = activeRestaurants.filter((r) => r.subscriptionPlan === 'pro');
    const premiumRests = activeRestaurants.filter((r) => r.subscriptionPlan === 'premium');

    const basicMrr = basicRests.reduce((s, r) => s + r.monthlyPriceCents, 0) / 100;
    const proMrr = proRests.reduce((s, r) => s + r.monthlyPriceCents, 0) / 100;
    const premiumMrr = premiumRests.reduce((s, r) => s + r.monthlyPriceCents, 0) / 100;

    return {
      basic: {
        count: basicRests.length,
        mrr: basicMrr,
        mrrPercent: realMrr > 0 ? Math.round((basicMrr / realMrr) * 100) : 0,
      },
      pro: {
        count: proRests.length,
        mrr: proMrr,
        mrrPercent: realMrr > 0 ? Math.round((proMrr / realMrr) * 100) : 0,
      },
      premium: {
        count: premiumRests.length,
        mrr: premiumMrr,
        mrrPercent: realMrr > 0 ? Math.round((premiumMrr / realMrr) * 100) : 0,
      },
    };
  }, [activeRestaurants, realMrr]);

  // Radar de Vencimentos & Ciclo de Assinatura (dias restantes crescente)
  const upcomingExpirations = useMemo(
    () => [...activeRestaurants].sort((a, b) => a.daysRemaining - b.daysRemaining),
    [activeRestaurants],
  );

  // Radar de Oportunidade de Upgrade (ordenado por % de mesas configuradas)
  const upgradeOpportunities = useMemo(() => {
    return [...activeRestaurants]
      .map((r) => {
        const usage = r.maxTables > 0 ? Math.round((r.activeTablesCount / r.maxTables) * 100) : 0;
        return { ...r, usage };
      })
      .sort((a, b) => b.usage - a.usage);
  }, [activeRestaurants]);

  // Filtro de restaurantes (por busca, por status ativos/arquivados e por plano)
  const filteredRestaurants = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return restaurants.filter((r) => {
      const matchesStatus =
        restaurantFilter === 'archived'
          ? r.archivedAt !== null
          : r.archivedAt === null;

      if (!matchesStatus) return false;

      const matchesPlan =
        planFilter === 'all' || r.subscriptionPlan === planFilter;

      if (!matchesPlan) return false;

      if (!q) return true;

      return (
        r.name.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q)
      );
    });
  }, [restaurants, restaurantFilter, planFilter, searchQuery]);

  // Filtro de exclusões
  const filteredDeletions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return deletions;
    return deletions.filter(
      (d) =>
        d.source_name.toLowerCase().includes(q) ||
        d.source_slug.toLowerCase().includes(q),
    );
  }, [deletions, searchQuery]);

  // Criação de restaurante
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;

    const cleanName = name.trim();
    const cleanSlug = slug.trim().toLowerCase();

    if (
      !cleanName ||
      cleanName.length > 120 ||
      cleanSlug.length < 3 ||
      cleanSlug.length > 80 ||
      !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(cleanSlug)
    ) {
      setError(
        'Confira o nome e o endereço. Use letras sem acento, números e hífens no endereço.',
      );
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    try {
      requestId.current ??= crypto.randomUUID();

      const created = await createPlatformRestaurant({
        id: requestId.current,
        name: cleanName,
        slug: cleanSlug,
      });

      if (!mounted.current) return;

      requestId.current = null;
      setName('');
      setSlug('');
      setSlugEdited(false);
      setNotice(
        `${created.name} cadastrado em /${created.slug}. Sua conta já está vinculada como administrador. Use "Administrar" para configurar o cardápio e identidade.`,
      );
      setRefresh((c) => c + 1);
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível cadastrar o restaurante.',
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // Assumir configuração / Administrar
  async function configureRestaurant(restaurant: PlatformRestaurant) {
    if (submitting.current) return;

    submitting.current = true;
    setBusy(true);
    setSetupRestaurantId(restaurant.id);
    setError('');
    setNotice('');

    try {
      await assumePlatformRestaurantSetup(restaurant.id);
      if (!mounted.current) return;
      window.open(`/${restaurant.slug}/admin`, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível abrir a administração do restaurante.',
        );
      }
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setSetupRestaurantId(null);
      }
    }
  }

  // Modais de status e arquivo
  function openStatusChange(restaurant: PlatformRestaurant) {
    if (submitting.current) return;
    setStatusTarget(restaurant);
    setArchiveTarget(null);
    setStatusReason('');
    setStatusError('');
    setNotice('');
  }

  async function handleStatusChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!statusTarget || submitting.current) return;

    const target = statusTarget;
    const nextActive = !target.active;

    submitting.current = true;
    setBusy(true);
    setStatusBusy(true);
    setStatusError('');

    try {
      const updated = await setPlatformRestaurantActive(
        target.id,
        target.active,
        nextActive,
        statusReason,
      );

      if (!mounted.current) return;

      setRestaurants((curr) =>
        curr.map((r) => (r.id === updated.id ? { ...r, active: updated.active } : r)),
      );

      setStatusTarget(null);
      setStatusReason('');
      setNotice(`${target.name} ${updated.active ? 'reativado' : 'suspenso'} com sucesso.`);
      setRefresh((c) => c + 1);
    } catch (cause) {
      if (mounted.current) {
        setStatusError(
          cause instanceof Error ? cause.message : 'Não foi possível alterar o status.',
        );
        setRefresh((c) => c + 1);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setStatusBusy(false);
      }
    }
  }

  function openArchiveChange(restaurant: PlatformRestaurant) {
    if (submitting.current) return;
    setStatusTarget(null);
    setArchiveTarget(restaurant);
    setArchiveName('');
    setArchiveReason('');
    setArchiveError('');
    setNotice('');
  }

  async function handleArchiveChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!archiveTarget || submitting.current) return;

    const target = archiveTarget;
    const shouldArchive = target.archivedAt === null;

    submitting.current = true;
    setBusy(true);
    setArchiveBusy(true);
    setArchiveError('');

    try {
      const updated = await setPlatformRestaurantArchived(
        target.id,
        shouldArchive,
        archiveName,
        archiveReason,
      );

      if (!mounted.current) return;

      setRestaurants((curr) =>
        curr.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)),
      );

      setArchiveTarget(null);
      setArchiveName('');
      setArchiveReason('');
      setNotice(
        shouldArchive
          ? `${target.name} arquivado com sucesso.`
          : `${target.name} restaurado. Ele permanece suspenso até sua reativação.`,
      );
      setRefresh((c) => c + 1);
    } catch (cause) {
      if (mounted.current) {
        setArchiveError(
          cause instanceof Error
            ? cause.message
            : 'Não foi possível alterar o arquivamento.',
        );
        setRefresh((c) => c + 1);
      }
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setArchiveBusy(false);
      }
    }
  }

  function openPlanModal(target: PlatformRestaurant) {
    setPlanTarget({ ...target });
    setSelectedPlan(target.subscriptionPlan);
    setPlanCustomPrice((target.monthlyPriceCents / 100).toFixed(2).replace('.', ','));
    setPlanCustomMaxTables(target.maxTables);
    setPlanBillingCycleDays(target.billingCycleDays || 30);
    setPlanRenewCycle(false);
    setPlanError('');
  }

  function handleSelectTier(tier: SubscriptionPlan) {
    setSelectedPlan(tier);
    if (tier === 'basic') {
      setPlanCustomPrice((branding.basicPriceCents / 100).toFixed(2).replace('.', ','));
      setPlanCustomMaxTables(branding.basicMaxTables);
    } else if (tier === 'pro') {
      setPlanCustomPrice((branding.proPriceCents / 100).toFixed(2).replace('.', ','));
      setPlanCustomMaxTables(branding.proMaxTables);
    } else {
      setPlanCustomPrice((branding.premiumPriceCents / 100).toFixed(2).replace('.', ','));
      setPlanCustomMaxTables(branding.premiumMaxTables);
    }
  }

  async function handleQuickRenew(restaurant: PlatformRestaurant) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const updated = await updateRestaurantSaasPlan(
        restaurant.id,
        restaurant.subscriptionPlan,
        restaurant.monthlyPriceCents,
        restaurant.maxTables,
        30,
        true,
      );
      setRestaurants((prev) =>
        prev.map((r) =>
          r.id === restaurant.id
            ? {
                ...r,
                ...updated,
                subscriptionStartedAt: updated.subscriptionStartedAt || r.subscriptionStartedAt,
                subscriptionExpiresAt: updated.subscriptionExpiresAt || r.subscriptionExpiresAt,
                billingCycleDays: updated.billingCycleDays || r.billingCycleDays,
                daysRemaining: updated.daysRemaining !== undefined ? updated.daysRemaining : r.daysRemaining,
              }
            : r,
        ),
      );
      setNotice(`Assinatura de ${restaurant.name} renovada por mais 30 dias com sucesso!`);
      setRefresh((c) => c + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao renovar assinatura.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function handlePlanSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!planTarget || planBusy) return;

    const cleanPriceStr = String(planCustomPrice).replace(/\./g, '').replace(',', '.').trim();
    const priceNumber = parseFloat(cleanPriceStr);
    if (isNaN(priceNumber) || priceNumber < 0) {
      setPlanError('Informe um valor mensal válido em Reais (ex.: 149,00 ou 300,00).');
      return;
    }
    const priceInCents = Math.round(priceNumber * 100);

    const tablesNumber = Number(planCustomMaxTables);
    if (!Number.isInteger(tablesNumber) || tablesNumber < 1 || tablesNumber > 500) {
      setPlanError('O limite de mesas deve ser um número inteiro entre 1 e 500.');
      return;
    }

    const cycleDaysNumber = Number(planBillingCycleDays);
    if (!Number.isInteger(cycleDaysNumber) || cycleDaysNumber < 1 || cycleDaysNumber > 365) {
      setPlanError('O ciclo deve ser entre 1 e 365 dias.');
      return;
    }

    setPlanBusy(true);
    setPlanError('');

    try {
      const updated = await updateRestaurantSaasPlan(
        planTarget.id,
        selectedPlan,
        priceInCents,
        tablesNumber,
        cycleDaysNumber,
        planRenewCycle,
      );
      setRestaurants((prev) =>
        prev.map((r) =>
          r.id === planTarget.id
            ? {
                ...r,
                subscriptionPlan: updated.subscriptionPlan,
                monthlyPriceCents: updated.monthlyPriceCents,
                maxTables: updated.maxTables,
                activeTablesCount: updated.activeTablesCount,
                subscriptionStartedAt: updated.subscriptionStartedAt || r.subscriptionStartedAt,
                subscriptionExpiresAt: updated.subscriptionExpiresAt || r.subscriptionExpiresAt,
                billingCycleDays: updated.billingCycleDays || r.billingCycleDays,
                daysRemaining: updated.daysRemaining !== undefined ? updated.daysRemaining : r.daysRemaining,
              }
            : r,
        ),
      );
      setPlanTarget(null);
      setNotice(
        `Plano de ${planTarget.name} atualizado para ${updated.subscriptionPlan.toUpperCase()} (R$ ${(priceInCents / 100).toFixed(2).replace('.', ',')}/mês, ${tablesNumber} mesas) com sucesso.`
      );
      setRefresh((c) => c + 1);
    } catch (err) {
      setPlanError(
        err instanceof Error ? err.message : 'Não foi possível atualizar o plano do restaurante.',
      );
    } finally {
      setPlanBusy(false);
    }
  }

  async function handleSaveCatalog(e: FormEvent) {
    e.preventDefault();
    setCatalogBusy(true);
    setCatalogError('');
    setCatalogNotice('');

    const parseCents = (val: string | number) => {
      const s = String(val).replace(/\./g, '').replace(',', '.').trim();
      const n = parseFloat(s);
      return isNaN(n) ? -1 : Math.round(n * 100);
    };

    const basicCents = parseCents(catalogBasicPrice);
    const proCents = parseCents(catalogProPrice);
    const premiumCents = parseCents(catalogPremiumPrice);

    if (basicCents < 0 || proCents < 0 || premiumCents < 0) {
      setCatalogError('Informe valores monetários válidos para todos os planos.');
      setCatalogBusy(false);
      return;
    }

    const basicTables = Number(catalogBasicMaxTables);
    const proTables = Number(catalogProMaxTables);
    const premiumTables = Number(catalogPremiumMaxTables);

    if (!basicTables || !proTables || !premiumTables ||
        basicTables < 1 || basicTables > 500 ||
        proTables < 1 || proTables > 500 ||
        premiumTables < 1 || premiumTables > 500) {
      setCatalogError('Os limites de mesas devem ser números entre 1 e 500.');
      setCatalogBusy(false);
      return;
    }

    try {
      const result = await updatePlatformPlanCatalog({
        basicPriceCents: basicCents,
        basicMaxTables: basicTables,
        proPriceCents: proCents,
        proMaxTables: proTables,
        premiumPriceCents: premiumCents,
        premiumMaxTables: premiumTables,
        syncExistingRestaurants: catalogSyncExisting,
      });

      setBranding((b) => ({
        ...b,
        basicPriceCents: basicCents,
        basicMaxTables: basicTables,
        proPriceCents: proCents,
        proMaxTables: proTables,
        premiumPriceCents: premiumCents,
        premiumMaxTables: premiumTables,
      }));

      if (catalogSyncExisting && result.syncedRestaurantsCount > 0) {
        setCatalogNotice(`Catálogo atualizado e ${result.syncedRestaurantsCount} restaurante(s) sincronizado(s) com sucesso!`);
        const refreshed = await listPlatformRestaurants();
        setRestaurants(refreshed);
      } else {
        setCatalogNotice('Catálogo oficial de planos atualizado com sucesso!');
      }
      setRefresh((c) => c + 1);
    } catch (err) {
      setCatalogError(err instanceof Error ? err.message : 'Erro ao atualizar catálogo de planos.');
    } finally {
      setCatalogBusy(false);
    }
  }

  async function handleLogoUpload(file: File) {
    setBrandingBusy(true);
    setBrandingError('');
    setBrandingNotice('');
    try {
      const dataUrl = await compressImageToDataUrl(file, 256);
      const updated = await updatePlatformBranding({ platformLogoUrl: dataUrl });
      setBranding(updated);
      setBrandingNotice('Logo da plataforma atualizada com sucesso!');
    } catch (err) {
      setBrandingError(err instanceof Error ? err.message : 'Erro ao processar imagem da logo.');
    } finally {
      setBrandingBusy(false);
    }
  }

  async function handleRestoreDefaultLogo() {
    setBrandingBusy(true);
    setBrandingError('');
    setBrandingNotice('');
    try {
      const updated = await updatePlatformBranding({ clearLogo: true });
      setBranding(updated);
      setBrandingNotice('Logo restaurada para o padrão Elozi.');
    } catch (err) {
      setBrandingError(err instanceof Error ? err.message : 'Erro ao restaurar logo padrão.');
    } finally {
      setBrandingBusy(false);
    }
  }

  async function handleAvatarUpload(file: File) {
    setBrandingBusy(true);
    setBrandingError('');
    setBrandingNotice('');
    try {
      const dataUrl = await compressImageToDataUrl(file, 256);
      const updated = await updatePlatformBranding({ superadminAvatarUrl: dataUrl });
      setBranding(updated);
      setBrandingNotice('Foto de perfil do SuperAdmin atualizada com sucesso!');
    } catch (err) {
      setBrandingError(err instanceof Error ? err.message : 'Erro ao processar foto de perfil.');
    } finally {
      setBrandingBusy(false);
    }
  }

  async function handleRemoveAvatar() {
    setBrandingBusy(true);
    setBrandingError('');
    setBrandingNotice('');
    try {
      const updated = await updatePlatformBranding({ clearAvatar: true });
      setBranding(updated);
      setBrandingNotice('Foto de perfil removida. Exibindo inicial padrão.');
    } catch (err) {
      setBrandingError(err instanceof Error ? err.message : 'Erro ao remover foto de perfil.');
    } finally {
      setBrandingBusy(false);
    }
  }

  async function handleSaveBrandingSettings(e: FormEvent) {
    e.preventDefault();
    setBrandingBusy(true);
    setBrandingError('');
    setBrandingNotice('');
    try {
      const updated = await updatePlatformBranding({
        platformName: tempPlatformName,
        platformSubtitle: tempPlatformSubtitle,
        superadminName: tempSuperadminName,
      });
      setBranding(updated);
      setBrandingNotice('Configurações da plataforma salvas com sucesso!');
    } catch (err) {
      setBrandingError(err instanceof Error ? err.message : 'Erro ao salvar configurações.');
    } finally {
      setBrandingBusy(false);
    }
  }

  async function logout() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');

    try {
      const { error: logoutError } = await supabase.auth.signOut({ scope: 'local' });
      if (logoutError) throw new Error('Não foi possível sair. Tente novamente.');
      if (mounted.current) navigate('/plataforma/acesso', { replace: true });
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Não foi possível sair.');
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <div
      data-theme={theme}
      className={`min-h-screen flex bg-[#f8fafc] text-slate-900 dark:bg-stone-950 dark:text-stone-100 font-sans ${theme === 'dark' ? 'dark' : ''}`}
    >
      {/* ====================================================================
          1. SIDEBAR LATERAL ESQUERDA (FIXA E ESCURA #0f172a)
         ==================================================================== */}
      {/* Overlay Mobile */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed lg:sticky top-0 left-0 z-50 h-screen w-64 bg-[#0f172a] text-slate-200 flex flex-col justify-between shrink-0 border-r border-slate-800 transition-transform duration-200 ease-in-out ${
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="flex flex-col flex-1 overflow-y-auto">
          {/* 1.1 — Cabeçalho da Marca */}
          <div className="p-5 border-b border-slate-800/80 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {branding.platformLogoUrl ? (
                <img
                  src={branding.platformLogoUrl}
                  alt={branding.platformName}
                  className="h-9 w-9 rounded-xl object-contain bg-white/10 p-1 border border-white/20 shadow-xs"
                />
              ) : (
                <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-white font-black text-lg shadow-sm">
                  E
                </div>
              )}
              <div className="overflow-hidden">
                <strong className="text-lg font-black tracking-tight text-white block leading-none truncate max-w-[140px]">
                  {branding.platformName}
                </strong>
                <span className="text-[11px] text-slate-400 font-medium truncate block max-w-[140px]">
                  {branding.platformSubtitle}
                </span>
              </div>
            </div>

            {/* Botão fechar mobile */}
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(false)}
              className="lg:hidden text-slate-400 hover:text-white p-1 rounded-lg cursor-pointer"
              aria-label="Fechar menu"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* 1.2 — Card de Perfil do SuperAdmin */}
          <div className="px-3 py-3 mx-3 my-4 rounded-xl bg-slate-800/60 border border-slate-700/50 flex items-center gap-3">
            {branding.superadminAvatarUrl ? (
              <img
                src={branding.superadminAvatarUrl}
                alt={branding.superadminName}
                className="w-9 h-9 rounded-full object-cover border-2 border-emerald-400 shrink-0 shadow-xs"
              />
            ) : (
              <div className="w-9 h-9 rounded-full bg-emerald-600 text-white font-bold text-sm flex items-center justify-center shrink-0 shadow-xs">
                {branding.superadminName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="overflow-hidden">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-400">
                  SuperAdmin
                </span>
              </div>
              <strong className="block text-xs font-bold text-white truncate max-w-[130px]" title={adminEmail || branding.superadminName}>
                {branding.superadminName}
              </strong>
              <span className="block text-[10px] text-slate-400 leading-tight">
                Nível de acesso
              </span>
            </div>
          </div>

          {/* 1.3 — Menu de Navegação Lateral */}
          <nav className="px-3 space-y-1" aria-label="Navegação da Plataforma">
            <button
              type="button"
              onClick={() => {
                setActiveTab('overview');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left cursor-pointer ${
                activeTab === 'overview'
                  ? 'bg-slate-800 text-white border-l-3 border-emerald-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              <span>Visão Geral</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('restaurants');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left cursor-pointer ${
                activeTab === 'restaurants'
                  ? 'bg-slate-800 text-white border-l-3 border-emerald-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <div className="flex items-center gap-3">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span>Clientes / Restaurantes</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-extrabold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                {activeCount} Ativos
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('plans');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left cursor-pointer ${
                activeTab === 'plans'
                  ? 'bg-slate-800 text-white border-l-3 border-emerald-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <div className="flex items-center gap-3">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
                  <line x1="1" y1="10" x2="23" y2="10" />
                </svg>
                <span>Planos & Assinaturas</span>
              </div>
              <span className="text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-wider bg-blue-500/20 text-blue-300 border border-blue-500/30">
                Novidade
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('security');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left cursor-pointer ${
                activeTab === 'security'
                  ? 'bg-slate-800 text-white border-l-3 border-emerald-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <polyline points="9 12 11 14 15 10" />
              </svg>
              <span>Segurança & Backups</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('deletions');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left cursor-pointer ${
                activeTab === 'deletions'
                  ? 'bg-slate-800 text-white border-l-3 border-emerald-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
              <span>Histórico de Exclusões</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('settings');
                setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-bold transition-all text-left cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-slate-800 text-white border-l-3 border-emerald-400 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
              }`}
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Configurações</span>
            </button>
          </nav>
        </div>

        {/* 1.4 — Rodapé da Sidebar */}
        <div className="p-4 border-t border-slate-800/80">
          <button
            type="button"
            disabled={busy}
            onClick={() => void logout()}
            className="w-full py-2.5 px-3 rounded-xl border border-slate-700/60 hover:bg-red-500/10 hover:border-red-500/30 text-slate-300 hover:text-red-400 text-xs font-bold flex items-center gap-2 justify-center transition-all cursor-pointer disabled:opacity-50"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span>{busy ? 'Saindo…' : 'Sair da Plataforma'}</span>
          </button>
        </div>
      </aside>

      {/* ====================================================================
          2. ÁREA PRINCIPAL (TOPBAR + KPIS + CONTEÚDO)
         ==================================================================== */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* 2.1 — Topbar Branca */}
        <header className="h-16 border-b border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 px-4 lg:px-8 flex items-center justify-between sticky top-0 z-30 shadow-xs">
          <div className="flex items-center gap-3 flex-1 max-w-md">
            {/* Botão menu mobile */}
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="lg:hidden p-2 rounded-xl border border-slate-200 dark:border-stone-700 text-slate-600 dark:text-stone-300 hover:bg-slate-50 cursor-pointer"
              aria-label="Abrir menu"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            {/* Campo de Busca Funcional */}
            <div className="relative w-full">
              <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar restaurante, slug ou admin…"
                className="w-full pl-9 pr-8 py-2 text-xs rounded-xl bg-slate-100 dark:bg-stone-800 border border-slate-200 dark:border-stone-700 text-slate-900 dark:text-stone-100 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 focus:bg-white dark:focus:bg-stone-900 transition-all font-medium shadow-2xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-400 hover:text-slate-600"
                  aria-label="Limpar busca"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Indicadores à Direita */}
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/60 select-none">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Sistemas OK</span>
            </span>

            {/* Ícone de mensagens com badge vermelha 1 */}
            <div className="relative" title="Mensagens da plataforma">
              <button
                type="button"
                className="h-9 w-9 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-700 flex items-center justify-center transition-colors cursor-pointer"
                aria-label="Mensagens da plataforma"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
              </button>
              <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-red-600 text-white text-[9px] font-black flex items-center justify-center shadow-xs">
                1
              </span>
            </div>

            {/* Ícone de sino (Notificações) */}
            <button
              type="button"
              className="h-9 w-9 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-slate-600 dark:text-stone-300 hover:bg-slate-50 dark:hover:bg-stone-700 flex items-center justify-center transition-colors cursor-pointer"
              aria-label="Notificações operacionais"
              title="Notificações operacionais"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </button>

            <ThemeToggleButton className="h-9 w-9 !rounded-xl !border !border-slate-200 dark:!border-stone-700 !bg-white dark:!bg-stone-800 !text-slate-600 dark:!text-stone-300 hover:!bg-slate-50 dark:hover:!bg-stone-700 flex items-center justify-center cursor-pointer transition-colors" />
          </div>
        </header>

        {/* 2.2 — Cabeçalho de Título e Cards de KPIs */}
        <main id="platform-content" className="flex-1 p-4 lg:p-8 space-y-6 max-w-[1440px] w-full mx-auto px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200/80 dark:border-stone-800/80 pb-6">
            <div>
              <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">
                Painel de Administração
              </h1>
              <p className="text-xs text-slate-500 dark:text-stone-400 mt-1">
                Controle central da infraestrutura e estabelecimentos cadastrados na Elozi.
              </p>
            </div>

            {/* 3 Cards de KPIs Compactos (Layout horizontal limpo com SVGs) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full lg:w-auto">
              {/* KPI 1: Faturamento Estimado (MRR) */}
              <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4 shadow-xs min-w-56">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="6" width="20" height="12" rx="2" />
                      <circle cx="12" cy="12" r="2" />
                      <path d="M6 12h.01M18 12h.01" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-slate-500 dark:text-stone-400 block truncate">
                      Faturamento Estimado (MRR)
                    </span>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <strong className="text-lg font-black text-slate-900 dark:text-white font-mono tracking-tight">
                        {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(realMrr)}
                      </strong>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 whitespace-nowrap">
                        +8% este mês
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* KPI 2: Restaurantes Ativos */}
              <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4 shadow-xs min-w-56">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      <path d="M9 22V12h6v10" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-slate-500 dark:text-stone-400 block truncate">
                      Restaurantes Ativos
                    </span>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <strong className="text-lg font-black text-slate-900 dark:text-white tracking-tight">
                        {activeCount} Ativo{activeCount !== 1 ? 's' : ''} / {archivedCount} Arquivado{archivedCount !== 1 ? 's' : ''}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* KPI 3: Backups Preservados */}
              <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4 shadow-xs min-w-56">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="12" x2="2" y2="12" />
                      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                      <line x1="6" y1="16" x2="6.01" y2="16" />
                      <line x1="10" y1="16" x2="10.01" y2="16" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-slate-500 dark:text-stone-400 block truncate">
                      Backups Preservados
                    </span>
                    <div className="flex items-baseline gap-2 mt-0.5">
                      <strong className="text-lg font-black text-slate-900 dark:text-white tracking-tight">
                        {deletionsCount} Backup{deletionsCount !== 1 ? 's' : ''} Ativo{deletionsCount !== 1 ? 's' : ''}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ================================================================
              3. CONTEÚDO DINÂMICO CONFORME ABA SELECIONADA
             ================================================================ */}

          {/* AVISOS GLOBAIS DE OPERAÇÃO */}
          {error && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs font-semibold text-red-700 shadow-2xs flex items-center justify-between">
              <span>{error}</span>
              <button type="button" onClick={() => setError('')} className="text-red-500 hover:text-red-700 p-1" aria-label="Fechar aviso">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {notice && (
            <div role="status" className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 shadow-2xs flex items-center justify-between">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice('')} className="text-emerald-600 hover:text-emerald-800 p-1" aria-label="Fechar aviso">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {/* ----------------------------------------------------------------
              ABA: VISÃO GERAL (COCKPIT EXECUTIVO SAAS)
             ---------------------------------------------------------------- */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              {/* Cockpit Header */}
              <div>
                <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                  Cockpit Executivo SaaS
                </h2>
                <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                  Métricas financeiras consolidadas, ciclo de renovações e radar de crescimento da plataforma.
                </p>
              </div>

              {/* 4 Cards de KPIs Executivos */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* 1. MRR */}
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500 dark:text-stone-400">MRR Consolidado</span>
                    <span className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="1" x2="12" y2="23" />
                        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                      </svg>
                    </span>
                  </div>
                  <strong className="block text-2xl font-black text-slate-900 dark:text-white tracking-tight mt-2 font-mono">
                    {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(realMrr)}
                  </strong>
                  <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 mt-1">
                    ARR Projetado: {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(arr)}
                  </p>
                </div>

                {/* 2. Clientes Ativos */}
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500 dark:text-stone-400">Clientes Ativos</span>
                    <span className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </span>
                  </div>
                  <strong className="block text-2xl font-black text-slate-900 dark:text-white tracking-tight mt-2">
                    {activeRestaurants.length}
                    <span className="text-xs font-normal text-slate-400 ml-1.5">/ {restaurants.length} total</span>
                  </strong>
                  <p className="text-[11px] text-slate-500 dark:text-stone-400 mt-1">
                    {restaurants.length > 0 ? Math.round((activeRestaurants.length / restaurants.length) * 100) : 0}% de adesão ativa
                  </p>
                </div>

                {/* 3. ARPU */}
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500 dark:text-stone-400">ARPU (Ticket Médio)</span>
                    <span className="p-1.5 rounded-lg bg-teal-50 dark:bg-teal-950/40 text-teal-600 dark:text-teal-400">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
                        <line x1="12" y1="6" x2="12" y2="8" />
                        <line x1="12" y1="16" x2="12" y2="18" />
                      </svg>
                    </span>
                  </div>
                  <strong className="block text-2xl font-black text-slate-900 dark:text-white tracking-tight mt-2 font-mono">
                    {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(arpu)}
                  </strong>
                  <p className="text-[11px] text-slate-500 dark:text-stone-400 mt-1">
                    Receita média por restaurante
                  </p>
                </div>

                {/* 4. Capacidade Global de Mesas */}
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-500 dark:text-stone-400">Capacidade de Mesas</span>
                    <span className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <path d="M3 9h18" />
                        <path d="M9 21V9" />
                      </svg>
                    </span>
                  </div>
                  <strong className="block text-2xl font-black text-slate-900 dark:text-white tracking-tight mt-2">
                    {totalActiveTables}
                    <span className="text-xs font-normal text-slate-400 ml-1.5">/ {totalMaxTables} contratadas</span>
                  </strong>
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold mt-1">
                    {globalTableCapacityPercent}% de utilização global
                  </p>
                </div>
              </div>

              {/* Grid Central: Distribuição de Planos vs Radar de Vencimentos */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Coluna 1: Distribuição de Receita & Clientes por Plano */}
                <section className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs flex flex-col justify-between">
                  <div>
                    <h3 className="text-base font-black text-slate-900 dark:text-white tracking-tight">
                      Distribuição por Plano
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                      Participação de cada tier no faturamento e base de estabelecimentos.
                    </p>

                    <div className="mt-6 space-y-5">
                      {/* Básico */}
                      <div>
                        <div className="flex items-center justify-between text-xs font-bold mb-1.5">
                          <span className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />
                            <span className="text-slate-800 dark:text-stone-200">Plano Básico</span>
                            <span className="text-[11px] font-normal text-slate-400">({planDistribution.basic.count} clientes)</span>
                          </span>
                          <span className="font-mono text-slate-900 dark:text-white">
                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(planDistribution.basic.mrr)}/mês
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-stone-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-blue-500 transition-all"
                            style={{ width: `${planDistribution.basic.mrrPercent}%` }}
                          />
                        </div>
                        <div className="text-right text-[10px] text-slate-400 font-semibold mt-0.5">
                          {planDistribution.basic.mrrPercent}% do faturamento
                        </div>
                      </div>

                      {/* Pro */}
                      <div>
                        <div className="flex items-center justify-between text-xs font-bold mb-1.5">
                          <span className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-teal-500 inline-block" />
                            <span className="text-slate-800 dark:text-stone-200">Plano Pro</span>
                            <span className="text-[11px] font-normal text-slate-400">({planDistribution.pro.count} clientes)</span>
                          </span>
                          <span className="font-mono text-slate-900 dark:text-white">
                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(planDistribution.pro.mrr)}/mês
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-stone-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-teal-500 transition-all"
                            style={{ width: `${planDistribution.pro.mrrPercent}%` }}
                          />
                        </div>
                        <div className="text-right text-[10px] text-slate-400 font-semibold mt-0.5">
                          {planDistribution.pro.mrrPercent}% do faturamento
                        </div>
                      </div>

                      {/* Premium */}
                      <div>
                        <div className="flex items-center justify-between text-xs font-bold mb-1.5">
                          <span className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
                            <span className="text-slate-800 dark:text-stone-200">Plano Premium</span>
                            <span className="text-[11px] font-normal text-slate-400">({planDistribution.premium.count} clientes)</span>
                          </span>
                          <span className="font-mono text-slate-900 dark:text-white">
                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(planDistribution.premium.mrr)}/mês
                          </span>
                        </div>
                        <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-stone-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-amber-500 transition-all"
                            style={{ width: `${planDistribution.premium.mrrPercent}%` }}
                          />
                        </div>
                        <div className="text-right text-[10px] text-slate-400 font-semibold mt-0.5">
                          {planDistribution.premium.mrrPercent}% do faturamento
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-slate-100 dark:border-stone-800 flex items-center justify-between text-xs">
                    <span className="text-slate-500 dark:text-stone-400 font-medium">Configurar valores padrão</span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('plans')}
                      className="font-bold text-slate-900 dark:text-white hover:underline cursor-pointer flex items-center gap-1"
                    >
                      <span>Ir para Planos SaaS</span>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  </div>
                </section>

                {/* Coluna 2: Radar de Vencimentos & Vigência da Assinatura */}
                <section className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-base font-black text-slate-900 dark:text-white tracking-tight">
                          Radar de Vencimentos
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                          Vigência dos ciclos e estabelecimentos com renovação próxima.
                        </p>
                      </div>
                      <span className="text-xs font-mono font-bold text-slate-500">
                        {upcomingExpirations.length} estabelecimentos
                      </span>
                    </div>

                    <div className="mt-4 divide-y divide-slate-100 dark:divide-stone-800 max-h-80 overflow-y-auto pr-1">
                      {upcomingExpirations.length === 0 ? (
                        <p className="text-xs text-slate-400 italic py-4 text-center">
                          Nenhum restaurante ativo registrado.
                        </p>
                      ) : (
                        upcomingExpirations.map((rest) => {
                          const isExpired = rest.daysRemaining <= 0;
                          const isWarning = rest.daysRemaining > 0 && rest.daysRemaining <= 7;
                          const barWidth = Math.max(0, Math.min(100, Math.round((rest.daysRemaining / (rest.billingCycleDays || 30)) * 100)));

                          return (
                            <div key={rest.id} className="py-3 flex flex-col gap-2">
                              <div className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                  <strong className="text-slate-900 dark:text-white font-bold truncate">
                                    {rest.name}
                                  </strong>
                                  <PlanBadge plan={rest.subscriptionPlan} />
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span
                                    className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                      isExpired
                                        ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-300'
                                        : isWarning
                                        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-300'
                                        : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-300'
                                    }`}
                                  >
                                    {isExpired
                                      ? 'Vencida'
                                      : `${rest.daysRemaining} dia${rest.daysRemaining !== 1 ? 's' : ''} restante${rest.daysRemaining !== 1 ? 's' : ''}`}
                                  </span>
                                </div>
                              </div>

                              {/* Barra de Vigência */}
                              <div className="w-full h-1.5 rounded-full bg-slate-100 dark:bg-stone-800 overflow-hidden">
                                <div
                                  className={`h-full rounded-full transition-all ${
                                    isExpired
                                      ? 'bg-rose-500'
                                      : isWarning
                                      ? 'bg-amber-500'
                                      : 'bg-emerald-500'
                                  }`}
                                  style={{ width: `${barWidth}%` }}
                                />
                              </div>

                              <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-stone-400">
                                <span>
                                  {isExpired ? 'Venceu em: ' : 'Renova em: '}
                                  <strong className="text-slate-700 dark:text-stone-300 font-mono">
                                    {formatDate(rest.subscriptionExpiresAt)}
                                  </strong>
                                </span>

                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => void handleQuickRenew(rest)}
                                    disabled={busy}
                                    className="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/60 font-bold text-[10px] transition-colors cursor-pointer disabled:opacity-50"
                                  >
                                    +30d
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openPlanModal(rest)}
                                    className="px-2 py-0.5 rounded-md border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-slate-600 dark:text-stone-300 font-bold text-[10px] transition-colors cursor-pointer"
                                  >
                                    Plano
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-stone-800 text-[11px] text-slate-400">
                    O ciclo padrão é de 30 dias com cálculo automático de dias restantes via PostgreSQL.
                  </div>
                </section>
              </div>

              {/* Seção Inferior: Radar de Oportunidades de Upgrade (Ocupação de Mesas >= 80%) */}
              <section className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                  <div>
                    <h3 className="text-base font-black text-slate-900 dark:text-white tracking-tight">
                      Radar de Oportunidades de Upgrade
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                      Estabelecimentos próximos ou no limite máximo de mesas do seu plano atual.
                    </p>
                  </div>
                  <span className="text-xs font-mono font-bold text-slate-500">
                    {upgradeOpportunities.filter((r) => r.usage >= 80).length} oportunidade(s) ativa(s)
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {upgradeOpportunities.map((rest) => {
                    const isHigh = rest.usage >= 80;
                    return (
                      <div
                        key={rest.id}
                        className={`p-4 rounded-xl border transition-all ${
                          isHigh
                            ? 'border-amber-300 bg-amber-50/40 dark:bg-amber-950/20 dark:border-amber-800 shadow-2xs'
                            : 'border-slate-100 dark:border-stone-800/80 bg-slate-50/50 dark:bg-stone-800/30'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <strong className="text-sm font-black text-slate-900 dark:text-white block">
                              {rest.name}
                            </strong>
                            <span className="text-xs font-mono text-slate-400">/{rest.slug}</span>
                          </div>
                          <PlanBadge plan={rest.subscriptionPlan} />
                        </div>

                        <div className="mt-3 space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-bold">
                            <span className="text-slate-600 dark:text-stone-300">
                              {rest.activeTablesCount} / {rest.maxTables} mesas
                            </span>
                            <span className={isHigh ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500'}>
                              {rest.usage}% ocupação
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-stone-700 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                isHigh ? 'bg-amber-500' : 'bg-emerald-500'
                              }`}
                              style={{ width: `${Math.min(100, rest.usage)}%` }}
                            />
                          </div>
                        </div>

                        <div className="mt-4 pt-3 border-t border-slate-200/60 dark:border-stone-800 flex items-center justify-between text-xs">
                          {isHigh ? (
                            <span className="text-[11px] font-bold text-amber-700 dark:text-amber-400">
                              Sugerir upgrade
                            </span>
                          ) : (
                            <span className="text-[11px] text-slate-400">
                              Operação folgada
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => openPlanModal(rest)}
                            className="px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 font-bold text-xs hover:opacity-90 transition-opacity cursor-pointer"
                          >
                            Alterar Plano
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          )}

          {/* ----------------------------------------------------------------
              ABA: CLIENTES / RESTAURANTES
             ---------------------------------------------------------------- */}
          {activeTab === 'restaurants' && (
            <div className="space-y-8">
              {/* 3.1 — Card "Cadastrar restaurante" */}
              <section className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs">
                <div>
                  <h2 className="text-lg font-black text-slate-900 dark:text-white tracking-tight">
                    Cadastrar restaurante
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-stone-400 mt-1">
                    Crie o estabelecimento para iniciar sua configuração e gerar o cardápio digital.
                  </p>
                </div>

                <form onSubmit={(e) => void handleSubmit(e)} className="mt-5">
                  <fieldset disabled={busy} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="restaurant-name" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                          Nome do restaurante
                        </label>
                        <input
                          id="restaurant-name"
                          required
                          maxLength={120}
                          value={name}
                          placeholder="Ex.: Churrascaria da Brusque"
                          onChange={(e) => {
                            const val = e.target.value;
                            requestId.current = null;
                            setName(val);
                            setError('');
                            setNotice('');
                            if (!slugEdited) setSlug(suggestSlug(val));
                          }}
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-semibold placeholder:text-slate-400 focus:outline-none focus:border-slate-400 shadow-2xs"
                        />
                      </div>

                      <div>
                        <label htmlFor="restaurant-slug" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                          Endereço do cardápio
                        </label>
                        <input
                          id="restaurant-slug"
                          required
                          minLength={3}
                          maxLength={80}
                          pattern="[a-z0-9]+(-[a-z0-9]+)*"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={slug}
                          placeholder="churrascaria-da-brusque"
                          onChange={(e) => {
                            requestId.current = null;
                            setSlugEdited(true);
                            setSlug(e.target.value.toLowerCase());
                            setError('');
                            setNotice('');
                          }}
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-semibold placeholder:text-slate-400 focus:outline-none focus:border-slate-400 shadow-2xs font-mono"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                      <p className="text-xs text-slate-500 dark:text-stone-400">
                        Endereço previsto: <strong className="font-mono text-slate-800 dark:text-stone-200">/{slug || 'nome-do-restaurante'}</strong>. Escolha um endereço permanente para usar nos QR Codes.
                      </p>

                      <button
                        type="submit"
                        className="px-5 py-2.5 rounded-xl bg-[#1e293b] hover:bg-[#0f172a] text-white text-xs font-bold transition-all shadow-xs shrink-0 cursor-pointer disabled:opacity-50"
                      >
                        {busy && !setupRestaurantId && !statusBusy && !archiveBusy
                          ? 'Cadastrando…'
                          : '+ Cadastrar restaurante'}
                      </button>
                    </div>
                  </fieldset>
                </form>
              </section>

              {/* 3.2 — Seção "Restaurantes" */}
              <section aria-labelledby="restaurants-title" className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 id="restaurants-title" className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                      Restaurantes
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-stone-400">
                      Estabelecimentos gerenciados e suas operações ativas.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Filtros Ativos / Arquivados */}
                    <div className="inline-flex p-1 rounded-xl bg-slate-200/60 dark:bg-stone-800 border border-slate-200 dark:border-stone-700 text-xs font-bold">
                      <button
                        type="button"
                        onClick={() => setRestaurantFilter('current')}
                        className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                          restaurantFilter === 'current'
                            ? 'bg-slate-900 text-white shadow-xs'
                            : 'text-slate-600 dark:text-stone-400 hover:text-slate-900'
                        }`}
                      >
                        Ativos [{activeCount}]
                      </button>
                      <button
                        type="button"
                        onClick={() => setRestaurantFilter('archived')}
                        className={`px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                          restaurantFilter === 'archived'
                            ? 'bg-slate-900 text-white shadow-xs'
                            : 'text-slate-600 dark:text-stone-400 hover:text-slate-900'
                        }`}
                      >
                        Arquivados [{archivedCount}]
                      </button>
                    </div>

                    {/* Filtros Rápidos por Plano */}
                    <div className="inline-flex p-1 rounded-xl bg-slate-100 dark:bg-stone-800/80 border border-slate-200 dark:border-stone-700 text-xs font-bold">
                      <button
                        type="button"
                        onClick={() => setPlanFilter('all')}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                          planFilter === 'all'
                            ? 'bg-slate-900 text-white dark:bg-stone-100 dark:text-stone-900 shadow-2xs'
                            : 'text-slate-600 dark:text-stone-400 hover:text-slate-900'
                        }`}
                      >
                        Todos
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlanFilter('basic')}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                          planFilter === 'basic'
                            ? 'bg-blue-600 text-white shadow-2xs'
                            : 'text-slate-600 dark:text-stone-400 hover:text-blue-600'
                        }`}
                      >
                        Básico
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlanFilter('pro')}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                          planFilter === 'pro'
                            ? 'bg-teal-600 text-white shadow-2xs'
                            : 'text-slate-600 dark:text-stone-400 hover:text-teal-600'
                        }`}
                      >
                        Pro
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlanFilter('premium')}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${
                          planFilter === 'premium'
                            ? 'bg-amber-600 text-white shadow-2xs'
                            : 'text-slate-600 dark:text-stone-400 hover:text-amber-600'
                        }`}
                      >
                        Premium
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setRefresh((c) => c + 1)}
                      disabled={loading || busy}
                      className="px-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-slate-50 dark:hover:bg-stone-700 text-xs font-bold text-slate-700 dark:text-stone-200 transition-colors shadow-2xs cursor-pointer flex items-center gap-1.5"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 4 23 10 17 10" />
                        <polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                      </svg>
                      <span>Atualizar</span>
                    </button>
                  </div>
                </div>

                {/* Listagem em Grid de 2 Colunas */}
                {loading ? (
                  <p role="status" className="py-8 text-xs font-semibold text-slate-500">
                    Carregando estabelecimentos…
                  </p>
                ) : listError ? (
                  <p role="alert" className="p-4 rounded-xl bg-red-50 text-xs text-red-700 font-bold">
                    {listError}
                  </p>
                ) : filteredRestaurants.length === 0 ? (
                  <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-8 text-center">
                    <p className="text-xs text-slate-500 dark:text-stone-400 font-medium">
                      {searchQuery
                        ? `Nenhum restaurante encontrado para "${searchQuery}".`
                        : restaurantFilter === 'archived'
                        ? 'Nenhum restaurante arquivado.'
                        : 'Nenhum restaurante cadastrado nesta visualização.'}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredRestaurants.map((restaurant) => {
                      return (
                        <div
                          key={restaurant.id}
                          className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs flex flex-col justify-between hover:border-slate-300 transition-all"
                        >
                          <div>
                            {/* Topo do card: Nome + Badges + Botão Excluir */}
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <h3 className="text-base font-black text-slate-900 dark:text-white tracking-tight uppercase">
                                  {restaurant.name}
                                </h3>
                                <span className="text-xs font-mono text-slate-500 dark:text-stone-400 block mt-0.5">
                                  /{restaurant.slug}
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5">
                                {/* Badge de Status */}
                                {restaurant.active ? (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800">
                                    Ativo
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800">
                                    Suspenso
                                  </span>
                                )}

                                {/* Badge Real do Plano SaaS */}
                                <PlanBadge
                                  plan={restaurant.subscriptionPlan}
                                  onClick={() => openPlanModal(restaurant)}
                                />

                                {/* Botão Exclusão Definitiva */}
                                <Link
                                  to={`/plataforma/restaurantes/${restaurant.id}/excluir`}
                                  title={`Excluir definitivamente ${restaurant.name}`}
                                  aria-label={`Excluir ${restaurant.name}`}
                                  className="w-7 h-7 rounded-lg text-slate-400 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 flex items-center justify-center transition-colors cursor-pointer"
                                >
                                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                </Link>
                              </div>
                            </div>

                            {/* Informações operacionais e Ocupação Real de Mesas */}
                            <div className="mt-3.5 space-y-3 text-xs text-slate-600 dark:text-stone-400">
                              <div>
                                <div className="flex items-center justify-between mb-1">
                                  <span className="font-bold text-slate-800 dark:text-stone-200">
                                    {restaurant.activeTablesCount} / {restaurant.maxTables} mesas configuradas
                                  </span>
                                  {restaurant.activeTablesCount >= restaurant.maxTables && (
                                    <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-300">
                                      Limite Atingido
                                    </span>
                                  )}
                                </div>
                                <div className="w-full h-1.5 rounded-full bg-slate-100 dark:bg-stone-800 overflow-hidden">
                                  <div
                                    className={`h-full rounded-full transition-all ${
                                      restaurant.activeTablesCount >= restaurant.maxTables
                                        ? 'bg-amber-500'
                                        : 'bg-emerald-500'
                                    }`}
                                    style={{
                                      width: `${Math.min(100, Math.round((restaurant.activeTablesCount / restaurant.maxTables) * 100))}%`,
                                    }}
                                  />
                                </div>
                              </div>

                              {/* Barra de Vigência e Dias Restantes da Assinatura */}
                              {(() => {
                                const isExpired = restaurant.daysRemaining <= 0;
                                const isWarning = restaurant.daysRemaining > 0 && restaurant.daysRemaining <= 7;
                                const cycleRatio = Math.max(0, Math.min(100, Math.round((restaurant.daysRemaining / (restaurant.billingCycleDays || 30)) * 100)));

                                return (
                                  <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-stone-800/60 border border-slate-100 dark:border-stone-800 space-y-1.5">
                                    <div className="flex items-center justify-between text-[11px]">
                                      <span className="text-slate-500 dark:text-stone-400 font-medium">
                                        Vigência do Plano:
                                      </span>
                                      <span
                                        className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                          isExpired
                                            ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border border-rose-300'
                                            : isWarning
                                            ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-300'
                                            : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-300'
                                        }`}
                                      >
                                        {isExpired
                                          ? 'Vencida'
                                          : `${restaurant.daysRemaining} dia${restaurant.daysRemaining !== 1 ? 's' : ''} restante${restaurant.daysRemaining !== 1 ? 's' : ''}`}
                                      </span>
                                    </div>

                                    <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-stone-700 overflow-hidden">
                                      <div
                                        className={`h-full rounded-full transition-all ${
                                          isExpired
                                            ? 'bg-rose-500'
                                            : isWarning
                                            ? 'bg-amber-500'
                                            : 'bg-emerald-500'
                                        }`}
                                        style={{ width: `${cycleRatio}%` }}
                                      />
                                    </div>

                                    <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-stone-400 pt-0.5">
                                      <span>
                                        {isExpired ? 'Venceu em: ' : 'Renova em: '}
                                        <strong className="text-slate-700 dark:text-stone-300 font-mono">
                                          {formatDate(restaurant.subscriptionExpiresAt)}
                                        </strong>
                                      </span>
                                      <span className="font-mono">
                                        Ciclo: {restaurant.billingCycleDays || 30}d
                                      </span>
                                    </div>
                                  </div>
                                );
                              })()}

                              <div className="flex items-center justify-between text-[11px] pt-0.5">
                                <p className="flex items-center gap-1.5">
                                  <span className={`h-1.5 w-1.5 rounded-full ${restaurant.active ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                                  <span>{restaurant.active ? 'Operação regular' : 'Serviço temporariamente suspenso'}</span>
                                </p>
                                <span className="font-mono font-semibold text-slate-700 dark:text-stone-300">
                                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(restaurant.monthlyPriceCents / 100)}/mês
                                </span>
                              </div>

                              <p className="text-[11px] text-slate-500 dark:text-stone-400">
                                {restaurant.adminCount === 0
                                  ? 'Administrador ainda não vinculado'
                                  : `${restaurant.adminCount} administrador(es) ativo(s)`}
                              </p>
                            </div>
                          </div>

                          {/* Rodapé de Ações em 1 única linha com menu ⋯ */}
                          <div className="mt-5 pt-3.5 border-t border-slate-100 dark:border-stone-800 flex items-center justify-between gap-1.5">
                            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                              {restaurant.active && (
                                <button
                                  type="button"
                                  onClick={() => void configureRestaurant(restaurant)}
                                  disabled={busy}
                                  className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-all shadow-xs cursor-pointer disabled:opacity-50 shrink-0 inline-flex items-center gap-1.5"
                                  title="Abrir painel administrativo em nova aba"
                                >
                                  <span>
                                    {setupRestaurantId === restaurant.id
                                      ? 'Abrindo…'
                                      : restaurant.adminCount === 0
                                      ? 'Configurar'
                                      : 'Administrar'}
                                  </span>
                                  <svg className="w-3.5 h-3.5 opacity-75" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                    <polyline points="15 3 21 3 21 9" />
                                    <line x1="10" y1="14" x2="21" y2="3" />
                                  </svg>
                                </button>
                              )}

                              <Link
                                to={`/${restaurant.slug}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-300 transition-colors cursor-pointer inline-flex items-center gap-1 shrink-0"
                              >
                                <span>Ver cardápio</span>
                                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                                  <polyline points="15 3 21 3 21 9" />
                                  <line x1="10" y1="14" x2="21" y2="3" />
                                </svg>
                              </Link>

                              <Link
                                to={`/plataforma/restaurantes/${restaurant.id}/backups`}
                                className="px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-300 transition-colors cursor-pointer shrink-0"
                              >
                                Backups
                              </Link>

                              {!restaurant.archivedAt && (
                                <button
                                  type="button"
                                  onClick={() => openStatusChange(restaurant)}
                                  disabled={busy}
                                  className="px-2.5 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-300 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                                >
                                  {restaurant.active ? 'Suspender' : 'Reativar'}
                                </button>
                              )}
                            </div>

                            {/* Botão de menu ⋯ com dropdown */}
                            <div className="relative shrink-0">
                              <button
                                type="button"
                                onClick={() => setOpenMenuRestaurantId(openMenuRestaurantId === restaurant.id ? null : restaurant.id)}
                                className="h-8 w-8 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-slate-700 dark:text-stone-300 flex items-center justify-center font-bold text-sm cursor-pointer transition-colors"
                                title="Mais opções do restaurante"
                                aria-label="Mais opções"
                              >
                                ⋯
                              </button>

                              {openMenuRestaurantId === restaurant.id && (
                                <>
                                  <div
                                    className="fixed inset-0 z-30"
                                    onClick={() => setOpenMenuRestaurantId(null)}
                                    aria-hidden="true"
                                  />
                                  <div className="absolute right-0 bottom-full mb-1.5 z-40 w-48 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-xl py-1 text-xs">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenMenuRestaurantId(null);
                                        openPlanModal(restaurant);
                                      }}
                                      className="w-full px-3 py-2 text-left font-bold text-slate-700 dark:text-stone-200 hover:bg-slate-100 dark:hover:bg-stone-800 flex items-center gap-2 cursor-pointer"
                                    >
                                      <svg className="w-3.5 h-3.5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                        <rect x="1" y="4" width="22" height="16" rx="2" />
                                        <line x1="1" y1="10" x2="23" y2="10" />
                                      </svg>
                                      <span>Alterar Plano SaaS</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenMenuRestaurantId(null);
                                        void handleQuickRenew(restaurant);
                                      }}
                                      className="w-full px-3 py-2 text-left font-bold text-slate-700 dark:text-stone-200 hover:bg-slate-100 dark:hover:bg-stone-800 flex items-center gap-2 cursor-pointer"
                                    >
                                      <svg className="w-3.5 h-3.5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                        <polyline points="23 4 23 10 17 10" />
                                        <polyline points="1 20 1 14 7 14" />
                                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                      </svg>
                                      <span>Renovar Assinatura (+30d)</span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenMenuRestaurantId(null);
                                        openArchiveChange(restaurant);
                                      }}
                                      className="w-full px-3 py-2 text-left font-bold text-slate-700 dark:text-stone-200 hover:bg-slate-100 dark:hover:bg-stone-800 flex items-center gap-2 cursor-pointer"
                                    >
                                      <svg className="w-3.5 h-3.5 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                        <polyline points="21 8 21 21 3 21 3 8" />
                                        <rect x="1" y="3" width="22" height="5" />
                                        <line x1="10" y1="12" x2="14" y2="12" />
                                      </svg>
                                      <span>{restaurant.archivedAt ? 'Restaurar' : 'Arquivar'}</span>
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* 3.3 — Seção "Exclusões e backups preservados" */}
              <section aria-labelledby="deletions-title" className="space-y-4 pt-4 border-t border-slate-200 dark:border-stone-800">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 id="deletions-title" className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                      Exclusões e backups preservados
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-stone-400">
                      Snapshots de segurança guardados de estabelecimentos encerrados.
                    </p>
                  </div>
                  <span className="text-xs font-extrabold px-2.5 py-1 rounded-full bg-slate-100 dark:bg-stone-800 text-slate-600 dark:text-stone-300 border border-slate-200 dark:border-stone-700">
                    {filteredDeletions.length} registro(s)
                  </span>
                </div>

                {filteredDeletions.length === 0 ? (
                  <p className="text-xs text-slate-500 dark:text-stone-400 italic">
                    Nenhuma solicitação de exclusão encontrada.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {filteredDeletions.map((job) => (
                      <div
                        key={job.id}
                        className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-4 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <strong className="text-sm font-bold text-slate-900 dark:text-white block">
                            {job.source_name}
                          </strong>
                          <p className="text-xs text-slate-500 dark:text-stone-400">
                            {deletionLabel(job.status)} · {new Date(job.requested_at).toLocaleString('pt-BR')}
                          </p>
                        </div>

                        <div className="flex items-center gap-3">
                          <span className="px-2.5 py-1 rounded-full text-xs font-extrabold bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800 shrink-0">
                            ✓ Backup Disponível
                          </span>

                          <div className="flex items-center gap-2">
                            <Link
                              to={`/plataforma/restaurantes/${job.source_restaurant_id}/backups`}
                              className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-300 transition-colors"
                            >
                              Backups e recuperação
                            </Link>
                            {!['completed', 'cancelled'].includes(job.status) && (
                              <Link
                                to={`/plataforma/restaurantes/${job.source_restaurant_id}/excluir`}
                                className="px-3 py-1.5 rounded-xl bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-colors"
                              >
                                Retomar operação
                              </Link>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ----------------------------------------------------------------
              ABA: PLANOS & ASSINATURAS (GESTÃO SAAS)
             ---------------------------------------------------------------- */}
          {activeTab === 'plans' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                    Catálogo de Planos SaaS
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-stone-400">
                    Defina os preços padrão e limites de mesas para novos cadastros e sincronização de assinaturas.
                  </p>
                </div>
              </div>

              {/* Avisos do Catálogo */}
              {catalogError && (
                <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs font-semibold text-red-700 shadow-2xs">
                  {catalogError}
                </div>
              )}
              {catalogNotice && (
                <div role="status" className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800 shadow-2xs">
                  {catalogNotice}
                </div>
              )}

              {/* Formulário do Catálogo de Planos */}
              <form onSubmit={handleSaveCatalog} className="space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Plano Básico */}
                  <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-extrabold text-blue-600 uppercase tracking-wider">
                          Plano Essencial
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">
                          Padrão
                        </span>
                      </div>
                      <h3 className="text-xl font-black text-slate-900 dark:text-white mt-1">
                        Básico
                      </h3>

                      <div className="mt-4 space-y-3">
                        <div>
                          <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                            Mensalidade (R$)
                          </label>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-xs font-mono font-bold text-slate-400">R$</span>
                            <input
                              type="text"
                              value={catalogBasicPrice}
                              onChange={(e) => setCatalogBasicPrice(e.target.value)}
                              placeholder="99,00"
                              disabled={catalogBusy}
                              className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-mono font-bold focus:outline-none focus:border-blue-500 shadow-2xs"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                            Limite de Mesas
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="500"
                            value={catalogBasicMaxTables}
                            onChange={(e) => setCatalogBasicMaxTables(e.target.value ? Number(e.target.value) : '')}
                            disabled={catalogBusy}
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-bold focus:outline-none focus:border-blue-500 shadow-2xs"
                          />
                        </div>
                      </div>

                      <ul className="mt-5 space-y-2 text-xs text-slate-600 dark:text-stone-400 border-t border-slate-100 dark:border-stone-800 pt-3">
                        <li className="flex items-center gap-2">✓ Cardápio digital QR Code</li>
                        <li className="flex items-center gap-2">✓ Painel do Garçom e comandas</li>
                        <li className="flex items-center gap-2">✓ Pedido de conta e chamados</li>
                      </ul>
                    </div>
                  </div>

                  {/* Plano Pro */}
                  <div className="rounded-2xl border border-teal-300 dark:border-teal-800 bg-white dark:bg-stone-900 p-5 shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-extrabold text-teal-600 uppercase tracking-wider">
                          Intermediário
                        </span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                          Recomendado
                        </span>
                      </div>
                      <h3 className="text-xl font-black text-slate-900 dark:text-white mt-1">
                        Pro
                      </h3>

                      <div className="mt-4 space-y-3">
                        <div>
                          <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                            Mensalidade (R$)
                          </label>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-xs font-mono font-bold text-slate-400">R$</span>
                            <input
                              type="text"
                              value={catalogProPrice}
                              onChange={(e) => setCatalogProPrice(e.target.value)}
                              placeholder="149,00"
                              disabled={catalogBusy}
                              className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-mono font-bold focus:outline-none focus:border-teal-500 shadow-2xs"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                            Limite de Mesas
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="500"
                            value={catalogProMaxTables}
                            onChange={(e) => setCatalogProMaxTables(e.target.value ? Number(e.target.value) : '')}
                            disabled={catalogBusy}
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-bold focus:outline-none focus:border-teal-500 shadow-2xs"
                          />
                        </div>
                      </div>

                      <ul className="mt-5 space-y-2 text-xs text-slate-600 dark:text-stone-400 border-t border-slate-100 dark:border-stone-800 pt-3">
                        <li className="flex items-center gap-2">✓ Todos os recursos do Básico</li>
                        <li className="flex items-center gap-2 font-bold text-teal-700 dark:text-teal-400">✓ KDS Cozinha e Bar completo</li>
                        <li className="flex items-center gap-2">✓ Agrupamento de itens na comanda</li>
                      </ul>
                    </div>
                  </div>

                  {/* Plano Premium */}
                  <div className="rounded-2xl border-2 border-amber-400 bg-white dark:bg-stone-900 p-5 shadow-sm flex flex-col justify-between relative overflow-hidden">
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-extrabold text-amber-600 uppercase tracking-wider">
                          Plano Completo
                        </span>
                        <span className="text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                          Popular
                        </span>
                      </div>
                      <h3 className="text-xl font-black text-slate-900 dark:text-white mt-1">
                        Premium
                      </h3>

                      <div className="mt-4 space-y-3">
                        <div>
                          <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                            Mensalidade (R$)
                          </label>
                          <div className="relative">
                            <span className="absolute left-3 top-2.5 text-xs font-mono font-bold text-slate-400">R$</span>
                            <input
                              type="text"
                              value={catalogPremiumPrice}
                              onChange={(e) => setCatalogPremiumPrice(e.target.value)}
                              placeholder="199,00"
                              disabled={catalogBusy}
                              className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-mono font-bold focus:outline-none focus:border-amber-500 shadow-2xs"
                            />
                          </div>
                        </div>

                        <div>
                          <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                            Limite de Mesas
                          </label>
                          <input
                            type="number"
                            min="1"
                            max="500"
                            value={catalogPremiumMaxTables}
                            onChange={(e) => setCatalogPremiumMaxTables(e.target.value ? Number(e.target.value) : '')}
                            disabled={catalogBusy}
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-[#fffdfa] dark:bg-stone-800 text-slate-900 dark:text-stone-100 text-sm font-bold focus:outline-none focus:border-amber-500 shadow-2xs"
                          />
                        </div>
                      </div>

                      <ul className="mt-5 space-y-2 text-xs text-slate-600 dark:text-stone-400 border-t border-amber-100 dark:border-stone-800 pt-3">
                        <li className="flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-400">✓ Todos os recursos do Pro</li>
                        <li className="flex items-center gap-2">✓ Auditoria financeira completa</li>
                        <li className="flex items-center gap-2">✓ Backups pontuais e alta capacidade</li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* Ações de salvamento e sincronização */}
                <div className="p-4 rounded-2xl bg-slate-50 dark:bg-stone-800/60 border border-slate-200 dark:border-stone-700 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-stone-300 font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={catalogSyncExisting}
                      onChange={(e) => setCatalogSyncExisting(e.target.checked)}
                      disabled={catalogBusy}
                      className="rounded border-slate-300 text-slate-900 focus:ring-slate-500 w-4 h-4 cursor-pointer"
                    />
                    <span>Atualizar também os restaurantes ativos com os novos preços e limites padrão</span>
                  </label>

                  <button
                    type="submit"
                    disabled={catalogBusy}
                    className="px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-all shadow-xs cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {catalogBusy ? 'Salvando Catálogo…' : 'Salvar Catálogo de Planos'}
                  </button>
                </div>
              </form>

              {/* Tabela de Estabelecimentos e Planos */}
              <section className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-base font-bold text-slate-900 dark:text-white">
                    Distribuição de Planos por Estabelecimento
                  </h3>
                  <span className="text-xs font-mono font-bold text-slate-500">
                    Total MRR: {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(realMrr)}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-stone-800">
                  {restaurants.map((rest) => (
                    <div key={rest.id} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div>
                        <strong className="text-slate-900 dark:text-white font-bold text-sm">{rest.name}</strong>
                        <span className="text-slate-400 ml-2 font-mono">/{rest.slug}</span>
                        <div className="text-[11px] text-slate-500 dark:text-stone-400 mt-0.5">
                          {rest.activeTablesCount} / {rest.maxTables} mesas configuradas
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-bold text-slate-900 dark:text-white">
                          {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(rest.monthlyPriceCents / 100)}/mês
                        </span>
                        <PlanBadge
                          plan={rest.subscriptionPlan}
                          onClick={() => openPlanModal(rest)}
                        />
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          rest.active
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                        }`}>
                          {rest.active ? 'Ativo' : 'Suspenso'}
                        </span>
                        <button
                          type="button"
                          onClick={() => openPlanModal(rest)}
                          className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-stone-700 hover:bg-slate-50 dark:hover:bg-stone-800 text-xs font-bold text-slate-700 dark:text-stone-300 transition-colors cursor-pointer"
                        >
                          Alterar
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* ----------------------------------------------------------------
              ABA: SEGURANÇA & BACKUPS
             ---------------------------------------------------------------- */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                  Segurança, Backups & Auditoria
                </h2>
                <p className="text-xs text-slate-500 dark:text-stone-400">
                  Integridade de dados, retenção de cópias e auditoria do PostgreSQL.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <span className="text-xs text-slate-500">Proteção RLS</span>
                  <strong className="block text-xl font-black text-emerald-700 mt-1">100% Ativa</strong>
                  <p className="text-[11px] text-slate-400 mt-1">Isolamento multi-tenant estrito</p>
                </div>
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <span className="text-xs text-slate-500">Backups de Exclusão</span>
                  <strong className="block text-xl font-black text-blue-700 mt-1">{deletionsCount} Cópias</strong>
                  <p className="text-[11px] text-slate-400 mt-1">Preservação integral com manifestos</p>
                </div>
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs">
                  <span className="text-xs text-slate-500">Criptografia em Repouso</span>
                  <strong className="block text-xl font-black text-purple-700 mt-1">AES-256</strong>
                  <p className="text-[11px] text-slate-400 mt-1">Storage seguro Supabase</p>
                </div>
              </div>

              <section className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs">
                <h3 className="text-base font-bold text-slate-900 dark:text-white mb-2">
                  Atalhos Rápidos de Recuperação por Restaurante
                </h3>
                <p className="text-xs text-slate-500 mb-4">
                  Acesse os pontos de restauração de cada estabelecimento:
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {restaurants.map((rest) => (
                    <Link
                      key={rest.id}
                      to={`/plataforma/restaurantes/${rest.id}/backups`}
                      className="p-3 rounded-xl border border-slate-200 dark:border-stone-700 hover:border-slate-400 text-xs font-bold text-slate-800 dark:text-stone-200 hover:bg-slate-50 dark:hover:bg-stone-800 transition-all flex items-center justify-between"
                    >
                      <span className="truncate">{rest.name}</span>
                      <span className="text-slate-400">→</span>
                    </Link>
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* ----------------------------------------------------------------
              ABA: HISTÓRICO DE EXCLUSÕES
             ---------------------------------------------------------------- */}
          {activeTab === 'deletions' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                  Histórico de Exclusões e Recuperação
                </h2>
                <p className="text-xs text-slate-500 dark:text-stone-400">
                  Estabelecimentos que passaram pelo pipeline seguro de exclusão com backup preservado.
                </p>
              </div>

              {filteredDeletions.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-8 text-center text-xs text-slate-500">
                  Nenhuma exclusão registrada na plataforma.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredDeletions.map((job) => (
                    <div
                      key={job.id}
                      className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                    >
                      <div>
                        <strong className="text-base font-bold text-slate-900 dark:text-white block">
                          {job.source_name}
                        </strong>
                        <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                          Slug original: /{job.source_slug} · {deletionLabel(job.status)} · {new Date(job.requested_at).toLocaleString('pt-BR')}
                        </p>
                        {job.reason && (
                          <p className="text-xs text-slate-600 dark:text-stone-400 italic mt-1">
                            Motivo: "{job.reason}"
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="px-3 py-1 rounded-full text-xs font-extrabold bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800">
                          ✓ Backup Disponível
                        </span>
                        <Link
                          to={`/plataforma/restaurantes/${job.source_restaurant_id}/backups`}
                          className="px-3.5 py-2 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-xs font-bold text-slate-800 dark:text-stone-200 hover:bg-slate-50 transition-colors"
                        >
                          Backups e recuperação
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ----------------------------------------------------------------
              ABA: CONFIGURAÇÕES DA PLATAFORMA
             ---------------------------------------------------------------- */}
          {activeTab === 'settings' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                  Configurações da Plataforma Elozi
                </h2>
                <p className="text-xs text-slate-500 dark:text-stone-400">
                  Identidade visual, perfil do Super Administrador e parâmetros globais.
                </p>
              </div>

              {brandingNotice && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800 p-3.5 text-xs font-bold text-emerald-800 dark:text-emerald-300">
                  {brandingNotice}
                </div>
              )}

              {brandingError && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800 p-3.5 text-xs font-bold text-rose-800 dark:text-rose-300">
                  {brandingError}
                </div>
              )}

              {/* Grid de Identidade Visual e Perfil */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Card 1: Logo & Nome da Plataforma */}
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs space-y-5">
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      Identidade Visual da Plataforma
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                      Personalize o logotipo e nome exibidos na barra lateral e cabeçalho global.
                    </p>
                  </div>

                  <div className="flex items-center gap-4">
                    {branding.platformLogoUrl ? (
                      <img
                        src={branding.platformLogoUrl}
                        alt="Logotipo Elozi"
                        className="w-16 h-16 rounded-2xl object-contain border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 p-1 shadow-xs shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center text-white font-black text-2xl shadow-sm tracking-tighter shrink-0">
                        E
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => logoInputRef.current?.click()}
                          disabled={brandingBusy}
                          className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-slate-50 dark:hover:bg-stone-700 text-xs font-bold text-slate-700 dark:text-stone-200 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          Carregar novo logo
                        </button>
                        {branding.platformLogoUrl && (
                          <button
                            type="button"
                            onClick={handleRestoreDefaultLogo}
                            disabled={brandingBusy}
                            className="px-3 py-1.5 rounded-xl border border-transparent text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50"
                          >
                            Restaurar padrão
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">
                        PNG, SVG ou WebP (redimensionado e otimizado automaticamente).
                      </p>
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleLogoUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-stone-800">
                    <div>
                      <label htmlFor="platform-name-input" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                        Nome da Plataforma
                      </label>
                      <input
                        id="platform-name-input"
                        type="text"
                        value={tempPlatformName}
                        onChange={(e) => setTempPlatformName(e.target.value)}
                        placeholder="Elozi"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div>
                      <label htmlFor="platform-subtitle-input" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                        Subtítulo / Rótulo
                      </label>
                      <input
                        id="platform-subtitle-input"
                        type="text"
                        value={tempPlatformSubtitle}
                        onChange={(e) => setTempPlatformSubtitle(e.target.value)}
                        placeholder="Admin Global"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Card 2: Perfil do Super Administrador */}
                <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs space-y-5">
                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white">
                      Perfil do Super Administrador
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                      Foto de perfil e nome de exibição no rodapé da barra lateral.
                    </p>
                  </div>

                  <div className="flex items-center gap-4">
                    {branding.superadminAvatarUrl ? (
                      <img
                        src={branding.superadminAvatarUrl}
                        alt="Avatar SuperAdmin"
                        className="w-16 h-16 rounded-full object-cover border-2 border-emerald-500 shadow-xs shrink-0"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-slate-800 dark:bg-stone-700 border-2 border-slate-600 flex items-center justify-center text-white font-bold text-xl shrink-0">
                        {tempSuperadminName ? tempSuperadminName.charAt(0).toUpperCase() : 'S'}
                      </div>
                    )}

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => avatarInputRef.current?.click()}
                          disabled={brandingBusy}
                          className="px-3 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 hover:bg-slate-50 dark:hover:bg-stone-700 text-xs font-bold text-slate-700 dark:text-stone-200 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          Carregar foto
                        </button>
                        {branding.superadminAvatarUrl && (
                          <button
                            type="button"
                            onClick={handleRemoveAvatar}
                            disabled={brandingBusy}
                            className="px-3 py-1.5 rounded-xl border border-transparent text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50"
                          >
                            Remover foto
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400">
                        Foto individual (quadrada recomendada, compactada automaticamente).
                      </p>
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleAvatarUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-stone-800">
                    <div>
                      <label htmlFor="superadmin-name-input" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                        Nome de Exibição
                      </label>
                      <input
                        id="superadmin-name-input"
                        type="text"
                        value={tempSuperadminName}
                        onChange={(e) => setTempSuperadminName(e.target.value)}
                        placeholder="Super Administrador"
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div>
                      <label htmlFor="superadmin-role-input" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                        Cargo / Nível de Acesso
                      </label>
                      <input
                        id="superadmin-role-input"
                        type="text"
                        disabled
                        value={`Super Administrador Global (${adminEmail || 'superadmin@elozi.com'})`}
                        className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-800 bg-slate-100 dark:bg-stone-800/50 text-xs text-slate-500 dark:text-stone-400 cursor-not-allowed"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Botão Salvar Alterações de Texto */}
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={handleSaveBrandingSettings}
                  disabled={brandingBusy}
                  className="px-6 py-2.5 rounded-xl bg-slate-900 dark:bg-emerald-600 hover:bg-slate-800 dark:hover:bg-emerald-500 text-white font-bold text-xs cursor-pointer disabled:opacity-50 transition-colors shadow-xs"
                >
                  {brandingBusy ? 'Salvando...' : 'Salvar Informações da Plataforma'}
                </button>
              </div>

              {/* Parâmetros de Infraestrutura */}
              <div className="rounded-2xl border border-slate-200 dark:border-stone-800 bg-white dark:bg-stone-900 p-6 shadow-xs space-y-4">
                <h3 className="text-base font-bold text-slate-900 dark:text-white mb-2">
                  Parâmetros de Infraestrutura
                </h3>
                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-stone-800">
                  <div>
                    <strong className="text-sm font-bold text-slate-900 dark:text-white block">Versão da Plataforma</strong>
                    <span className="text-xs text-slate-500">Core Engine SaaS</span>
                  </div>
                  <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-stone-800 text-slate-800 dark:text-stone-200">
                    v2.5.0-production
                  </span>
                </div>

                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-stone-800">
                  <div>
                    <strong className="text-sm font-bold text-slate-900 dark:text-white block">Motor de Banco de Dados</strong>
                    <span className="text-xs text-slate-500">PostgreSQL com isolamento multi-tenant</span>
                  </div>
                  <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                    Conectado / Saudável
                  </span>
                </div>

                <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-stone-800">
                  <div>
                    <strong className="text-sm font-bold text-slate-900 dark:text-white block">Servidor Supabase Realtime</strong>
                    <span className="text-xs text-slate-500">Sincronismo de KDS e Chamados</span>
                  </div>
                  <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                    Operacional
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <strong className="text-sm font-bold text-slate-900 dark:text-white block">Ambiente de Execução</strong>
                    <span className="text-xs text-slate-500">Vite + React SPA</span>
                  </div>
                  <span className="text-xs font-mono text-slate-600 dark:text-stone-300">
                    NODE_ENV = production
                  </span>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* --------------------------------------------------------------------
          MODAL CENTRADO: ALTERAR PLANO SAAS (VÍNCULO ESTRITO POR RESTAURANT.ID)
         -------------------------------------------------------------------- */}
      {planTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="plan-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => {
            if (!planBusy) {
              setPlanTarget(null);
              setPlanError('');
            }
          }}
        >
          <div
            className="w-full max-w-lg bg-white dark:bg-stone-900 border border-slate-200 dark:border-stone-800 rounded-3xl p-6 shadow-2xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 id="plan-modal-title" className="text-lg font-black text-slate-900 dark:text-white">
                  Alterar Plano SaaS
                </h3>
                <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                  Restaurante: <strong className="text-slate-900 dark:text-white">{planTarget.name}</strong> ({planTarget.slug})
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!planBusy) {
                    setPlanTarget(null);
                    setPlanError('');
                  }
                }}
                disabled={planBusy}
                className="p-1 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                aria-label="Fechar"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {planError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800 p-3 text-xs font-bold text-rose-800 dark:text-rose-300">
                {planError}
              </div>
            )}

            <form onSubmit={handlePlanSave} className="space-y-4">
              <div className="space-y-2.5">
                {/* Básico */}
                <label
                  onClick={() => handleSelectTier('basic')}
                  className={`flex items-start justify-between p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    selectedPlan === 'basic'
                      ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/30 dark:border-blue-700 shadow-xs ring-1 ring-blue-500'
                      : 'border-slate-200 dark:border-stone-800 hover:border-slate-300 dark:hover:border-stone-700 bg-white dark:bg-stone-900'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="plan"
                      value="basic"
                      checked={selectedPlan === 'basic'}
                      onChange={() => handleSelectTier('basic')}
                      className="mt-1 h-4 w-4 text-blue-600 focus:ring-blue-500 border-slate-300 cursor-pointer"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-sm text-slate-900 dark:text-white">Básico</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                          Padrão: {branding.basicMaxTables} mesas
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                        Cardápio digital, garçom e chamados.
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-black text-slate-900 dark:text-white font-mono">
                      {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(branding.basicPriceCents / 100)}
                    </span>
                    <span className="text-[11px] text-slate-400 block">/mês</span>
                  </div>
                </label>

                {/* Pro */}
                <label
                  onClick={() => handleSelectTier('pro')}
                  className={`flex items-start justify-between p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    selectedPlan === 'pro'
                      ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-950/30 dark:border-teal-700 shadow-xs ring-1 ring-teal-500'
                      : 'border-slate-200 dark:border-stone-800 hover:border-slate-300 dark:hover:border-stone-700 bg-white dark:bg-stone-900'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="plan"
                      value="pro"
                      checked={selectedPlan === 'pro'}
                      onChange={() => handleSelectTier('pro')}
                      className="mt-1 h-4 w-4 text-teal-600 focus:ring-teal-500 border-slate-300 cursor-pointer"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-sm text-slate-900 dark:text-white">Pro</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-100 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300">
                          Padrão: {branding.proMaxTables} mesas
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                        KDS Cozinha e Bar completo + agrupamento inteligente.
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-black text-slate-900 dark:text-white font-mono">
                      {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(branding.proPriceCents / 100)}
                    </span>
                    <span className="text-[11px] text-slate-400 block">/mês</span>
                  </div>
                </label>

                {/* Premium */}
                <label
                  onClick={() => handleSelectTier('premium')}
                  className={`flex items-start justify-between p-3.5 rounded-2xl border cursor-pointer transition-all ${
                    selectedPlan === 'premium'
                      ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/30 dark:border-amber-700 shadow-xs ring-1 ring-amber-500'
                      : 'border-slate-200 dark:border-stone-800 hover:border-slate-300 dark:hover:border-stone-700 bg-white dark:bg-stone-900'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="plan"
                      value="premium"
                      checked={selectedPlan === 'premium'}
                      onChange={() => handleSelectTier('premium')}
                      className="mt-1 h-4 w-4 text-amber-600 focus:ring-amber-500 border-slate-300 cursor-pointer"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-extrabold text-sm text-slate-900 dark:text-white">Premium</span>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                          Padrão: {branding.premiumMaxTables} mesas
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                        Auditoria financeira + backups prioritários e alta capacidade.
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-sm font-black text-slate-900 dark:text-white font-mono">
                      {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(branding.premiumPriceCents / 100)}
                    </span>
                    <span className="text-[11px] text-slate-400 block">/mês</span>
                  </div>
                </label>
              </div>

              {/* Ajustes Livres de Preço, Mesas e Ciclo para este Restaurante */}
              <div className="p-4 rounded-2xl bg-slate-50 dark:bg-stone-800/60 border border-slate-200 dark:border-stone-700 space-y-3">
                <h4 className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-wider">
                  Condições Customizadas do Estabelecimento
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                      Valor Mensal (R$)
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-xs font-mono font-bold text-slate-400">R$</span>
                      <input
                        type="text"
                        value={planCustomPrice}
                        onChange={(e) => setPlanCustomPrice(e.target.value)}
                        placeholder="149,00"
                        disabled={planBusy}
                        required
                        className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-slate-900 dark:text-white text-xs font-mono font-bold focus:outline-none focus:border-slate-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                      Limite de Mesas
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="500"
                      value={planCustomMaxTables}
                      onChange={(e) => setPlanCustomMaxTables(e.target.value ? Number(e.target.value) : '')}
                      disabled={planBusy}
                      required
                      className="w-full px-3 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-slate-900 dark:text-white text-xs font-bold focus:outline-none focus:border-slate-400"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                      Ciclo (Dias)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={planBillingCycleDays}
                      onChange={(e) => setPlanBillingCycleDays(e.target.value ? Number(e.target.value) : '')}
                      disabled={planBusy}
                      required
                      className="w-full px-3 py-1.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-white dark:bg-stone-800 text-slate-900 dark:text-white text-xs font-bold focus:outline-none focus:border-slate-400"
                    />
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-200/60 dark:border-stone-700">
                  <label className="flex items-center gap-2 text-xs font-bold text-slate-800 dark:text-stone-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={planRenewCycle}
                      onChange={(e) => setPlanRenewCycle(e.target.checked)}
                      disabled={planBusy}
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-4 h-4 cursor-pointer"
                    />
                    <span>Reiniciar ciclo a partir de hoje (Renovar assinatura)</span>
                  </label>
                </div>
              </div>

              <div className="text-[11px] text-slate-500 dark:text-stone-400 bg-slate-50 dark:bg-stone-800/50 p-3 rounded-xl border border-slate-100 dark:border-stone-800 space-y-1">
                <div>
                  Mesas atuais configuradas: <strong className="text-slate-800 dark:text-stone-200">{planTarget.activeTablesCount}</strong>.
                  Se a quantidade ultrapassar o novo limite ({planCustomMaxTables || 0}), novas adições de mesas serão bloqueadas pelo sistema.
                </div>
                <div>
                  Vigência atual: <strong className="text-slate-700 dark:text-stone-300 font-mono">{formatDate(planTarget.subscriptionExpiresAt)}</strong> ({planTarget.daysRemaining} dias restantes).
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!planBusy) {
                      setPlanTarget(null);
                      setPlanError('');
                    }
                  }}
                  disabled={planBusy}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={planBusy}
                  className="px-5 py-2 rounded-xl bg-slate-900 dark:bg-emerald-600 text-white text-xs font-bold hover:bg-slate-800 dark:hover:bg-emerald-500 disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-2"
                >
                  {planBusy ? 'Salvando...' : 'Salvar Plano e Condições'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------
          MODAL CENTRADO: SUSPENDER / REATIVAR RESTAURANTE
         -------------------------------------------------------------------- */}
      {statusTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="status-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => {
            if (!statusBusy) {
              setStatusTarget(null);
              setStatusReason('');
              setStatusError('');
            }
          }}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-stone-900 border border-slate-200 dark:border-stone-800 rounded-3xl p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 id="status-modal-title" className="text-lg font-black text-slate-900 dark:text-white">
                  {statusTarget.active ? 'Suspender Restaurante' : 'Reativar Restaurante'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                  {statusTarget.name} ({statusTarget.slug})
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!statusBusy) {
                    setStatusTarget(null);
                    setStatusReason('');
                    setStatusError('');
                  }
                }}
                disabled={statusBusy}
                className="p-1 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                aria-label="Fechar"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {statusError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800 p-3 text-xs font-bold text-rose-800 dark:text-rose-300">
                {statusError}
              </div>
            )}

            <p className="text-xs text-slate-600 dark:text-stone-300 leading-relaxed">
              {statusTarget.active
                ? 'Ao suspender, o cardápio público e o painel de atendimento ficam indisponíveis até a reativação da operação.'
                : 'Ao reativar, os acessos às comandas e cardápio serão imediatamente restabelecidos para os clientes e funcionários.'}
            </p>

            <form onSubmit={handleStatusChange} className="space-y-4">
              <div>
                <label htmlFor="status-reason-input" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                  Motivo da alteração (opcional)
                </label>
                <input
                  id="status-reason-input"
                  type="text"
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  placeholder="Ex.: Manutenção programada, pendência contratual..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!statusBusy) {
                      setStatusTarget(null);
                      setStatusReason('');
                      setStatusError('');
                    }
                  }}
                  disabled={statusBusy}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={statusBusy}
                  className={`px-5 py-2 rounded-xl text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 ${
                    statusTarget.active
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : 'bg-emerald-600 hover:bg-emerald-700'
                  }`}
                >
                  {statusBusy ? 'Alterando...' : statusTarget.active ? 'Suspender Operação' : 'Reativar Operação'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------------------
          MODAL CENTRADO: ARQUIVAR / RESTAURAR RESTAURANTE
         -------------------------------------------------------------------- */}
      {archiveTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => {
            if (!archiveBusy) {
              setArchiveTarget(null);
              setArchiveName('');
              setArchiveReason('');
              setArchiveError('');
            }
          }}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-stone-900 border border-slate-200 dark:border-stone-800 rounded-3xl p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 id="archive-modal-title" className="text-lg font-black text-slate-900 dark:text-white">
                  {archiveTarget.archivedAt ? 'Restaurar Restaurante' : 'Arquivar Restaurante'}
                </h3>
                <p className="text-xs text-slate-500 dark:text-stone-400 mt-0.5">
                  {archiveTarget.name} ({archiveTarget.slug})
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!archiveBusy) {
                    setArchiveTarget(null);
                    setArchiveName('');
                    setArchiveReason('');
                    setArchiveError('');
                  }
                }}
                disabled={archiveBusy}
                className="p-1 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                aria-label="Fechar"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {archiveError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/40 dark:border-rose-800 p-3 text-xs font-bold text-rose-800 dark:text-rose-300">
                {archiveError}
              </div>
            )}

            <p className="text-xs text-slate-600 dark:text-stone-300 leading-relaxed">
              {archiveTarget.archivedAt
                ? 'O restaurante será desarquivado e movido para a lista principal em estado suspenso, até que seja reativado.'
                : 'O restaurante será ocultado da visão principal e arquivado. Os dados permanecerão preservados.'}
            </p>

            <form onSubmit={handleArchiveChange} className="space-y-4">
              {!archiveTarget.archivedAt && (
                <div>
                  <label htmlFor="archive-name-confirm" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                    Digite "{archiveTarget.name}" para confirmar
                  </label>
                  <input
                    id="archive-name-confirm"
                    type="text"
                    value={archiveName}
                    onChange={(e) => setArchiveName(e.target.value)}
                    placeholder={archiveTarget.name}
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              )}

              <div>
                <label htmlFor="archive-reason-input" className="block text-xs font-bold text-slate-700 dark:text-stone-300 mb-1">
                  Motivo do arquivamento (opcional)
                </label>
                <input
                  id="archive-reason-input"
                  type="text"
                  value={archiveReason}
                  onChange={(e) => setArchiveReason(e.target.value)}
                  placeholder="Ex.: Solicitação do proprietário, encerramento..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-stone-700 bg-slate-50 dark:bg-stone-800 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!archiveBusy) {
                      setArchiveTarget(null);
                      setArchiveName('');
                      setArchiveReason('');
                      setArchiveError('');
                    }
                  }}
                  disabled={archiveBusy}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 dark:text-stone-300 hover:bg-slate-100 dark:hover:bg-stone-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={
                    archiveBusy ||
                    (!archiveTarget.archivedAt &&
                      archiveName.trim().toLowerCase() !== archiveTarget.name.trim().toLowerCase())
                  }
                  className="px-5 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  {archiveBusy
                    ? 'Processando...'
                    : archiveTarget.archivedAt
                    ? 'Restaurar Estabelecimento'
                    : 'Arquivar Estabelecimento'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
