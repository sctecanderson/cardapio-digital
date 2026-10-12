export interface Category {
  id: string;
  restaurantId: string;
  name: string;
  slug: string;
  sortOrder: number;
}

export interface ProductImage {
  id: string;
  url: string;
  alt: string;
  sortOrder: number;
}

export interface ProductVideo {
  url: string;
  mimeType: 'video/mp4' | 'video/webm';
}

export interface ProductVariant {
  id: string;
  name: string;
  priceInCents: number;
  available: boolean;
}

export interface Product {
  id: string;
  restaurantId: string;
  categoryId: string;
  slug: string;

  name: string;
  shortDescription: string;
  description: string;

  // Valores em centavos: R$ 58,00 = 5800.
  priceInCents: number;

  available: boolean;
  featured: boolean;
  sortOrder: number;

  // A capa também deve estar presente na galeria.
  coverImageId: string;
  images: ProductImage[];

  // Sem vídeo, o Explorar utiliza a foto de capa.
  video?: ProductVideo;

  // Opcional: tamanhos ou apresentações com preços próprios.
  variants?: ProductVariant[];

  // Informação fornecida pelo restaurante, nunca presumida.
  dietaryInformation?: string;

  // Estimativa de tempo de preparo cadastrada pelo restaurante (em minutos).
  prepTimeMinMinutes?: number;
  prepTimeMaxMinutes?: number;

  // Total real de curtidas públicas do produto no catálogo.
  likesCount?: number;

  // Total real de comentários públicos aprovados do produto no catálogo.
  commentsCount?: number;
}

export interface PublicProductComment {
  id: string;
  productId: string;
  authorName: string;
  body: string;
  createdAt: string;
  likesCount: number;
}

export interface ProductCommentsCursor {
  createdAt: string;
  id: string;
}

export interface PublicProductCommentsPage {
  items: PublicProductComment[];
  hasMore: boolean;
  nextCursor: ProductCommentsCursor | null;
}

export interface CreatedProductCommentResult {
  id: string;
  productId: string;
  authorName: string;
  body: string;
  status: 'approved' | 'pending';
  createdAt: string;
  likesCount: number;
}

export interface ToggleProductCommentLikeResult {
  commentId: string;
  liked: boolean;
  likesCount: number;
}

export interface RestaurantMenu {
  restaurantId: string;
  categories: Category[];
  products: Product[];
}