import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { getStaffAccess } from '../auth/staffAuth';
import { createInvite, getTeam, revokeInvite, transferVisits, updateMember, type StaffRole, type TeamMember, type TeamState } from './staffManagement';
export function StaffManagementPage() {
    const { restaurantSlug = '' } = useParams();
    return <TeamContent key={restaurantSlug} slug={restaurantSlug}/>;
}
function TeamContent({ slug }: {
    slug: string;
}) {
    const navigate = useNavigate();
    const alive = useRef(false);
    const acting = useRef(false);
    const [team, setTeam] = useState<TeamState>({ members: [], invitations: [] });
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<StaffRole>('waiter');
    const [link, setLink] = useState('');
    useEffect(() => { alive.current = true; let disposed = false; void getTeam(slug).then(data => { if (!disposed)
        setTeam(data); }).catch(e => { if (!disposed)
        setError(e.message); }).finally(() => { if (!disposed)
        setLoading(false); }); return () => { disposed = true; alive.current = false; }; }, [slug]);
    async function run(action: () => Promise<unknown>, success: string) {
        if (acting.current)
            return;
        acting.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await action();
            if (!alive.current)
                return;
            const access = await getStaffAccess(slug);
            if (!access || access.role !== 'admin') {
                navigate(`/${slug}/acesso`, { replace: true });
                return;
            }
            const state = await getTeam(slug);
            if (alive.current) {
                setTeam(state);
                setNotice(success);
            }
        }
        catch (e) {
            if (alive.current)
                setError(e instanceof Error ? e.message : 'Não foi possível concluir. Atualize a lista antes de repetir.');
        }
        finally {
            acting.current = false;
            if (alive.current)
                setBusy(false);
        }
    }
    return <div className="admin-stack"><header className="admin-page-heading"><div><p className="admin-breadcrumb">Administração</p><h1>Equipe e acessos</h1><p>Contas individuais para administradores e garçons.</p></div><button className="admin-button" disabled={busy || loading} onClick={() => void run(async () => { }, 'Equipe atualizada.')}>Atualizar</button></header>
 {error && <p role="alert" className="admin-alert error">{error}</p>}{notice && <p role="status" className="admin-alert success">{notice}</p>}
 <section className="admin-card admin-form"><h2>Convidar funcionário</h2><p className="admin-help">Gere um link e envie pessoalmente ao destinatário. O convite vale por 48 horas e exige entrar com o e-mail informado.</p>
 <form onSubmit={e => { e.preventDefault(); void run(async () => { const url = await createInvite(slug, email.trim(), role); if (alive.current) {
        setLink(url);
        setEmail('');
    } }, 'Convite criado. Copie o link e envie ao funcionário.'); }} className="mt-4">
 <fieldset disabled={busy || loading} className="space-y-4"><label htmlFor="team-email">E-mail<input id="team-email" type="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)}/></label>
 <label htmlFor="team-role">Perfil<select id="team-role" value={role} onChange={e => setRole(e.target.value as StaffRole)}><option value="waiter">Garçom</option><option value="admin">Administrador</option></select></label>
 <button className="admin-button primary" type="submit">Gerar convite</button></fieldset></form>
 {link && <div className="mt-4 space-y-3"><label htmlFor="invite-link">Link individual<input id="invite-link" readOnly value={link} onFocus={e => e.target.select()}/></label><button type="button" className="admin-button" onClick={() => void (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject(new Error('Clipboard unavailable'))).then(() => setNotice('Link copiado.')).catch(() => setError('Selecione o link e copie manualmente.'))}>Copiar link</button><p className="admin-help">O link completo só aparece agora. Se perder, revogue o convite e gere outro.</p></div>}
 </section>
 <section><h2 className="text-xl font-semibold">Funcionários</h2>{loading ? <p role="status">Carregando equipe…</p> : <ul className="mt-4 space-y-3">{team.members.map(m => <MemberRow key={`${m.id}:${m.role}:${m.active}`} member={m} members={team.members} busy={busy} save={(r, a) => run(() => updateMember(slug, m, r, a), 'Vínculo atualizado.')} transfer={to => run(() => transferVisits(slug, m.id, to), 'Atendimentos transferidos. Peça à equipe para atualizar a lista de mesas.')}/>)}</ul>}</section>
 <section><h2 className="text-xl font-semibold">Convites</h2><ul className="mt-4 space-y-3">{team.invitations.map(i => <li key={i.id} className="admin-card"><strong>{i.email}</strong><p className="text-sm">{i.role === 'admin' ? 'Administrador' : 'Garçom'} · {{ pending: 'Pendente', accepted: 'Aceito', revoked: 'Revogado', expired: 'Vencido' }[i.status]}</p><p className="text-sm">Validade: {new Date(i.expiresAt).toLocaleString('pt-BR')}</p>{i.status === 'pending' && <button className="admin-button mt-3" disabled={busy} onClick={() => void run(() => revokeInvite(slug, i.id), 'Convite revogado.')}>Revogar convite</button>}</li>)}</ul>{!loading && !team.invitations.length && <p>Nenhum convite registrado.</p>}</section>
 </div>;
}
function MemberRow({ member: m, members, busy, save, transfer }: {
    member: TeamMember;
    members: TeamMember[];
    busy: boolean;
    save: (role: StaffRole, active: boolean) => Promise<void>;
    transfer: (to: string) => Promise<void>;
}) {
    const [role, setRole] = useState(m.role);
    const [to, setTo] = useState('');
    return <li className="admin-card admin-form space-y-3"><strong>{m.email || 'Conta sem e-mail'}</strong><p>{m.active ? 'Ativo' : 'Desativado'} · {m.openVisits} atendimento(s) aberto(s)</p>
 <label htmlFor={`member-${m.id}`}>Perfil<select id={`member-${m.id}`} disabled={busy} value={role} onChange={e => setRole(e.target.value as StaffRole)}><option value="waiter">Garçom</option><option value="admin">Administrador</option></select></label>
 <div className="flex flex-wrap gap-3"><button className="admin-button" disabled={busy || role === m.role} onClick={() => { if (window.confirm(`Alterar o perfil de ${m.email} para ${role === 'admin' ? 'administrador' : 'garçom'}?`))
        void save(role, m.active); }}>Salvar perfil</button>
 <button className="admin-button" disabled={busy} onClick={() => { if (window.confirm(`${m.active ? 'Desativar' : 'Reativar'} o acesso de ${m.email} neste restaurante?`))
        void save(m.role, !m.active); }}>{m.active ? 'Desativar acesso' : 'Reativar acesso'}</button></div>
 {m.openVisits > 0 && <div className="space-y-3 border-t border-black/10 pt-3"><label htmlFor={`transfer-${m.id}`}>Transferir todos os atendimentos abertos para<select id={`transfer-${m.id}`} value={to} disabled={busy} onChange={e => setTo(e.target.value)}><option value="">Selecione outro funcionário</option>{members.filter(v => v.active && v.id !== m.id).map(v => <option key={v.id} value={v.id}>{v.email}</option>)}</select></label><button className="admin-button" disabled={busy || !to} onClick={() => { if (window.confirm(`Transferir os ${m.openVisits} atendimentos para o funcionário selecionado?`))
        void transfer(to); }}>Transferir atendimentos</button></div>}
 </li>;
}
