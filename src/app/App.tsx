import { useEffect, lazy, Suspense, type CSSProperties } from "react";
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useParams,
  useLocation,
} from "react-router";
import {
  RestaurantProvider,
  useRestaurant,
} from "../features/restaurants/RestaurantProvider";
import { PublicMenuProvider } from "../features/menu/PublicMenuProvider";
import { MenuPage } from "../features/menu/MenuPage";
import { HomePage } from "../features/menu/HomePage";
import { useTableContext } from "../features/tables/useTableContext";
import { RequireStaffAccess } from "../features/auth/RequireStaffAccess";

const ProductPage = lazy(() =>
  import("../features/menu/ProductPage").then((m) => ({
    default: m.ProductPage,
  })),
);
const ProductCommentsPage = lazy(() =>
  import("../features/comments/ProductCommentsPage").then((m) => ({
    default: m.ProductCommentsPage,
  })),
);
const ExplorePage = lazy(() =>
  import("../features/explore/ExplorePage").then((m) => ({
    default: m.ExplorePage,
  })),
);
const TabOrdersPage = lazy(() =>
  import("../features/service/TabOrdersPage").then((m) => ({
    default: m.TabOrdersPage,
  })),
);
const AccessPage = lazy(() =>
  import("../features/auth/AccessPage").then((m) => ({
    default: m.AccessPage,
  })),
);
const StaffServicePage = lazy(() =>
  import("../features/service/StaffServicePage").then((m) => ({
    default: m.StaffServicePage,
  })),
);
const StaffHistoryPage = lazy(() =>
  import("../features/service/StaffHistoryPage").then((m) => ({
    default: m.StaffHistoryPage,
  })),
);
const StaffProfilePage = lazy(() =>
  import("../features/service/StaffProfilePage").then((m) => ({
    default: m.StaffProfilePage,
  })),
);
const AdminCatalogPage = lazy(() =>
  import("../features/admin/AdminCatalogPage").then((m) => ({
    default: m.AdminCatalogPage,
  })),
);
const AdminCommentsPage = lazy(() =>
  import("../features/admin/AdminCommentsPage").then((m) => ({
    default: m.AdminCommentsPage,
  })),
);
const AdminLayout = lazy(() =>
  import("../features/admin/AdminLayout").then((m) => ({
    default: m.AdminLayout,
  })),
);
const IdentityPage = lazy(() =>
  import("../features/admin/IdentityPage").then((m) => ({
    default: m.IdentityPage,
  })),
);
const TablesPage = lazy(() =>
  import("../features/admin/TablesPage").then((m) => ({
    default: m.TablesPage,
  })),
);
const AdminOverview = lazy(() =>
  import("../features/admin/AdminOverview").then((m) => ({
    default: m.AdminOverview,
  })),
);
const MediaMaintenancePage = lazy(() =>
  import("../features/admin/MediaMaintenancePage").then((m) => ({
    default: m.MediaMaintenancePage,
  })),
);

const PlatformAccessPage = lazy(() =>
  import('../features/platform/PlatformAccessPage').then((module) => ({
    default: module.PlatformAccessPage,
  })),
);

const RequirePlatformAccess = lazy(() =>
  import('../features/platform/RequirePlatformAccess').then((module) => ({
    default: module.RequirePlatformAccess,
  })),
);

const PlatformRestaurantsPage = lazy(() =>
  import('../features/platform/PlatformRestaurantsPage').then((module) => ({
    default: module.PlatformRestaurantsPage,
  })),
);

const PlatformBackupsPage = lazy(() =>
  import('../features/platform/PlatformBackupsPage').then((module) => ({ default: module.PlatformBackupsPage })),
);
const PlatformDeletionPage = lazy(() =>
  import('../features/platform/PlatformDeletionPage').then((module) => ({ default: module.PlatformDeletionPage })),
);

const StaffManagementPage = lazy(() =>
  import('../features/admin/StaffManagementPage').then(m => ({ default: m.StaffManagementPage })),
);
const StaffInvitationPage = lazy(() =>
  import('../features/auth/StaffInvitationPage').then(m => ({ default: m.StaffInvitationPage })),
);

function RestaurantRoot() {
  const { restaurantSlug = "" } = useParams();
  return (
    <RestaurantProvider key={restaurantSlug} slug={restaurantSlug}>
      <Outlet />
    </RestaurantProvider>
  );
}

function PublicMenuLayout() {
  const { restaurantSlug = "" } = useParams();
  return (
    <PublicMenuProvider key={restaurantSlug} restaurantSlug={restaurantSlug}>
      <RestaurantLayout />
    </PublicMenuProvider>
  );
}

function RestaurantLayout() {
  const table = useTableContext();
  const tableQuery =
    table.status === "unverified" ? `?mesa=${table.tableNumber}` : "";
  const { restaurant } = useRestaurant();
  const location = useLocation();
  useEffect(() => {
    document.title = restaurant
      ? `${restaurant.name} · Cardápio`
      : "Restaurante não encontrado";
  }, [restaurant]);

  const theme = {
    "--brand": restaurant.theme.primary,
    "--page": restaurant.theme.background,
    "--ink": restaurant.theme.text,
  } as CSSProperties;
  const isExplore = location.pathname.split("/")[2] === "explorar";
  const isProduct = location.pathname.split("/")[2] === "produto";
  if (isExplore) {
    return (
      <div className="restaurant explore-viewport" style={theme}>
        <a href="#content" className="skip-link">Pular para o feed</a>
        <main id="content" className="explore-main">
          <Suspense fallback={<div className="shell py-8 text-center"><p role="status" className="text-xs opacity-60">Carregando feed…</p></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    );
  }
  if (isProduct) {
    return (
      <div className="restaurant product-viewport" style={theme}>
        <a href="#content" className="skip-link">Pular para o produto</a>
        <main id="content" className="product-main">
          <Suspense fallback={<div className="shell py-8 text-center"><p role="status" className="text-xs opacity-60">Carregando produto…</p></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    );
  }
  if (location.pathname.split("/")[2] === "admin")
    return (
      <div className="restaurant" style={theme}>
        <Suspense
          fallback={
            <p className="shell py-8" role="status">
              Carregando administração…
            </p>
          }
        >
          <Outlet />
        </Suspense>
      </div>
    );
  const isEquipe = location.pathname.split("/")[2] === "equipe";
  return (
    <div className="restaurant public-site" style={theme}>
      <a href="#content" className="skip-link">
        Pular para o conteúdo
      </a>
      <div className="shell">
        {!isProduct && (
          <>
            <header className="public-header">
              <Link
                to={isEquipe ? `/${restaurant.slug}/equipe` : `/${restaurant.slug}${tableQuery}`}
                aria-label={`${restaurant.name}, início`}
                className="wordmark"
              >
                {restaurant.logo ? (
                  <img
                    src={restaurant.logo.url}
                    className="public-logo"
                    alt={restaurant.name}
                  />
                ) : (
                  <>
                    {restaurant.name}
                    <span>{restaurant.subtitle}</span>
                  </>
                )}
              </Link>
              {!isEquipe && (
                <span className="badge public-table-badge">
                  {table.status === "unverified"
                    ? `Mesa ${table.tableNumber}`
                    : table.status === "invalid"
                      ? "Mesa inválida"
                      : "Consulta sem mesa"}
                </span>
              )}
            </header>
            {isEquipe ? (
              <nav className="tabs public-tabs" aria-label="Navegação da equipe">
                <NavLink end to={`/${restaurant.slug}/equipe`}>
                  Atendimento
                </NavLink>
                <NavLink to={`/${restaurant.slug}/equipe/historico`}>
                  Histórico
                </NavLink>
                <NavLink to={`/${restaurant.slug}/equipe/perfil`}>
                  Perfil
                </NavLink>
              </nav>
            ) : (
              <nav className="tabs public-tabs" aria-label="Modo de visualização">
                <NavLink end to={`/${restaurant.slug}${tableQuery}`}>
                  Home
                </NavLink>
                <NavLink to={`/${restaurant.slug}/cardapio${tableQuery}`}>
                  Cardápio
                </NavLink>
                <NavLink to={`/${restaurant.slug}/explorar${tableQuery}`}>
                  Explorar
                </NavLink>
              </nav>
            )}
          </>
        )}
        <main id="content" className={`public-main ${isProduct ? 'product-main' : ''}`}>
          <Suspense
            fallback={
              <div className="py-6 text-center">
                <p role="status" className="text-xs text-[var(--ink)] opacity-60">
                  {isEquipe ? 'Carregando equipe…' : 'Carregando…'}
                </p>
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
function Access() {
  return (
    <Suspense
      fallback={
        <div className="shell py-8 text-center">
          <p role="status" className="text-xs opacity-60">Carregando acesso…</p>
        </div>
      }
    >
      <AccessPage />
    </Suspense>
  );
}
function NotFound() {
  return (
    <main className="shell py-8">
      <h1>Página não encontrada</h1>
      <p>Confira o endereço do restaurante.</p>
      <Link to="/">Voltar ao início</Link>
    </main>
  );
}
function Start() {
  return (
    <main className="shell py-8">
      <span className="eyebrow">Cardápio Digital</span>
      <h1>Bem-vindo</h1>
      <p>
        Acesse o endereço ou escaneie o QR Code do seu restaurante para
        consultar o cardápio.
      </p>
    </main>
  );
}
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Start />} />
      <Route path="convite" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando convite…</p>}><StaffInvitationPage /></Suspense>} />
      <Route
        path="plataforma"
        element={
          <Suspense
            fallback={
              <main className="shell py-10">
                <p role="status">Carregando Elozi…</p>
              </main>
            }
          >
            <Outlet />
          </Suspense>
        }
      >
        <Route path="acesso" element={<PlatformAccessPage />} />

        <Route element={<RequirePlatformAccess />}>
          <Route index element={<PlatformRestaurantsPage />} />
          <Route path="restaurantes/:restaurantId/backups" element={<PlatformBackupsPage />} />
          <Route path="restaurantes/:restaurantId/excluir" element={<PlatformDeletionPage />} />
          <Route
            path="restaurantes"
            element={<PlatformRestaurantsPage />}
          />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path=":restaurantSlug" element={<RestaurantRoot />}>
        <Route element={<PublicMenuLayout />}>
          <Route index element={<HomePage />} />
          <Route path="cardapio" element={<MenuPage />} />
          <Route path="comanda" element={<TabOrdersPage />} />

          <Route path="produto/:productId/comentarios" element={<ProductCommentsPage />} />
          <Route path="produto/:productSlug" element={<ProductPage />} />
          <Route path="explorar" element={<ExplorePage />} />
        </Route>
        <Route element={<RestaurantLayout />}>
          <Route path="acesso" element={<Access />} />
          <Route element={<RequireStaffAccess />}>
            <Route path="equipe" element={<StaffServicePage />} />
            <Route path="equipe/historico" element={<StaffHistoryPage />} />
            <Route path="equipe/perfil" element={<StaffProfilePage />} />
          </Route>

          <Route element={<RequireStaffAccess requiredRole="admin" />}>
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<AdminOverview />} />
              <Route path="catalogo" element={<AdminCatalogPage />} />
              <Route path="comentarios" element={<AdminCommentsPage />} />
              <Route path="identidade" element={<IdentityPage />} />
              <Route path="mesas" element={<TablesPage />} />
              <Route path="midias" element={<MediaMaintenancePage />} />
              <Route path="equipe" element={<StaffManagementPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
