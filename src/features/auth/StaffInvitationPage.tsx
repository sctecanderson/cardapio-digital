import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { acceptInvite } from '../admin/staffManagement';
export function StaffInvitationPage() {
    const [params] = useSearchParams();
    const token = params.get('token') || '';
    return <Invitation key={token} token={token}/>;
}
function Invitation({ token }: {
    token: string;
}) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [mode, setMode] = useState<'login' | 'signup'>('login');
    const [account, setAccount] = useState<string | null>(null);
    const [checking, setChecking] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [slug, setSlug] = useState('');
    const acting = useRef(false);
    useEffect(() => {
        let disposed = false;
        void supabase.auth.getSession().then(({ data }) => { if (!disposed) {
            setAccount(data.session && !data.session.user.is_anonymous ? data.session.user.email || null : null);
            setChecking(false);
        } }).catch(() => { if (!disposed) {
            setError('Não foi possível verificar a conta. Recarregue a página.');
            setChecking(false);
        } });
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => { if (!disposed) {
            setAccount(session && !session.user.is_anonymous ? session.user.email || null : null);
            setChecking(false);
        } });
        return () => { disposed = true; subscription.unsubscribe(); };
    }, []);
    async function run(action: () => Promise<void>) { if (acting.current)
        return; acting.current = true; setBusy(true); setError(''); setNotice(''); try {
        await action();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Não foi possível continuar.');
    }
    finally {
        acting.current = false;
        setBusy(false);
        setPassword('');
    } }
    if (!/^[0-9a-f]{64}$/.test(token))
        return <main className="shell py-10"><h1>Convite inválido</h1><p>Peça ao administrador o link completo.</p></main>;
    return <main className="mx-auto max-w-lg space-y-5 px-4 py-10"><h1 className="text-3xl font-semibold">Convite para a equipe</h1><p>Entre com o e-mail informado ao administrador para aceitar o acesso ao restaurante.</p>
 {error && <p role="alert" className="admin-alert error">{error}</p>}{notice && <p role="status" className="admin-alert success">{notice}</p>}
 {slug ? <section className="admin-card"><h2 className="font-semibold">Convite aceito</h2><Link to={`/${slug}/acesso`} className="admin-button primary mt-4">Abrir acesso da equipe</Link></section> : checking ? <p role="status">Verificando conta…</p> : account ? <section className="admin-card space-y-4"><p>Conta: <strong>{account}</strong></p><button disabled={busy} className="admin-button primary" onClick={() => void run(async () => { const result = await acceptInvite(token); setSlug(result.slug); })}>Aceitar convite</button><button disabled={busy} className="admin-button" onClick={() => void run(async () => { const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error)
            throw new Error('Não foi possível sair.'); })}>Usar outra conta</button></section> : <section className="admin-card admin-form">
 <div className="flex gap-3 mb-4"><button className="admin-button" disabled={busy} aria-pressed={mode === 'login'} onClick={() => setMode('login')}>Já tenho conta</button><button className="admin-button" disabled={busy} aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>Criar conta</button></div>
 <form onSubmit={e => {
                e.preventDefault();
                void run(async () => {
                    if (mode === 'signup') {
                        const redirect = new URL('/convite', window.location.origin);
                        redirect.searchParams.set('token', token);
                        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirect.toString() } });
                        if (error)
                            throw new Error('Não foi possível criar a conta. Confira os dados e tente novamente. Se já possui conta, use “Já tenho conta”.');
                        setNotice(data.session ? 'Conta criada. Aceite o convite para continuar.' : 'Confira seu e-mail e confirme a conta. Depois volte a este convite e entre.');
                    }
                    else {
                        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
                        if (error)
                            throw new Error('Confira e-mail e senha. Se criou a conta agora, confirme o e-mail primeiro.');
                    }
                });
            }}><fieldset disabled={busy} className="space-y-4"><label htmlFor="inv-email">E-mail<input id="inv-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)}/></label><label htmlFor="inv-password">Senha<input id="inv-password" type="password" required minLength={mode === 'signup' ? 10 : 1} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)}/></label>{mode === 'signup' && <p className="admin-help">Use pelo menos 10 caracteres. Não compartilhe sua senha com o administrador.</p>}<button type="submit" className="admin-button primary">{busy ? 'Aguarde…' : mode === 'signup' ? 'Criar minha conta' : 'Entrar'}</button></fieldset></form>
 </section>}
 </main>;
}
