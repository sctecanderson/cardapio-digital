import { useEffect, type CSSProperties } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useParams } from 'react-router';
import { restaurants } from '../data/restaurants';
import { MenuPage } from '../features/menu/MenuPage';
import { ProductPage } from '../features/menu/ProductPage';
import { ExplorePage } from '../features/explore/ExplorePage';
import { useTableContext } from '../features/tables/useTableContext';

function RestaurantLayout() {
  const { restaurantSlug = '' } = useParams();
  const table = useTableContext();
  const tableQuery =
    table.status === 'unverified'
      ? `?mesa=${table.tableNumber}`
      : '';
  const restaurant = restaurants[restaurantSlug];
  useEffect(() => { document.title = restaurant ? `${restaurant.name} · Cardápio` : 'Restaurante não encontrado'; }, [restaurant]);
  if (!restaurant) return <NotFound />;
  const theme = { '--brand': restaurant.theme.primary, '--page': restaurant.theme.background, '--ink': restaurant.theme.text } as CSSProperties;
  return <div className="restaurant" style={theme}>
    <a href="#content" className="skip-link">Pular para o conteúdo</a>
    <div className="shell">
      <header className="flex items-center justify-between gap-4 py-7">
        <Link to={`/${restaurant.slug}${tableQuery}`} aria-label={`${restaurant.name}, início`} className="wordmark">{restaurant.name}<span>{restaurant.subtitle}</span></Link>
        <span className="badge">
          {table.status === 'unverified'
            ? `Mesa ${table.tableNumber} · demonstração`
            : table.status === 'invalid'
              ? 'Mesa inválida'
              : 'Consulta sem mesa'}
        </span>
      </header>
      <nav className="tabs" aria-label="Modo de visualização">
  <NavLink
    end to={`/${restaurant.slug}${tableQuery}`}>
    Cardápio
  </NavLink>
  <NavLink
    to={`/${restaurant.slug}/explorar${tableQuery}`}>
    Explorar
  </NavLink>
</nav>
      <main id="content" className="py-8"><Outlet /></main>
      <footer className="py-6"><p>Ambiente demonstrativo · Etapa inicial</p><Link to={`/${restaurant.slug}/acesso`}>Acesso da equipe</Link></footer>
    </div>
  </div>;
}
function Stage({ title, text }: { title: string; text: string }) {
  return <section className="panel"><span className="eyebrow">Estrutura inicial</span><h1>{title}</h1><p>{text}</p></section>;
}
function Access() {
  return <Stage title="Acesso da equipe" text="A autenticação será integrada ao Supabase em uma etapa posterior. Nenhum acesso operacional está liberado nesta versão." />;
}
function NotFound() { return <main className="shell py-8"><h1>Página não encontrada</h1><p>Confira o endereço do restaurante.</p><Link to="/">Voltar ao início</Link></main>; }
function Start() {
  return <main className="shell py-8"><span className="eyebrow">Demonstração white-label</span><h1>Cardápio Digital</h1><p>Escolha uma identidade para verificar a estrutura e o tema.</p><div className="grid gap-4 mt-6">{Object.values(restaurants).map(r => <Link className="panel" key={r.slug} to={`/${r.slug}`}><strong>{r.name}</strong><p>{r.subtitle}</p></Link>)}</div></main>;
}
export function App() {
  return <Routes>
    <Route path="/" element={<Start />} />
    <Route path=":restaurantSlug" element={<RestaurantLayout />}>
      <Route index element={<MenuPage />} />

      <Route
        path="produto/:productSlug"
        element={<ProductPage />}
      />
      <Route path="explorar" element={<ExplorePage />} />
      <Route path="acesso" element={<Access />} />
      <Route path="equipe/*" element={<Navigate to="../acesso" replace />} />
      <Route path="admin/*" element={<Navigate to="../acesso" replace />} />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>;
}
