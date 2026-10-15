import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Language, languages, MessageKey, useI18n } from './i18n';
import { accountError } from './account';
import './account.css';
import './admin.css';
import './team.css';

export type TeamRole = 'owner' | 'editor' | 'moderator' | 'analyst';
export type PendingTeamMember = { code: string };
export type TeamMember = { id: string; code: string; roles: TeamRole[]; enabled: boolean; createdAt: number; seriesIds: string[]; series: { id: string; title: string }[] };
export type TeamSession = { initialized: boolean; bootstrapAvailable: boolean; member: TeamMember | PendingTeamMember | null; verified: boolean; mfaEnabled: boolean };
export const roleLabels: Record<TeamRole, MessageKey> = { owner: '负责人', editor: '内容运营', moderator: '评论审核', analyst: '数据查看' };
export const hasTeamRole = (member: TeamMember, role: TeamRole) => member.roles.includes('owner') || member.roles.includes(role);
export async function teamRequest(path: string, body?: unknown) {
  return (await axios.request({ url: `/api/team/${path}`, method: body === undefined ? 'GET' : 'POST', data: body, timeout: 20000 }).catch(error=>{
    if(error.response?.status===401 && path!=='login')window.dispatchEvent(new Event('team-session-changed'));
    throw error;
  })).data;
}
export async function teamLogout() { await teamRequest('logout', {}); window.dispatchEvent(new Event('team-session-changed')); }

export function TeamGate({ children }: { children: (session: TeamSession & { member: TeamMember }) => React.ReactNode }) {
  const { t, language, setLanguage, localizeError } = useI18n();
  const [session, setSession] = useState<TeamSession | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [invite,setInvite] = useState(() => { const value = new URLSearchParams(window.location.hash.slice(1)).get('team-invite') || ''; if (value) history.replaceState(null, '', window.location.pathname + window.location.search); return value; });
  const [mode, setMode] = useState<'login' | 'recover'>('login'), [code, setCode] = useState(''), [password, setPassword] = useState(''), [token, setToken] = useState(''), [verification, setVerification] = useState('');
  const [setup, setSetup] = useState<{ secret: string; token: string } | null>(null), [recovery, setRecovery] = useState<string[]>([]);
  const refresh = async () => { const value = await teamRequest('session'); setSession(value); return value; };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (error) { setError(accountError(error)); } finally { setBusy(false); } };
  useEffect(() => {
    const update = () => { void refresh().catch(error => setError(accountError(error))); };
    update(); const timer = window.setInterval(update, 30000);
    window.addEventListener('focus', update); window.addEventListener('team-session-changed', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); window.removeEventListener('team-session-changed', update); };
  }, []);
  useEffect(() => {
    if (!recovery.length) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [recovery.length]);
  const login = async () => {
    if (!session?.initialized) await teamRequest('bootstrap', { token, password });
    else if (invite && !session.member) { await teamRequest('join', { token: invite, password }); setInvite(''); }
    else if (mode === 'recover') await teamRequest('recover', { code, recoveryCode: verification.trim(), password });
    else await teamRequest('login', { code, password });
    setPassword(''); setToken(''); setVerification(''); setSetup(null); await refresh();
  };
  if (session?.member && session.verified && !recovery.length) return <>{children(session as TeamSession & { member: TeamMember })}</>;
  return <main className="admin-login team-login"><div className="team-language"><select aria-label={t('界面语言')} value={language} onChange={event => setLanguage(event.target.value as Language)}>{languages.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div><h1>{t('团队工作台')}</h1>
    {error && <p role="alert" className="account-error">{localizeError(error)}</p>}
    {!session ? <><p role="status">{t('加载中...')}</p><button disabled={busy} onClick={() => void run(async () => { await refresh(); })}>{t('重试')}</button></> : recovery.length ? <><h2>{t('保存一次性恢复码')}</h2><p>{t('恢复码仅显示一次，请保存在安全位置；每个只能使用一次')}</p><p>{t('团队账号')}：<bdi>{session.member?.code}</bdi></p><div className="team-recovery">{recovery.map(value => <code key={value}>{value}</code>)}</div><button onClick={() => setRecovery([])}>{t('已保存恢复码')}</button></> : session.member ? <>
      <p>{t('团队账号')}：<bdi>{session.member.code}</bdi></p>
      {!session.mfaEnabled ? <><h2>{t('设置二次验证')}</h2><p>{t('请保存团队账号，并绑定验证器后进入工作台')}</p>{!setup ? <button disabled={busy} onClick={() => void run(async () => setSetup(await teamRequest('mfa/setup', {})))}>{t('设置二次验证')}</button> : <form onSubmit={event => { event.preventDefault(); void run(async () => { const data = await teamRequest('mfa/enable', { token: setup.token, code: verification.trim() }); setRecovery(data.recoveryCodes); setSetup(null); setVerification(''); await refresh(); }); }}><p>{t('在验证器中添加账户，输入下方密钥，再填写生成的六位动态码')}</p><code className="team-secret" dir="ltr">{setup.secret}</code><label>{t('六位动态码')}<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={verification} onChange={event => setVerification(event.target.value)}/></label><button disabled={busy}>{t('确认启用')}</button></form>}</> : <form onSubmit={event => { event.preventDefault(); void run(async () => { await teamRequest('mfa/verify', { code: verification.trim() }); setVerification(''); await refresh(); }); }}><label>{t('动态码或恢复码')}<input required autoComplete="one-time-code" value={verification} onChange={event => setVerification(event.target.value)}/></label><button disabled={busy}>{t('验证并继续')}</button></form>}
      <button disabled={busy} onClick={() => void run(async () => { await teamLogout(); setSetup(null); setVerification(''); await refresh(); })}>{t('退出登录')}</button>
    </> : !session.initialized && !session.bootstrapAvailable ? <p>{t('团队尚未开放，请联系部署负责人配置初始化凭证')}</p> : <form onSubmit={event => { event.preventDefault(); void run(login); }}>
      <h2>{t(!session.initialized ? '创建团队负责人' : invite ? '加入团队' : mode === 'recover' ? '找回团队密码' : '团队登录')}</h2>
      {!session.initialized ? <label>{t('初始化凭证')}<input type="password" required autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label> : !invite && <label>{t('团队账号')}<input required autoComplete="username" spellCheck={false} dir="ltr" value={code} onChange={event => setCode(event.target.value)}/></label>}
      {!invite && session.initialized && mode === 'recover' && <label>{t('恢复码')}<input required autoComplete="off" value={verification} onChange={event => setVerification(event.target.value)}/></label>}
      <label>{t(mode === 'recover' || invite || !session.initialized ? '设置登录密码' : '密码')}<input type="password" required minLength={12} maxLength={256} autoComplete={mode === 'recover' || invite || !session.initialized ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)}/></label><p>{t('密码需为12至256个字符')}</p>
      <button disabled={busy}>{t(!session.initialized ? '创建团队负责人' : invite ? '加入团队' : mode === 'recover' ? '重设密码' : '登录')}</button>
      {session.initialized && !invite && <button type="button" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'recover' : 'login'); setError(''); setPassword(''); setVerification(''); }}>{t(mode === 'login' ? '找回团队密码' : '返回登录')}</button>}
      {invite && <button type="button" disabled={busy} onClick={()=>{setInvite('');setError('');setPassword('');}}>{t('返回登录')}</button>}
    </form>}
    <a href="/">{t('返回产品')}</a>
  </main>;
}

export function TeamSecurity({ member }: { member: TeamMember }) {
  const { t, localizeError } = useI18n(); const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <section className="admin-panel"><h2>{t('账户安全')}</h2><p>{t('团队账号')}：<bdi>{member.code}</bdi></p><p>{t('二次验证已启用')}</p><p>{t('凭证全部丢失时，请联系负责人撤销旧成员并重新邀请')}</p>{error && <p role="alert">{localizeError(error)}</p>}<button disabled={busy} onClick={async () => { setBusy(true); try { await teamRequest('sessions/revoke', {}); window.dispatchEvent(new Event('team-session-changed')); } catch (error) { setError(accountError(error)); } finally { setBusy(false); } }}>{t('退出全部团队会话')}</button></section>;
}
