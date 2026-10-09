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
import { ProductPage } from "../features/menu/ProductPage";
import { ExplorePage } from "../features/explore/ExplorePage";
import { useTableContext } from "../features/tables/useTableContext";
import { AccessPage } from "../features/auth/AccessPage";
import { RequireStaffAccess } from "../features/auth/RequireStaffAccess";
import { StaffServicePage } from "../features/service/StaffServicePage";
const AdminCatalogPage = lazy(() =>
  import("../features/admin/AdminCatalogPage").then((m) => ({
    default: m.AdminCatalogPage,
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

function RestaurantRoot() {
  const { restaurantSlug = "" } = useParams();
  return (
    <RestaurantProvider key={restaurantSlug} slug={restaurantSlug}>
      <RestaurantLayout />
    </RestaurantProvider>
  );
}

function PublicMenuLayout() {
  const { restaurantSlug = "" } = useParams();
  return (
    <PublicMenuProvider key={restaurantSlug} restaurantSlug={restaurantSlug}>
      <Outlet />
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
  return (
    <div className="restaurant" style={theme}>
      <a href="#content" className="skip-link">
        Pular para o conteúdo
      </a>
      <div className="shell">
        <header className="flex items-center justify-between gap-4 py-7">
          <Link
            to={`/${restaurant.slug}${tableQuery}`}
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
          <span className="badge">
            {table.status === "unverified"
              ? `Mesa ${table.tableNumber}`
              : table.status === "invalid"
                ? "Mesa inválida"
                : "Consulta sem mesa"}
          </span>
        </header>
        {restaurant.cover && (
          <img
            src={restaurant.cover.url}
            alt={`Ambiente de ${restaurant.name}`}
            className="public-cover"
            decoding="async"
          />
        )}
        <nav className="tabs" aria-label="Modo de visualização">
          <NavLink end to={`/${restaurant.slug}${tableQuery}`}>
            Cardápio
          </NavLink>
          <NavLink to={`/${restaurant.slug}/explorar${tableQuery}`}>
            Explorar
          </NavLink>
        </nav>
        <main id="content" className="py-8">
          <Outlet />
        </main>
        <footer className="py-6">
          <strong>{restaurant.name}</strong>
          {restaurant.description && <p>{restaurant.description}</p>}
          {restaurant.address && <p>{restaurant.address}</p>}
          {restaurant.phone && <p>{restaurant.phone}</p>}
          {restaurant.openingHours && (
            <p className="whitespace-pre-line">{restaurant.openingHours}</p>
          )}
          <Link to={`/${restaurant.slug}/acesso`}>Acesso da equipe</Link>
        </footer>
      </div>
    </div>
  );
}
function Access() {
  return <AccessPage />;
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
          <Route
            path="restaurantes"
            element={<PlatformRestaurantsPage />}
          />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path=":restaurantSlug" element={<RestaurantRoot />}>
        <Route element={<PublicMenuLayout />}>
          <Route index element={<MenuPage />} />

          <Route path="produto/:productSlug" element={<ProductPage />} />
          <Route path="explorar" element={<ExplorePage />} />
        </Route>
        <Route path="acesso" element={<Access />} />
        <Route element={<RequireStaffAccess />}>
          <Route path="equipe/*" element={<StaffServicePage />} />
        </Route>

        <Route element={<RequireStaffAccess requiredRole="admin" />}>
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<AdminOverview />} />
            <Route path="catalogo" element={<AdminCatalogPage />} />
            <Route path="identidade" element={<IdentityPage />} />
            <Route path="mesas" element={<TablesPage />} />
            <Route path="midias" element={<MediaMaintenancePage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
