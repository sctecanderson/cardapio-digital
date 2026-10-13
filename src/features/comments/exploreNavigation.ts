export interface ExploreNavigationState {
  fromExplore?: boolean;
  returnIndex?: number;
  returnProductId?: string;
  returnPaused?: boolean;
}

const EXPLORE_NAV_KEY = 'elozi_explore_nav_state';

export function saveExploreNavigationState(restaurantSlug: string, state: ExploreNavigationState): void {
  try {
    sessionStorage.setItem(`${EXPLORE_NAV_KEY}_${restaurantSlug}`, JSON.stringify(state));
  } catch {
    // sessionStorage indisponível
  }
}

export function getExploreNavigationState(restaurantSlug: string): ExploreNavigationState | null {
  try {
    const raw = sessionStorage.getItem(`${EXPLORE_NAV_KEY}_${restaurantSlug}`);
    if (!raw) return null;
    return JSON.parse(raw) as ExploreNavigationState;
  } catch {
    return null;
  }
}

export function clearExploreNavigationState(restaurantSlug: string): void {
  try {
    sessionStorage.removeItem(`${EXPLORE_NAV_KEY}_${restaurantSlug}`);
  } catch {
    // sessionStorage indisponível
  }
}
