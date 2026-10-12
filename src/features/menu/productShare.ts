export interface ShareProductOptions {
  restaurantSlug: string;
  productSlug: string;
  productName: string;
  productDescription?: string;
}

export interface ShareResult {
  status: 'shared' | 'copied' | 'aborted' | 'error';
  message: string;
}

/**
 * Constrói uma URL pública canônica limpa para compartilhamento do produto.
 * Garante ausência total de parâmetros de mesa, comanda, sessão anônima ou tokens privados.
 */
export function buildProductPublicUrl(restaurantSlug: string, productSlug: string): string {
  const cleanRestaurant = restaurantSlug.trim();
  const cleanProduct = productSlug.trim();
  if (!cleanRestaurant || !cleanProduct) return '';
  const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return `${origin}/${encodeURIComponent(cleanRestaurant)}/produto/${encodeURIComponent(cleanProduct)}`;
}

/**
 * Executa o compartilhamento com navigator.share() se suportado,
 * fallback para navigator.clipboard / execCommand e tratamento suave de cancelamento do usuário.
 */
export async function shareProduct(options: ShareProductOptions): Promise<ShareResult> {
  const shareUrl = buildProductPublicUrl(options.restaurantSlug, options.productSlug);
  if (!shareUrl) {
    return {
      status: 'error',
      message: 'Não foi possível copiar o link',
    };
  }

  const title = options.productName.trim() || 'Prato no Elozi';
  const text =
    options.productDescription?.trim() || `Confira ${title} no cardápio digital.`;

  // Em celulares/navegadores com suporte à Web Share API, dispara o compartilhamento nativo
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({
        title,
        text,
        url: shareUrl,
      });
      return {
        status: 'shared',
        message: '',
      };
    } catch (err) {
      // Cancelamento pelo usuário no seletor nativo: retorno silencioso sem toast de erro
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          status: 'aborted',
          message: '',
        };
      }
      // Se der outro erro no share (ex: permissão ou rejeição), faz fallback para cópia
    }
  }

  // Fallback: cópia limpa para a área de transferência
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(shareUrl);
      return {
        status: 'copied',
        message: 'Link copiado',
      };
    }

    if (typeof document !== 'undefined') {
      const tempInput = document.createElement('textarea');
      tempInput.value = shareUrl;
      tempInput.style.position = 'fixed';
      tempInput.style.top = '-9999px';
      tempInput.style.left = '-9999px';
      tempInput.style.opacity = '0';
      document.body.appendChild(tempInput);
      tempInput.focus();
      tempInput.select();
      const success = document.execCommand('copy');
      document.body.removeChild(tempInput);
      if (success) {
        return {
          status: 'copied',
          message: 'Link copiado',
        };
      }
    }
  } catch {
    // Falha ao copiar
  }

  return {
    status: 'error',
    message: 'Não foi possível copiar o link',
  };
}
