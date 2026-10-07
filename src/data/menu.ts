import type { RestaurantMenu } from '../types/menu';

export const menus: Record<string, RestaurantMenu> = {
  noma: {
    restaurantId: 'noma',

    categories: [
      {
        id: 'noma-pratos',
        restaurantId: 'noma',
        name: 'Pratos',
        slug: 'pratos',
        sortOrder: 1,
      },
      {
        id: 'noma-bebidas',
        restaurantId: 'noma',
        name: 'Bebidas',
        slug: 'bebidas',
        sortOrder: 2,
      },
      {
        id: 'noma-sobremesas',
        restaurantId: 'noma',
        name: 'Sobremesas',
        slug: 'sobremesas',
        sortOrder: 3,
      },
    ],

    products: [
      {
        id: 'noma-risoto',
        restaurantId: 'noma',
        categoryId: 'noma-pratos',
        slug: 'risoto-de-cogumelos',
        name: 'Risoto de cogumelos',
        shortDescription: 'Arroz arbóreo, cogumelos e parmesão.',
        description:
          'Arroz arbóreo com mix de cogumelos e finalização com queijo parmesão.',
        priceInCents: 5800,
        available: true,
        featured: true,
        sortOrder: 1,
        coverImageId: 'noma-risoto-capa',
        video: {
          url: '/videos/noma/risoto.mp4',
          mimeType: 'video/mp4',
        },
        images: [
          {
            id: 'noma-risoto-capa',
            url: '/images/noma/risoto-capa.png',
            alt: 'Risoto de cogumelos servido em prato de cerâmica.',
            sortOrder: 1,
          },
          {
            id: 'noma-risoto-detalhe',
            url: '/images/noma/risoto-detalhe.png',
            alt: 'Detalhe dos cogumelos e do parmesão sobre o risoto.',
            sortOrder: 2,
          },
        ],
      },
      {
        id: 'noma-burguer',
        restaurantId: 'noma',
        categoryId: 'noma-pratos',
        slug: 'burguer-da-casa',
        name: 'Búrguer da casa',
        shortDescription: 'Brioche, queijo e molho da casa.',
        description:
          'Hambúrguer de carne no pão brioche, com queijo e molho da casa.',
        priceInCents: 4200,
        available: true,
        featured: false,
        sortOrder: 2,
        coverImageId: 'noma-burguer-capa',
        images: [
          {
            id: 'noma-burguer-capa',
            url: '/images/noma/burguer-capa.png',
            alt: 'Búrguer da casa com queijo no pão brioche.',
            sortOrder: 1,
          },
        ],
      },
      {
        id: 'noma-agua',
        restaurantId: 'noma',
        categoryId: 'noma-bebidas',
        slug: 'agua-com-gas',
        name: 'Água com gás',
        shortDescription: 'Garrafa de 500 ml.',
        description: 'Água mineral com gás, servida em garrafa de 500 ml.',
        priceInCents: 800,
        available: true,
        featured: false,
        sortOrder: 3,
        coverImageId: 'noma-agua-capa',
        images: [
          {
            id: 'noma-agua-capa',
            url: '/images/noma/agua-capa.png',
            alt: 'Garrafa de água com gás acompanhada de um copo.',
            sortOrder: 1,
          },
        ],
      },
      {
        id: 'noma-brownie',
        restaurantId: 'noma',
        categoryId: 'noma-sobremesas',
        slug: 'brownie-com-sorvete',
        name: 'Brownie com sorvete',
        shortDescription: 'Chocolate e sorvete de baunilha.',
        description:
          'Brownie de chocolate acompanhado de uma bola de sorvete de baunilha.',
        priceInCents: 2600,
        available: true,
        featured: false,
        sortOrder: 4,
        coverImageId: 'noma-brownie-capa',
        images: [
          {
            id: 'noma-brownie-capa',
            url: '/images/noma/brownie-capa.png',
            alt: 'Brownie de chocolate com uma bola de sorvete.',
            sortOrder: 1,
          },
        ],
      },
    ],
  },

  brasa: {
    restaurantId: 'brasa',

    categories: [
      {
        id: 'brasa-burgueres',
        restaurantId: 'brasa',
        name: 'Búrgueres',
        slug: 'burgueres',
        sortOrder: 1,
      },
      {
        id: 'brasa-acompanhamentos',
        restaurantId: 'brasa',
        name: 'Acompanhamentos',
        slug: 'acompanhamentos',
        sortOrder: 2,
      },
      {
        id: 'brasa-bebidas',
        restaurantId: 'brasa',
        name: 'Bebidas',
        slug: 'bebidas',
        sortOrder: 3,
      },
    ],

    products: [
      {
        id: 'brasa-duplo',
        restaurantId: 'brasa',
        categoryId: 'brasa-burgueres',
        slug: 'brasa-duplo',
        name: 'Brasa Duplo',
        shortDescription: 'Duas carnes, cheddar e molho da casa.',
        description:
          'Pão brioche com dois hambúrgueres de carne, cheddar, picles e molho da casa.',
        priceInCents: 4200,
        available: true,
        featured: true,
        sortOrder: 1,
        coverImageId: 'brasa-duplo-capa',
        images: [
          {
            id: 'brasa-duplo-capa',
            url: '/images/brasa/duplo-capa.png',
            alt: 'Hambúrguer duplo com cheddar e picles no pão brioche.',
            sortOrder: 1,
          },
        ],
      },
      {
        id: 'brasa-batata',
        restaurantId: 'brasa',
        categoryId: 'brasa-acompanhamentos',
        slug: 'batata-da-casa',
        name: 'Batata da casa',
        shortDescription: 'Batatas fritas douradas e crocantes.',
        description:
          'Porção de batatas fritas com tempero da casa.',
        priceInCents: 2200,
        available: true,
        featured: false,
        sortOrder: 2,
        coverImageId: 'brasa-batata-capa',
        images: [
          {
            id: 'brasa-batata-capa',
            url: '/images/brasa/batata-capa.png',
            alt: 'Porção de batatas fritas douradas.',
            sortOrder: 1,
          },
        ],
      },
      {
        id: 'brasa-agua',
        restaurantId: 'brasa',
        categoryId: 'brasa-bebidas',
        slug: 'agua-com-gas',
        name: 'Água com gás',
        shortDescription: 'Garrafa de 500 ml.',
        description: 'Água mineral com gás, servida em garrafa de 500 ml.',
        priceInCents: 800,
        available: true,
        featured: false,
        sortOrder: 3,
        coverImageId: 'brasa-agua-capa',
        images: [
          {
            id: 'brasa-agua-capa',
            url: '/images/noma/agua-capa.png',
            alt: 'Garrafa de água com gás acompanhada de um copo.',
            sortOrder: 1,
          },
        ],
      },
    ],
  },
};