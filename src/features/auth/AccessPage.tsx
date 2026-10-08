import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import { supabase } from "../../lib/supabase";
import {
  getStaffAccess,
  signInStaff,
  signOutStaff,
  type StaffAccess,
} from "./staffAuth";

export function AccessPage() {
  const { restaurantSlug = "" } = useParams();

  return <StaffLogin key={restaurantSlug} restaurantSlug={restaurantSlug} />;
}

function StaffLogin({ restaurantSlug }: { restaurantSlug: string }) {
  const { restaurant } = useRestaurant();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [access, setAccess] = useState<StaffAccess | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function restoreAccess() {
      try {
        const { data, error: sessionError } = await supabase.auth.getSession();

        if (sessionError) {
          throw new Error(
            "Não foi possível verificar sua sessão. Tente novamente.",
          );
        }

        if (!data.session) return;

        const staffAccess = await getStaffAccess(restaurantSlug);

        if (cancelled) return;

        if (staffAccess) {
          setAccess(staffAccess);
        } else {
          setError("Sua conta não possui acesso ativo a este restaurante.");
        }
      } catch (cause) {
        if (cancelled) return;

        setError(
          cause instanceof Error
            ? cause.message
            : "Não foi possível verificar seu acesso.",
        );
      } finally {
        if (!cancelled) {
          setCheckingSession(false);
        }
      }
    }

    void restoreAccess();

    return () => {
      cancelled = true;
    };
  }, [restaurantSlug]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (busy) return;

    setBusy(true);
    setError("");

    try {
      const staffAccess = await signInStaff(email, password, restaurantSlug);

      setPassword("");

      if (!staffAccess) {
        setError("Sua conta não possui acesso ativo a este restaurante.");
        return;
      }

      setAccess(staffAccess);
    } catch (cause) {
      setPassword("");
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível entrar. Tente novamente.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    if (busy) return;

    setBusy(true);
    setError("");

    try {
      await signOutStaff();
      setAccess(null);
      setPassword("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível sair. Tente novamente.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="staff-access-title"
      className="mx-auto max-w-md rounded-2xl border border-current/15 bg-white p-6"
    >
      <h1 id="staff-access-title" className="text-2xl font-bold">
        Acesso da equipe
      </h1>

      <p className="mt-2 text-sm">{restaurant?.name ?? "Restaurante"}</p>

      {error && (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-red-700 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      {checkingSession ? (
        <p role="status" className="mt-6">
          Verificando acesso…
        </p>
      ) : access ? (
        <div className="mt-6">
          <p role="status" className="font-semibold">
            Acesso autorizado.
          </p>

          <p className="mt-2 text-sm">
            Perfil: {access.role === "admin" ? "Administrador" : "Garçom"}
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              to={`/${restaurantSlug}/equipe`}
              className="inline-flex min-h-11 items-center rounded-xl border border-current px-4 py-2 font-medium"
            >
              Atendimento
            </Link>
            {access.role === "admin" && (
              <Link
                to={`/${restaurantSlug}/admin`}
                className="inline-flex min-h-11 items-center rounded-xl bg-[var(--brand)] px-4 py-2 font-medium text-white"
              >
                Administrar catálogo
              </Link>
            )}
          </div>

          <button
            type="button"
            onClick={() => void handleSignOut()}
            disabled={busy}
            className="mt-6 min-h-11 w-full rounded-xl border border-current px-4 py-3 font-semibold disabled:opacity-60"
          >
            {busy ? "Saindo…" : "Sair"}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} aria-busy={busy} className="mt-6">
          <fieldset disabled={busy} className="space-y-5">
            <legend className="sr-only">Credenciais da equipe</legend>

            <div>
              <label
                htmlFor="staff-email"
                className="block text-sm font-semibold"
              >
                E-mail
              </label>

              <input
                id="staff-email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-xl border border-current/30 bg-white px-4 py-3 text-base"
              />
            </div>

            <div>
              <label
                htmlFor="staff-password"
                className="block text-sm font-semibold"
              >
                Senha
              </label>

              <input
                id="staff-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-2 min-h-11 w-full rounded-xl border border-current/30 bg-white px-4 py-3 text-base"
              />
            </div>

            <button
              type="submit"
              className="min-h-11 w-full rounded-xl bg-[var(--brand)] px-4 py-3 font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Entrando…" : "Entrar"}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
