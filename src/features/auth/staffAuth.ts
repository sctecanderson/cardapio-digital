import { supabase } from '../../lib/supabase';

export interface StaffAccess {
  memberId: string;
  restaurantId: string;
  userId: string;
  role: 'admin' | 'waiter';
}

export async function getStaffAccess(
  restaurantSlug: string,
): Promise<StaffAccess | null> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    throw new Error(
      'Não foi possível verificar sua sessão. Entre novamente.',
    );
  }

  if (!user || user.is_anonymous) {
    return null;
  }

  const {
    data: restaurant,
    error: restaurantError,
  } = await supabase
    .from('restaurants')
    .select('id')
    .eq('slug', restaurantSlug)
    .eq('active', true)
    .maybeSingle();

  if (restaurantError) {
    throw new Error(
      'Não foi possível consultar o restaurante. Tente novamente.',
    );
  }

  if (!restaurant) {
    return null;
  }

  const {
    data: member,
    error: memberError,
  } = await supabase
    .from('restaurant_members')
    .select('id, restaurant_id, user_id, role')
    .eq('restaurant_id', restaurant.id)
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle();

  if (memberError) {
    throw new Error(
      'Não foi possível verificar seu acesso. Tente novamente.',
    );
  }

  if (
    !member ||
    (member.role !== 'admin' && member.role !== 'waiter')
  ) {
    return null;
  }

  return {
    memberId: member.id,
    restaurantId: member.restaurant_id,
    userId: member.user_id,
    role: member.role,
  };
}

export async function signInStaff(
  email: string,
  password: string,
  restaurantSlug: string,
): Promise<StaffAccess | null> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) {
    throw new Error(
      'Não foi possível entrar. Confira e-mail e senha e tente novamente.',
    );
  }

  return getStaffAccess(restaurantSlug);
}

export async function signOutStaff(): Promise<void> {
  const { error } = await supabase.auth.signOut({
    scope: 'local',
  });

  if (error) {
    throw new Error(
      'Não foi possível sair. Tente novamente.',
    );
  }
}