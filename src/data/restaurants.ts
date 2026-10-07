import type { Restaurant } from '../types/restaurant';
export const restaurants: Record<string, Restaurant> = {
  noma: { slug: 'noma', name: 'NOMA', subtitle: 'Kitchen & Bar', theme: { primary: '#B9472B', background: '#FFF8EF', text: '#2B1D17' } },
  brasa: { slug: 'brasa', name: 'BRASA', subtitle: 'Burger House', theme: { primary: '#8B252A', background: '#FFF8EF', text: '#25201D' } },
};
