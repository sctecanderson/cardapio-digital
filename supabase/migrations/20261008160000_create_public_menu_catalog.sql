begin;

-- As mídias são metadados do catálogo. Os arquivos de public/ não são movidos.
alter table public.menu_products
  add column images jsonb not null default '[]'::jsonb,
  add column cover_image_id text,
  add column video jsonb,
  add column dietary_information text,
  add constraint menu_products_images_array check (jsonb_typeof(images) = 'array'),
  add constraint menu_products_video_object check (
    video is null or jsonb_typeof(video) = 'object'
  );

-- Apenas os caminhos das mídias NOMA atuais. Preços, UUIDs e lançamentos são preservados.
update public.menu_products as product
set images = seed.images, cover_image_id = seed.cover_image_id, video = seed.video
from public.restaurants as restaurant,
jsonb_to_recordset('[
  {
    "catalog_key": "noma-risoto",
    "images": [
      {
        "id": "noma-risoto-capa",
        "url": "/images/noma/risoto-capa.png",
        "alt": "Risoto de cogumelos servido em prato de cerâmica.",
        "sortOrder": 1
      },
      {
        "id": "noma-risoto-detalhe",
        "url": "/images/noma/risoto-detalhe.png",
        "alt": "Detalhe dos cogumelos e do parmesão sobre o risoto.",
        "sortOrder": 2
      }
    ],
    "cover_image_id": "noma-risoto-capa",
    "video": {
      "url": "/videos/noma/risoto.mp4",
      "mimeType": "video/mp4"
    }
  },
  {
    "catalog_key": "noma-burguer",
    "images": [
      {
        "id": "noma-burguer-capa",
        "url": "/images/noma/burguer-capa.png",
        "alt": "Búrguer da casa com queijo no pão brioche.",
        "sortOrder": 1
      }
    ],
    "cover_image_id": "noma-burguer-capa",
    "video": null
  },
  {
    "catalog_key": "noma-agua",
    "images": [
      {
        "id": "noma-agua-capa",
        "url": "/images/noma/agua-capa.png",
        "alt": "Garrafa de água com gás acompanhada de um copo.",
        "sortOrder": 1
      }
    ],
    "cover_image_id": "noma-agua-capa",
    "video": null
  },
  {
    "catalog_key": "noma-brownie",
    "images": [
      {
        "id": "noma-brownie-capa",
        "url": "/images/noma/brownie-capa.png",
        "alt": "Brownie de chocolate com uma bola de sorvete.",
        "sortOrder": 1
      }
    ],
    "cover_image_id": "noma-brownie-capa",
    "video": null
  }
]'::jsonb)
  as seed(catalog_key text, images jsonb, cover_image_id text, video jsonb)
where restaurant.slug = 'noma'
  and product.restaurant_id = restaurant.id
  and product.catalog_key = seed.catalog_key;

-- Projeção pública explícita. Não expõe mesas, funcionários, sessões ou comandas.
-- SECURITY DEFINER é intencional: a leitura direta das tabelas permanece protegida.
create function public.get_public_menu(p_restaurant_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'restaurantId', restaurant.id,
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', category.id, 'restaurantId', category.restaurant_id,
      'name', category.name, 'slug', category.slug, 'sortOrder', category.sort_order
    ) order by category.sort_order, category.id)
    from public.menu_categories as category
    where category.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb),
  'products', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', product.id, 'restaurantId', product.restaurant_id,
      'categoryId', product.category_id, 'slug', product.slug,
      'name', product.name, 'shortDescription', product.short_description,
      'description', product.description, 'priceInCents', product.price_in_cents,
      'available', product.available, 'featured', product.featured,
      'sortOrder', product.sort_order, 'images', product.images,
      'coverImageId', product.cover_image_id, 'video', product.video,
      'dietaryInformation', product.dietary_information
    ) order by product.sort_order, product.id)
    from public.menu_products as product
    join public.menu_categories as category
      on category.id = product.category_id and category.restaurant_id = product.restaurant_id
    where product.restaurant_id = restaurant.id and category.active
  ), '[]'::jsonb)
)
from public.restaurants as restaurant
where restaurant.slug = p_restaurant_slug and restaurant.active;
$$;

revoke all on function public.get_public_menu(text) from public, anon, authenticated;
grant execute on function public.get_public_menu(text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
