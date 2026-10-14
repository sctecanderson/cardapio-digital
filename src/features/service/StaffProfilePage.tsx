import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { signOutStaff, updateStaffDisplayName } from '../auth/staffAuth';
import { supabase } from '../../lib/supabase';

export function StaffProfilePage() {
    const { restaurantSlug = '' } = useParams();
    const access = useOutletContext<StaffAccess>();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);

    // Estado do nome de atendimento
    const [displayName, setDisplayName] = useState(access.displayName || '');
    const [savingName, setSavingName] = useState(false);
    const [nameFeedback, setNameFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    useEffect(() => {
        supabase.auth.getUser().then(({ data }) => {
            if (data?.user?.email) {
                setEmail(data.user.email);
            }
        });

        if (access?.memberId) {
            supabase
                .from('restaurant_members')
                .select('display_name')
                .eq('id', access.memberId)
                .maybeSingle()
                .then(({ data }) => {
                    if (data?.display_name !== undefined && data?.display_name !== null) {
                        setDisplayName(data.display_name);
                    }
                });
        }
    }, [access?.memberId]);

    async function handleSaveDisplayName(e: React.FormEvent) {
        e.preventDefault();
        setNameFeedback(null);
        setSavingName(true);

        try {
            const updated = await updateStaffDisplayName(restaurantSlug, displayName);
            setDisplayName(updated || '');
            setNameFeedback({ type: 'success', message: 'Nome salvo com sucesso!' });
        } catch (err) {
            setNameFeedback({
                type: 'error',
                message: err instanceof Error ? err.message : 'Falha ao salvar nome.',
            });
        } finally {
            setSavingName(false);
        }
    }

    async function handleLogout() {
        setBusy(true);
        try {
            await signOutStaff();
            navigate(`/${restaurantSlug}/acesso`, { replace: true });
        } catch {
            setBusy(false);
        }
    }

    return (
        <section className="mx-auto max-w-xl pb-12">
            <div className="mb-6">
                <h1 className="text-xl font-bold text-[var(--ink,#2b1d17)]">
                    Perfil do Funcionário
                </h1>
                <p className="text-xs text-[#8c7867] mt-1">
                    Informações da sua conta na equipe.
                </p>
            </div>

            <div className="rounded-2xl border border-[#ece4d8] bg-white p-6 shadow-sm space-y-5">
                {/* E-mail de Acesso (com contraste alto garantido no tema escuro) */}
                <div>
                    <span className="block text-xs font-semibold uppercase tracking-wider text-[#8c7867]">
                        E-mail de Acesso
                    </span>
                    <strong className="mt-1 block text-base font-bold text-[#1c1917]">
                        {email || 'Carregando…'}
                    </strong>
                </div>

                {/* Cargo / Função */}
                <div className="border-t border-[#f0eae0] pt-4">
                    <span className="block text-xs font-semibold uppercase tracking-wider text-[#8c7867]">
                        Cargo / Função
                    </span>
                    <div className="mt-1 inline-flex items-center gap-2 rounded-full bg-[#f4eee5] px-3 py-1 text-xs font-bold text-[#655446]">
                        {access.role === 'admin' ? 'Administrador' : 'Garçom / Atendimento'}
                    </div>
                </div>

                {/* Nome de Atendimento (Visível para o Cliente) */}
                <div className="border-t border-[#f0eae0] pt-4">
                    <form onSubmit={handleSaveDisplayName} className="space-y-3">
                        <div>
                            <label
                                htmlFor="staff-display-name"
                                className="block text-xs font-semibold uppercase tracking-wider text-[#8c7867]"
                            >
                                Nome de Atendimento (Visível para o Cliente)
                            </label>
                            <p className="text-xs text-[#7a6655] mt-0.5">
                                Como você prefere ser identificado pelo cliente na mesa (ex: Anderson, Carlos).
                            </p>
                        </div>

                        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <input
                                id="staff-display-name"
                                type="text"
                                maxLength={40}
                                value={displayName}
                                onChange={(e) => setDisplayName(e.target.value)}
                                placeholder="Ex: Anderson"
                                className="flex-1 rounded-xl border border-[#ebdccb] bg-[#fffdfa] px-3.5 py-2.5 text-sm font-semibold text-[#1c1917] placeholder-[#a8998c] focus:border-[var(--brand,#b9472b)] focus:outline-none shadow-xs"
                            />
                            <button
                                type="submit"
                                disabled={savingName}
                                className="px-4 py-2.5 rounded-xl bg-[var(--brand,#b9472b)] text-white text-xs font-bold hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 cursor-pointer shadow-xs whitespace-nowrap"
                            >
                                {savingName ? 'Salvando…' : 'Salvar nome'}
                            </button>
                        </div>

                        {nameFeedback && (
                            <p
                                role={nameFeedback.type === 'error' ? 'alert' : 'status'}
                                className={`text-xs font-semibold mt-1 px-3 py-2 rounded-lg ${
                                    nameFeedback.type === 'success'
                                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                                        : 'bg-red-50 text-red-700 border border-red-200'
                                }`}
                            >
                                {nameFeedback.message}
                            </p>
                        )}
                    </form>
                </div>

                {/* Botão Sair da Conta */}
                <div className="border-t border-[#f0eae0] pt-6">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleLogout()}
                        className="w-full min-h-12 rounded-xl border border-red-700/30 bg-red-50 text-sm font-bold text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                        {busy ? 'Saindo…' : 'Sair da conta (Logout)'}
                    </button>
                </div>
            </div>
        </section>
    );
}
