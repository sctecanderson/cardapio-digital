import { supabase } from '../../lib/supabase';

export interface CreatedRestaurant {
  id: string;
  name: string;
  slug: string;
}

export interface PlatformRestaurant extends CreatedRestaurant {
  active: boolean;
  createdAt: string;
  adminCount: number;
  archivedAt: string | null;
}

function serverError(
  error: { code?: string; message: string },
  fallback: string,
) {
  return new Error(
    error.code === '42501' || error.code === '22023'
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

    return {
      ...restaurant,
      active: details.active,
      archivedAt: details.archivedAt as string | null,
      createdAt: details.createdAt,
      adminCount: details.adminCount,
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