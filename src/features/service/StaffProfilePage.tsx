import { useEffect, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { signOutStaff } from '../auth/staffAuth';
import { supabase } from '../../lib/supabase';

export function StaffProfilePage() {
    const { restaurantSlug = '' } = useParams();
    const access = useOutletContext<StaffAccess>();
    const navigate = useNavigate();

    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        supabase.auth.getUser().then(({ data }) => {
            if (data?.user?.email) {
                setEmail(data.user.email);
            }
        });
    }, []);

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

            <div className="rounded-2xl border border-[#ece4d8] bg-white p-6 shadow-sm space-y-4">
                <div>
                    <span className="block text-xs font-semibold uppercase tracking-wider text-[#8c7867]">
                        E-mail de Acesso
                    </span>
                    <strong className="mt-1 block text-base font-semibold text-[var(--ink,#2b1d17)]">
                        {email || 'Carregando…'}
                    </strong>
                </div>

                <div className="border-t border-[#f0eae0] pt-4">
                    <span className="block text-xs font-semibold uppercase tracking-wider text-[#8c7867]">
                        Cargo / Função
                    </span>
                    <div className="mt-1 inline-flex items-center gap-2 rounded-full bg-[#f4eee5] px-3 py-1 text-xs font-bold text-[#655446]">
                        {access.role === 'admin' ? 'Administrador' : 'Garçom / Atendimento'}
                    </div>
                </div>

                <div className="border-t border-[#f0eae0] pt-6">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleLogout()}
                        className="w-full min-h-12 rounded-xl border border-red-700/30 bg-red-50 text-sm font-bold text-red-700 hover:bg-red-100 disabled:opacity-50 transition-colors"
                    >
                        {busy ? 'Saindo…' : 'Sair da conta (Logout)'}
                    </button>
                </div>
            </div>
        </section>
    );
}
