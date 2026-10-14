import React, { useState } from 'react';
import { accountError, changeAccount } from './account';
import { useAccountSession } from './AccountArea';
import { Language, languages, useI18n } from './i18n';
import AnalyticsDashboard from './AnalyticsDashboard';
import './admin.css';

export default function CreatorApp() {
  const account = useAccountSession(), { t, language, setLanguage, localizeError } = useI18n();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); try { await action(); } catch (error) { setError(accountError(error)); } finally { setBusy(false); } };
  if (!account.session) return <main className="admin-login"><p role={account.error ? 'alert' : 'status'}>{account.error ? localizeError(account.error) : t('加载中...')}</p><button onClick={account.refresh}>{t('重试')}</button></main>;
  if (!account.session.user) return <main className="admin-login"><h1>{t('创作者工作台')}</h1><form onSubmit={event => { event.preventDefault(); void run(() => changeAccount('/api/auth/login', { email, password }, '/creator')); }}><label>{t('邮箱')}<input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)}/></label><label>{t('密码')}<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}/></label><button disabled={busy}>{t('登录')}</button>{error && <p role="alert">{localizeError(error)}</p>}</form><a href="/">{t('返回产品')}</a></main>;
  return <main className="admin-shell creator-shell"><header className="admin-header"><h1>{t('创作者工作台')}</h1><span>{account.session.user.name}</span><select aria-label={t('界面语言')} value={language} onChange={event => setLanguage(event.target.value as Language)}>{languages.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><a href="/">{t('返回产品')}</a><button disabled={busy} onClick={() => void run(() => changeAccount('/api/auth/logout', {}, '/creator'))}>{t('退出登录')}</button></header>{error && <p role="alert">{localizeError(error)}</p>}{account.session.capabilities.creator || account.session.capabilities.admin ? <AnalyticsDashboard/> : <section className="admin-panel"><h2>{t('需要创作者权限')}</h2><p>{t('请联系管理员分配作品')}</p></section>}</main>;
}
