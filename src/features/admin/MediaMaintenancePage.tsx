import { useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useRestaurant } from "../restaurants/RestaurantProvider";
export function MediaMaintenancePage() {
  const { restaurant: r } = useRestaurant();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    marked: number;
    retained: number;
    deleted: number;
    failed: number;
  } | null>(null);
  const pending = useRef(false);
  async function run() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke(
        "cleanup-menu-media",
        { body: { slug: r.slug } },
      );
      if (error) {
        let message =
          "Não foi possível executar. Confira a publicação da função e ADMIN_ALLOWED_ORIGINS.";
        if ("context" in error && error.context instanceof Response) {
          try {
            const body = await error.context.json();
            if (typeof body.error === "string") message = body.error;
          } catch {}
        }
        throw new Error(message);
      }
      if (
        !data ||
        !["marked", "retained", "deleted", "failed"].every(
          (k) => Number.isSafeInteger(data[k]) && data[k] >= 0,
        )
      )
        throw new Error("Resposta de limpeza inválida.");
      setResult(data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Limpeza indisponível.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="admin-stack">
      <header className="admin-page-heading">
        <div>
          <p className="admin-breadcrumb">Configurações / Mídias</p>
          <h1>Armazenamento</h1>
          <p>Limpeza segura de fotos e vídeos sem referência.</p>
        </div>
      </header>
      <section className="admin-card">
        <h2>Arquivos sem uso</h2>
        <p>
          Esta rotina verifica produtos, logo e capa do restaurante, incluindo
          produtos indisponíveis e categorias ocultas.
        </p>
        <p>
          Na primeira detecção, o arquivo entra em retenção por sete dias.
          Depois desse prazo, uma nova execução remove os arquivos que continuam
          sem referência. Arquivos reutilizados durante a retenção são
          preservados.
        </p>
        <p className="admin-help">
          Até 200 novos arquivos são identificados e até 25 arquivos são
          removidos por execução. Se houver falha, a próxima execução retoma as
          reservas pendentes.
        </p>
        <button
          className="admin-button primary"
          type="button"
          disabled={busy}
          onClick={() => void run()}
        >
          {busy ? "Verificando arquivos…" : "Executar verificação e limpeza"}
        </button>
      </section>
      {error && (
        <p role="alert" className="admin-alert error">
          {error}
        </p>
      )}
      {result && (
        <section role="status" className="admin-card">
          <h2>Resultado</h2>
          <p>
            {result.marked} novos arquivos sem uso · {result.retained} em
            retenção · {result.deleted} removidos · {result.failed} falhas a
            tentar novamente.
          </p>
          <p className="admin-help">
            Uma verificação inicial normalmente apenas registra os arquivos para
            retenção.
          </p>
        </section>
      )}
    </div>
  );
}
