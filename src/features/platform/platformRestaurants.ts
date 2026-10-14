import { supabase } from '../../lib/supabase';

export interface CreatedRestaurant {
  id: string;
  name: string;
  slug: string;
}

export type SubscriptionPlan = 'basic' | 'pro' | 'premium';
export type PlatformBillingStatus = 'active' | 'grace_period' | 'expired';

export interface PlatformRestaurant extends CreatedRestaurant {
  active: boolean;
  createdAt: string;
  adminCount: number;
  adminEmails?: string[];
  archivedAt: string | null;
  subscriptionPlan: SubscriptionPlan;
  monthlyPriceCents: number;
  maxTables: number;
  activeTablesCount: number;
  subscriptionStartedAt: string;
  subscriptionExpiresAt: string;
  billingCycleDays: number;
  daysRemaining: number;
  billingStatus: PlatformBillingStatus;
}

export interface PlatformAuditLog {
  id: string;
  action:
    | 'plan_changed'
    | 'cycle_renewed'
    | 'table_deleted'
    | 'restaurant_suspended'
    | 'restaurant_restored'
    | 'catalog_updated'
    | 'branding_updated';
  targetRestaurantId: string | null;
  targetRestaurantName: string;
  actorEmail: string;
  details: Record<string, unknown>;
  createdAt: string;
}

function serverError(
  error: { code?: string; message: string },
  fallback: string,
) {
  return new Error(
    error.code === '42501' || error.code === '22023' || error.code === '55000'
      ? error.message
      : fallback,
  );
}

function parseCreatedRestaurant(value: unknown): CreatedRestaurant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Resposta de restaurante inválida.');
  }

  const restaurant = value as Record<string, unknown>;

  if (
    typeof restaurant.id !== 'string' ||
    typeof restaurant.name !== 'string' ||
    typeof restaurant.slug !== 'string'
  ) {
    throw new Error('Dados do restaurante inválidos.');
  }

  return {
    id: restaurant.id,
    name: restaurant.name,
    slug: restaurant.slug,
  };
}

export async function getPlatformAccess(): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_platform_access');

  if (error) {
    throw serverError(
      error,
      'Não foi possível verificar seu acesso à Elozi.',
    );
  }

  if (typeof data !== 'boolean') {
    throw new Error('Resposta de autorização inválida.');
  }

  return data;
}

export async function listPlatformRestaurants(): Promise<
  PlatformRestaurant[]
> {
  const { data, error } = await supabase.rpc(
    'list_platform_restaurants',
  );

  if (error) {
    throw serverError(
      error,
      'Não foi possível carregar os restaurantes.',
    );
  }

  if (!Array.isArray(data)) {
    throw new Error('Lista de restaurantes inválida.');
  }

  return data.map((value: unknown): PlatformRestaurant => {
    const restaurant = parseCreatedRestaurant(value);
    const details = value as Record<string, unknown>;

    if (
      typeof details.active !== 'boolean' ||
      (
        details.archivedAt !== null &&
        (
          typeof details.archivedAt !== 'string' ||
          !Number.isFinite(Date.parse(details.archivedAt))
        )
      ) ||
      typeof details.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(details.createdAt)) ||
      typeof details.adminCount !== 'number' ||
      !Number.isSafeInteger(details.adminCount) ||
      details.adminCount < 0
    ) {
      throw new Error('Dados da lista de restaurantes inválidos.');
    }

    const rawPlan = (details.subscriptionPlan ?? details.subscription_plan) as string | undefined;
    const subscriptionPlan: SubscriptionPlan =
      rawPlan === 'pro' || rawPlan === 'premium' ? rawPlan : 'basic';

    const rawMonthlyPrice = Number(details.monthlyPriceCents ?? details.monthly_price_cents ?? 9900);
    const monthlyPriceCents =
      Number.isSafeInteger(rawMonthlyPrice) && rawMonthlyPrice >= 0
        ? rawMonthlyPrice
        : subscriptionPlan === 'pro'
        ? 14900
        : subscriptionPlan === 'premium'
        ? 19900
        : 9900;

    const rawMaxTables = Number(details.maxTables ?? details.max_tables ?? 10);
    const maxTables =
      Number.isSafeInteger(rawMaxTables) && rawMaxTables > 0
        ? rawMaxTables
        : subscriptionPlan === 'pro'
        ? 25
        : subscriptionPlan === 'premium'
        ? 100
        : 10;

    const rawActiveTables = Number(details.activeTablesCount ?? details.active_tables_count ?? 0);
    const activeTablesCount =
      Number.isSafeInteger(rawActiveTables) && rawActiveTables >= 0
        ? rawActiveTables
        : 0;

    const subscriptionStartedAt = String(details.subscriptionStartedAt ?? details.subscription_started_at ?? new Date().toISOString());
    const subscriptionExpiresAt = String(details.subscriptionExpiresAt ?? details.subscription_expires_at ?? new Date(Date.now() + 30 * 86400000).toISOString());
    const billingCycleDays = Number(details.billingCycleDays ?? details.billing_cycle_days ?? 30);
    const rawDaysRemaining = details.daysRemaining ?? details.days_remaining;
    const daysRemaining =
      typeof rawDaysRemaining === 'number'
        ? rawDaysRemaining
        : Math.ceil((Date.parse(subscriptionExpiresAt) - Date.now()) / 86400000);

    const rawAdminEmails = (details.adminEmails ?? details.admin_emails) as unknown;
    const adminEmails = Array.isArray(rawAdminEmails)
      ? rawAdminEmails.filter((email): email is string => typeof email === 'string')
      : [];

    const rawStatus = (details.billingStatus ?? details.billing_status) as string | undefined;
    const billingStatus: PlatformBillingStatus =
      rawStatus === 'grace_period' || rawStatus === 'expired'
        ? rawStatus
        : rawStatus === 'active'
        ? 'active'
        : daysRemaining <= -3
        ? 'expired'
        : daysRemaining <= 0
        ? 'grace_period'
        : 'active';

    return {
      ...restaurant,
      active: details.active,
      archivedAt: details.archivedAt as string | null,
      createdAt: details.createdAt,
      adminCount: details.adminCount,
      adminEmails,
      subscriptionPlan,
      monthlyPriceCents,
      maxTables,
      activeTablesCount,
      subscriptionStartedAt,
      subscriptionExpiresAt,
      billingCycleDays,
      daysRemaining,
      billingStatus,
    };
  });
}

export async function createPlatformRestaurant(
  input: CreatedRestaurant,
): Promise<CreatedRestaurant> {
  const { data, error } = await supabase.rpc(
    'create_platform_restaurant',
    {
      p_id: input.id,
      p_name: input.name,
      p_slug: input.slug,
    },
  );

  if (error) {
    throw serverError(
      error,
      'Não foi possível cadastrar o restaurante. Tente novamente.',
    );
  }

  const restaurant = parseCreatedRestaurant(data);

  if (restaurant.id !== input.id) {
    throw new Error('O servidor retornou outro cadastro.');
  }

  return restaurant;
}

export async function assumePlatformRestaurantSetup(
  restaurantId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc(
    'assume_platform_restaurant_setup',
    {
      p_restaurant_id: restaurantId,
    },
  );

  if (error) {
    throw serverError(
      error,
      'Não foi possível assumir a configuração do restaurante.',
    );
  }

  if (typeof data !== 'string' || !data) {
    throw new Error(
      'O vínculo de administrador não foi confirmado pelo servidor.',
    );
  }

  return data;
}

export async function setPlatformRestaurantActive(
  restaurantId: string,
  expectedActive: boolean,
  active: boolean,
  reason: string,
): Promise<{ id: string; active: boolean }> {
  const cleanReason = reason.trim();

  if (cleanReason.length < 3 || cleanReason.length > 500) {
    throw new Error('Informe um motivo de 3 a 500 caracteres.');
  }

  const { data, error } = await supabase.rpc(
    'set_platform_restaurant_active',
    {
      p_restaurant_id: restaurantId,
      p_expected_active: expectedActive,
      p_active: active,
      p_reason: cleanReason,
    },
  );

  if (error) {
    if (
      error.code === '42501' ||
      error.code === '22023' ||
      error.code === '55000' ||
      error.code === '40001'
    ) {
      throw new Error(error.message);
    }

    throw new Error(
      'Não foi possível alterar o status. Atualize a lista antes de tentar novamente.',
    );
  }

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.id !== restaurantId ||
    typeof data.active !== 'boolean' ||
    data.active !== active
  ) {
    throw new Error(
      'O status não foi confirmado pelo servidor. Atualize a lista.',
    );
  }

  return {
    id: data.id,
    active: data.active,
  };
}

export async function setPlatformRestaurantArchived(
  restaurantId: string,
  archived: boolean,
  confirmationName: string,
  reason: string,
): Promise<{
  id: string;
  active: boolean;
  archivedAt: string | null;
}> {
  const cleanReason = reason.trim();
  const cleanName = confirmationName.trim();

  if (!cleanName) {
    throw new Error('Digite o nome do restaurante para confirmar.');
  }

  if (cleanReason.length < 3 || cleanReason.length > 500) {
    throw new Error('Informe um motivo de 3 a 500 caracteres.');
  }

  const { data, error } = await supabase.rpc(
    'set_platform_restaurant_archived',
    {
      p_restaurant_id: restaurantId,
      p_archived: archived,
      p_confirmation_name: cleanName,
      p_reason: cleanReason,
    },
  );

  if (error) {
    throw serverError(
      error,
      'Não foi possível alterar o arquivamento. Atualize a lista antes de tentar novamente.',
    );
  }

  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    data.id !== restaurantId ||
    data.active !== false ||
    (
      archived
        ? typeof data.archivedAt !== 'string' ||
          !Number.isFinite(Date.parse(data.archivedAt))
        : data.archivedAt !== null
    )
  ) {
    throw new Error(
      'O arquivamento não foi confirmado pelo servidor. Atualize a lista.',
    );
  }

  return {
    id: data.id,
    active: data.active,
    archivedAt: data.archivedAt,
  };
}

export interface UpdatedSaasPlan {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  archivedAt: string | null;
  subscriptionPlan: SubscriptionPlan;
  monthlyPriceCents: number;
  maxTables: number;
  activeTablesCount: number;
  subscriptionStartedAt?: string;
  subscriptionExpiresAt?: string;
  billingCycleDays?: number;
  daysRemaining?: number;
  billingStatus?: PlatformBillingStatus;
}

export async function updateRestaurantSaasPlan(
  restaurantId: string,
  plan: SubscriptionPlan,
  monthlyPriceCents?: number | null,
  maxTables?: number | null,
  billingCycleDays?: number | null,
  renewCycle?: boolean,
): Promise<UpdatedSaasPlan> {
  const { data, error } = await supabase.rpc('update_restaurant_saas_plan', {
    p_restaurant_id: restaurantId,
    p_plan: plan,
    p_monthly_price_cents: monthlyPriceCents ?? null,
    p_max_tables: maxTables ?? null,
    p_billing_cycle_days: billingCycleDays ?? null,
    p_renew_cycle: Boolean(renewCycle),
  });

  if (error) {
    // Fallback seguro direto na tabela restaurants pelo SuperAdmin
    const defaultPrices: Record<SubscriptionPlan, number> = { basic: 9900, pro: 14900, premium: 19900 };
    const defaultTables: Record<SubscriptionPlan, number> = { basic: 10, pro: 25, premium: 100 };
    const targetPrice = monthlyPriceCents ?? defaultPrices[plan];
    const targetMaxTables = maxTables ?? defaultTables[plan];
    const targetCycleDays = billingCycleDays ?? 30;

    const updates: Record<string, unknown> = {
      subscription_plan: plan,
      monthly_price_cents: targetPrice,
      max_tables: targetMaxTables,
      billing_cycle_days: targetCycleDays,
    };

    if (renewCycle || billingCycleDays) {
      const now = new Date();
      const expires = new Date(now.getTime() + targetCycleDays * 86400000);
      updates.subscription_started_at = now.toISOString();
      updates.subscription_expires_at = expires.toISOString();
    }

    const { data: directData, error: directError } = await supabase
      .from('restaurants')
      .update(updates)
      .eq('id', restaurantId)
      .select('id, name, slug, active, archived_at, subscription_plan, monthly_price_cents, max_tables, billing_cycle_days, subscription_started_at, subscription_expires_at')
      .single();

    if (directError) {
      throw serverError(
        error,
        `Não foi possível atualizar o plano do restaurante: ${error.message}`,
      );
    }

    const expiresAt = String(directData.subscription_expires_at ?? new Date(Date.now() + targetCycleDays * 86400000).toISOString());
    const daysRemaining = Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000);
    const billingStatus: PlatformBillingStatus =
      daysRemaining <= -3 ? 'expired' : daysRemaining <= 0 ? 'grace_period' : 'active';

    return {
      id: String(directData.id),
      name: String(directData.name),
      slug: String(directData.slug),
      active: Boolean(directData.active),
      archivedAt: (directData.archived_at ?? null) as string | null,
      subscriptionPlan: plan,
      monthlyPriceCents: Number(directData.monthly_price_cents ?? targetPrice),
      maxTables: Number(directData.max_tables ?? targetMaxTables),
      activeTablesCount: 0,
      subscriptionStartedAt: String(directData.subscription_started_at ?? new Date().toISOString()),
      subscriptionExpiresAt: expiresAt,
      billingCycleDays: Number(directData.billing_cycle_days ?? targetCycleDays),
      daysRemaining,
      billingStatus,
    };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Resposta de atualização de plano inválida.');
  }

  const details = data as Record<string, unknown>;
  const rawPlan = (details.subscriptionPlan ?? details.subscription_plan) as string | undefined;
  const subscriptionPlan: SubscriptionPlan =
    rawPlan === 'pro' || rawPlan === 'premium' ? rawPlan : 'basic';

  const expiresAt = String(details.subscriptionExpiresAt ?? details.subscription_expires_at ?? new Date(Date.now() + 30 * 86400000).toISOString());
  const rawDaysRemaining = details.daysRemaining ?? details.days_remaining;
  const daysRemaining =
    typeof rawDaysRemaining === 'number'
      ? rawDaysRemaining
      : Math.ceil((Date.parse(expiresAt) - Date.now()) / 86400000);

  const rawStatus = (details.billingStatus ?? details.billing_status) as string | undefined;
  const billingStatus: PlatformBillingStatus =
    rawStatus === 'grace_period' || rawStatus === 'expired'
      ? rawStatus
      : rawStatus === 'active'
      ? 'active'
      : daysRemaining <= -3
      ? 'expired'
      : daysRemaining <= 0
      ? 'grace_period'
      : 'active';

  return {
    id: String(details.id),
    name: String(details.name),
    slug: String(details.slug),
    active: Boolean(details.active),
    archivedAt: (details.archivedAt ?? details.archived_at ?? null) as string | null,
    subscriptionPlan,
    monthlyPriceCents: Number(details.monthlyPriceCents ?? details.monthly_price_cents ?? 9900),
    maxTables: Number(details.maxTables ?? details.max_tables ?? 10),
    activeTablesCount: Number(details.activeTablesCount ?? details.active_tables_count ?? 0),
    subscriptionStartedAt: String(details.subscriptionStartedAt ?? details.subscription_started_at ?? new Date().toISOString()),
    subscriptionExpiresAt: expiresAt,
    billingCycleDays: Number(details.billingCycleDays ?? details.billing_cycle_days ?? 30),
    daysRemaining,
    billingStatus,
  };
}

export interface PlatformBrandingSettings {
  platformName: string;
  platformSubtitle: string;
  platformLogoUrl: string | null;
  superadminName: string;
  superadminAvatarUrl: string | null;
  updatedAt: string;
  basicPriceCents: number;
  basicMaxTables: number;
  proPriceCents: number;
  proMaxTables: number;
  premiumPriceCents: number;
  premiumMaxTables: number;
}

export async function getPlatformBranding(): Promise<PlatformBrandingSettings> {
  const { data, error } = await supabase.rpc('get_platform_branding');
  if (error || !data) {
    const { data: rowData } = await supabase
      .from('platform_settings')
      .select('*')
      .eq('id', 'default')
      .maybeSingle();

    if (rowData) {
      return {
        platformName: rowData.platform_name || 'Elozi',
        platformSubtitle: rowData.platform_subtitle || 'Administração da Plataforma',
        platformLogoUrl: rowData.platform_logo_url || null,
        superadminName: rowData.superadmin_name || 'SuperAdmin',
        superadminAvatarUrl: rowData.superadmin_avatar_url || null,
        updatedAt: rowData.updated_at || new Date().toISOString(),
        basicPriceCents: Number(rowData.basic_price_cents ?? 9900),
        basicMaxTables: Number(rowData.basic_max_tables ?? 10),
        proPriceCents: Number(rowData.pro_price_cents ?? 14900),
        proMaxTables: Number(rowData.pro_max_tables ?? 25),
        premiumPriceCents: Number(rowData.premium_price_cents ?? 19900),
        premiumMaxTables: Number(rowData.premium_max_tables ?? 100),
      };
    }

    return {
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
    };
  }

  const d = data as Record<string, unknown>;
  return {
    platformName: String(d.platformName ?? d.platform_name ?? 'Elozi'),
    platformSubtitle: String(d.platformSubtitle ?? d.platform_subtitle ?? 'Administração da Plataforma'),
    platformLogoUrl: (d.platformLogoUrl ?? d.platform_logo_url ?? null) as string | null,
    superadminName: String(d.superadminName ?? d.superadmin_name ?? 'SuperAdmin'),
    superadminAvatarUrl: (d.superadminAvatarUrl ?? d.superadmin_avatar_url ?? null) as string | null,
    updatedAt: String(d.updatedAt ?? d.updated_at ?? new Date().toISOString()),
    basicPriceCents: Number(d.basicPriceCents ?? d.basic_price_cents ?? 9900),
    basicMaxTables: Number(d.basicMaxTables ?? d.basic_max_tables ?? 10),
    proPriceCents: Number(d.proPriceCents ?? d.pro_price_cents ?? 14900),
    proMaxTables: Number(d.proMaxTables ?? d.pro_max_tables ?? 25),
    premiumPriceCents: Number(d.premiumPriceCents ?? d.premium_price_cents ?? 19900),
    premiumMaxTables: Number(d.premiumMaxTables ?? d.premium_max_tables ?? 100),
  };
}

export async function updatePlatformBranding(params: {
  platformName?: string;
  platformSubtitle?: string;
  platformLogoUrl?: string | null;
  superadminName?: string;
  superadminAvatarUrl?: string | null;
  clearLogo?: boolean;
  clearAvatar?: boolean;
}): Promise<PlatformBrandingSettings> {
  const { data, error } = await supabase.rpc('update_platform_branding', {
    p_platform_name: params.platformName ?? null,
    p_platform_subtitle: params.platformSubtitle ?? null,
    p_platform_logo_url: params.platformLogoUrl ?? null,
    p_superadmin_name: params.superadminName ?? null,
    p_superadmin_avatar_url: params.superadminAvatarUrl ?? null,
    p_clear_logo: Boolean(params.clearLogo),
    p_clear_avatar: Boolean(params.clearAvatar),
  });

  if (error) {
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (params.platformName !== undefined) updates.platform_name = params.platformName;
    if (params.platformSubtitle !== undefined) updates.platform_subtitle = params.platformSubtitle;
    if (params.clearLogo) updates.platform_logo_url = null;
    else if (params.platformLogoUrl !== undefined) updates.platform_logo_url = params.platformLogoUrl;
    if (params.superadminName !== undefined) updates.superadmin_name = params.superadminName;
    if (params.clearAvatar) updates.superadmin_avatar_url = null;
    else if (params.superadminAvatarUrl !== undefined) updates.superadmin_avatar_url = params.superadminAvatarUrl;

    const { data: updatedRow, error: directError } = await supabase
      .from('platform_settings')
      .update(updates)
      .eq('id', 'default')
      .select('*')
      .single();

    if (directError) {
      throw serverError(error, 'Não foi possível atualizar as configurações da plataforma.');
    }

    return {
      platformName: updatedRow.platform_name || 'Elozi',
      platformSubtitle: updatedRow.platform_subtitle || 'Administração da Plataforma',
      platformLogoUrl: updatedRow.platform_logo_url || null,
      superadminName: updatedRow.superadmin_name || 'SuperAdmin',
      superadminAvatarUrl: updatedRow.superadmin_avatar_url || null,
      updatedAt: updatedRow.updated_at || new Date().toISOString(),
      basicPriceCents: Number(updatedRow.basic_price_cents ?? 9900),
      basicMaxTables: Number(updatedRow.basic_max_tables ?? 10),
      proPriceCents: Number(updatedRow.pro_price_cents ?? 14900),
      proMaxTables: Number(updatedRow.pro_max_tables ?? 25),
      premiumPriceCents: Number(updatedRow.premium_price_cents ?? 19900),
      premiumMaxTables: Number(updatedRow.premium_max_tables ?? 100),
    };
  }

  const d = data as Record<string, unknown>;
  return {
    platformName: String(d.platformName ?? d.platform_name ?? 'Elozi'),
    platformSubtitle: String(d.platformSubtitle ?? d.platform_subtitle ?? 'Administração da Plataforma'),
    platformLogoUrl: (d.platformLogoUrl ?? d.platform_logo_url ?? null) as string | null,
    superadminName: String(d.superadminName ?? d.superadmin_name ?? 'SuperAdmin'),
    superadminAvatarUrl: (d.superadminAvatarUrl ?? d.superadmin_avatar_url ?? null) as string | null,
    updatedAt: String(d.updatedAt ?? d.updated_at ?? new Date().toISOString()),
    basicPriceCents: Number(d.basicPriceCents ?? d.basic_price_cents ?? 9900),
    basicMaxTables: Number(d.basicMaxTables ?? d.basic_max_tables ?? 10),
    proPriceCents: Number(d.proPriceCents ?? d.pro_price_cents ?? 14900),
    proMaxTables: Number(d.proMaxTables ?? d.pro_max_tables ?? 25),
    premiumPriceCents: Number(d.premiumPriceCents ?? d.premium_price_cents ?? 19900),
    premiumMaxTables: Number(d.premiumMaxTables ?? d.premium_max_tables ?? 100),
  };
}

export interface PlanCatalogUpdateParams {
  basicPriceCents: number;
  basicMaxTables: number;
  proPriceCents: number;
  proMaxTables: number;
  premiumPriceCents: number;
  premiumMaxTables: number;
  syncExistingRestaurants?: boolean;
}

export interface PlanCatalogUpdateResult {
  success: boolean;
  basicPriceCents: number;
  basicMaxTables: number;
  proPriceCents: number;
  proMaxTables: number;
  premiumPriceCents: number;
  premiumMaxTables: number;
  syncedRestaurantsCount: number;
}

export async function updatePlatformPlanCatalog(
  params: PlanCatalogUpdateParams,
): Promise<PlanCatalogUpdateResult> {
  const { data, error } = await supabase.rpc('update_platform_plan_catalog', {
    p_basic_price_cents: params.basicPriceCents,
    p_basic_max_tables: params.basicMaxTables,
    p_pro_price_cents: params.proPriceCents,
    p_pro_max_tables: params.proMaxTables,
    p_premium_price_cents: params.premiumPriceCents,
    p_premium_max_tables: params.premiumMaxTables,
    p_sync_existing_restaurants: Boolean(params.syncExistingRestaurants),
  });

  if (error) {
    const { error: directError } = await supabase
      .from('platform_settings')
      .update({
        basic_price_cents: params.basicPriceCents,
        basic_max_tables: params.basicMaxTables,
        pro_price_cents: params.proPriceCents,
        pro_max_tables: params.proMaxTables,
        premium_price_cents: params.premiumPriceCents,
        premium_max_tables: params.premiumMaxTables,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 'default');

    if (directError) {
      throw serverError(error, `Não foi possível atualizar o catálogo de planos: ${error.message}`);
    }

    let syncedCount = 0;
    if (params.syncExistingRestaurants) {
      const { data: bData } = await supabase.from('restaurants').update({ monthly_price_cents: params.basicPriceCents, max_tables: params.basicMaxTables }).eq('subscription_plan', 'basic').select('id');
      const { data: pData } = await supabase.from('restaurants').update({ monthly_price_cents: params.proPriceCents, max_tables: params.proMaxTables }).eq('subscription_plan', 'pro').select('id');
      const { data: prData } = await supabase.from('restaurants').update({ monthly_price_cents: params.premiumPriceCents, max_tables: params.premiumMaxTables }).eq('subscription_plan', 'premium').select('id');
      syncedCount = (bData?.length ?? 0) + (pData?.length ?? 0) + (prData?.length ?? 0);
    }

    return {
      success: true,
      basicPriceCents: params.basicPriceCents,
      basicMaxTables: params.basicMaxTables,
      proPriceCents: params.proPriceCents,
      proMaxTables: params.proMaxTables,
      premiumPriceCents: params.premiumPriceCents,
      premiumMaxTables: params.premiumMaxTables,
      syncedRestaurantsCount: syncedCount,
    };
  }

  const d = data as Record<string, unknown>;
  return {
    success: true,
    basicPriceCents: Number(d.basicPriceCents ?? params.basicPriceCents),
    basicMaxTables: Number(d.basicMaxTables ?? params.basicMaxTables),
    proPriceCents: Number(d.proPriceCents ?? params.proPriceCents),
    proMaxTables: Number(d.proMaxTables ?? params.proMaxTables),
    premiumPriceCents: Number(d.premiumPriceCents ?? params.premiumPriceCents),
    premiumMaxTables: Number(d.premiumMaxTables ?? params.premiumMaxTables),
    syncedRestaurantsCount: Number(d.syncedRestaurantsCount ?? 0),
  };
}

export async function fetchPlatformAuditLogs(limit = 50): Promise<PlatformAuditLog[]> {
  const { data, error } = await supabase.rpc('list_platform_audit_logs', {
    p_limit: limit,
  });

  if (error) {
    const { data: directData, error: directError } = await supabase
      .from('platform_audit_logs')
      .select('id, action, target_restaurant_id, target_restaurant_name, actor_email, details, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (directError) {
      throw serverError(error, 'Não foi possível carregar o histórico de auditoria.');
    }

    if (!Array.isArray(directData)) {
      return [];
    }

    return directData.map((row: Record<string, unknown>): PlatformAuditLog => ({
      id: String(row.id),
      action: row.action as PlatformAuditLog['action'],
      targetRestaurantId: (row.target_restaurant_id as string | null) ?? null,
      targetRestaurantName: String(row.target_restaurant_name || 'Plataforma'),
      actorEmail: String(row.actor_email || 'superadmin'),
      details: (row.details && typeof row.details === 'object' ? row.details : {}) as Record<string, unknown>,
      createdAt: String(row.created_at || new Date().toISOString()),
    }));
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((item: unknown): PlatformAuditLog => {
    const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      id: String(record.id),
      action: record.action as PlatformAuditLog['action'],
      targetRestaurantId: ((record.targetRestaurantId ?? record.target_restaurant_id) as string | null) ?? null,
      targetRestaurantName: String(record.targetRestaurantName ?? record.target_restaurant_name ?? 'Plataforma'),
      actorEmail: String(record.actorEmail ?? record.actor_email ?? 'superadmin'),
      details: (record.details && typeof record.details === 'object' ? record.details : {}) as Record<string, unknown>,
      createdAt: String(record.createdAt ?? record.created_at ?? new Date().toISOString()),
    };
  });
}
