import React, { useEffect, useState } from 'react';
import { accountError } from './account';
import { roleLabels, TeamMember, TeamRole, teamRequest } from './TeamAccess';
import { useI18n } from './i18n';

type Series = { id: string; title: string };
type Invite = { id: string; roles: TeamRole[]; expiresAt: number };
type Entry = { id: string; code: string; action: string; targetId: string; createdAt: number };
export default function TeamManagement({ current }: { current: TeamMember }) {
  const { t, localizeError, localizeLabel, formatDate } = useI18n();
  const [members, setMembers] = useState<TeamMember[]>([]), [invites, setInvites] = useState<Invite[]>([]), [selected, setSelected] = useState<TeamMember | null>(null);
  const [roles, setRoles] = useState<TeamRole[]>(['editor']), [seriesIds, setSeriesIds] = useState<string[]>([]), [enabled, setEnabled] = useState(true);
  const [series, setSeries] = useState<Series[]>([]), [titles, setTitles] = useState<Record<string, string>>({}), [query, setQuery] = useState(''), [search, setSearch] = useState(''), [seriesPage, setSeriesPage] = useState(1);
  const [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false), [events, setEvents] = useState<Entry[]>([]), [eventPage, setEventPage] = useState(1), [moreEvents, setMoreEvents] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [link, setLink] = useState(''), [saved, setSaved] = useState(false);
  const load = async () => {
    const [data, pending, records] = await Promise.all([teamRequest(`members?page=${page}`), teamRequest('invites'), teamRequest(`events?page=${eventPage}`)]);
    setMembers(data.items); setHasMore(data.hasMore); setInvites(pending.items); setEvents(records.items); setMoreEvents(records.hasMore);
  };
  useEffect(() => { let active = true; setLoading(true); setError(''); void load().catch(error => { if (active) setError(accountError(error)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [page, eventPage]);
  useEffect(() => {
    let active = true;
    teamRequest(`series?q=${encodeURIComponent(search)}&page=${seriesPage}`).then(data => { if (active) { setSeries(data.items); setTitles(current => ({ ...current, ...Object.fromEntries(data.items.map((row: Series) => [row.id, row.title])) })); } }).catch(error => { if (active) setError(accountError(error)); });
    return () => { active = false; };
  }, [search, seriesPage]);
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setSaved(false); try { await action(); } catch (error) { setError(accountError(error)); } finally { setBusy(false); } };
  const choose = (member: TeamMember | null) => { setSelected(member); setRoles(member?.roles || ['editor']); setSeriesIds(member?.seriesIds || []); setEnabled(member?.enabled ?? true); setSaved(false); setLink(''); setTitles(current => ({ ...current, ...Object.fromEntries((member?.series || []).map(row => [row.id, row.title])) })); };
  return <section className="admin-panel team-panel"><div className="admin-panel-title"><h2>{t('团队成员')}</h2><button disabled={busy} onClick={() => choose(null)}>{t('邀请成员')}</button><button disabled={busy} onClick={() => void run(load)}>{t('刷新')}</button></div>
    {error && <p role="alert" className="account-error">{localizeError(error)}</p>}{saved && <p role="status">{t('团队权限已保存，成员需要重新登录')}</p>}
    {loading ? <p role="status">{t('加载中...')}</p> : members.map(member => <div className="team-member-row" key={member.id}><code>{member.code}</code><span>{member.roles.map(role => t(roleLabels[role])).join(' · ')}</span><span>{t(member.enabled ? '已启用' : '已停用')}</span><button disabled={busy} onClick={() => choose(member)}>{t('编辑权限')}</button></div>)}
    <nav className="team-page-controls"><button disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>{t('上一页')}</button><span>{t('第{{number}}页', { number: page })}</span><button disabled={busy || !hasMore} onClick={() => setPage(page + 1)}>{t('下一页')}</button></nav>
    <form onSubmit={event => { event.preventDefault(); void run(async () => {
      if (selected) { const updated = await teamRequest(`members/${selected.id}`, { roles, seriesIds, enabled }); setSelected(updated); setSaved(true); }
      else { const data = await teamRequest('invites', { roles, seriesIds }); setLink(`${window.location.origin}/admin#team-invite=${data.token}`); }
      await load();
    }); }}><h3>{selected ? `${t('编辑权限')} · ${selected.code}` : t('邀请成员')}</h3>
      <fieldset disabled={busy}><legend>{t('团队角色')}</legend><div className="team-roles">{(Object.keys(roleLabels) as TeamRole[]).map(role => <label key={role}><input type="checkbox" checked={roles.includes(role)} disabled={selected?.id === current.id && role === 'owner'} onChange={event => setRoles(current => event.target.checked ? [...current, role] : current.filter(value => value !== role))}/>{t(roleLabels[role])}</label>)}</div></fieldset>
      {roles.includes('owner') ? <p>{t('负责人可以访问全部作品和团队设置')}</p> : <fieldset disabled={busy}><legend>{t('作品授权')}</legend><div className="admin-search"><input aria-label={t('搜索授权作品')} value={query} onChange={event => setQuery(event.target.value)}/><button type="button" onClick={() => { setSearch(query.trim()); setSeriesPage(1); }}>{t('搜索')}</button></div>
        <div className="team-scopes">{[...new Set([...seriesIds, ...series.map(row => row.id)])].map(id => <label key={id}><input type="checkbox" checked={seriesIds.includes(id)} onChange={event => setSeriesIds(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))}/><bdi>{titles[id] || id}</bdi></label>)}</div>
        {!series.length && <p>{t('没有匹配的短剧')}</p>}<nav className="team-page-controls"><button type="button" disabled={seriesPage <= 1} onClick={() => setSeriesPage(seriesPage - 1)}>{t('上一页')}</button><span>{t('第{{number}}页', { number: seriesPage })}</span><button type="button" disabled={series.length < 24} onClick={() => setSeriesPage(seriesPage + 1)}>{t('下一页')}</button></nav>
      </fieldset>}
      {selected && <label className="team-member-row"><input type="checkbox" disabled={busy || selected.id === current.id} checked={enabled} onChange={event => setEnabled(event.target.checked)}/>{t('启用成员')}</label>}
      <button disabled={busy || !roles.length}>{t(selected ? '保存权限' : '生成邀请链接')}</button>
    </form>
    {link && <div role="status"><p>{t('邀请链接仅显示一次，24小时内可使用一次')}</p><textarea className="team-invite-link" aria-label={t('邀请链接')} readOnly value={link} onFocus={event => event.target.select()}/><button disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(link); })}>{t('复制链接')}</button></div>}
    <h3>{t('待使用邀请')}</h3>{!invites.length && <p>{t('暂无待使用邀请')}</p>}{invites.map(invite => <div className="team-member-row" key={invite.id}><span>{invite.roles.map(role => t(roleLabels[role])).join(' · ')}</span><span>{formatDate(invite.expiresAt, { dateStyle: 'short', timeStyle: 'short' })}</span><button disabled={busy} onClick={() => void run(async () => { await teamRequest(`invites/${invite.id}/revoke`, {}); await load(); })}>{t('撤销邀请')}</button></div>)}
    <div className="team-events"><h3>{t('团队权限记录')}</h3>{events.map(entry => <article key={entry.id}><bdi>{entry.code}</bdi> · {localizeLabel(entry.action)} · {formatDate(entry.createdAt, { dateStyle: 'short', timeStyle: 'short' })}</article>)}<nav className="team-page-controls"><button disabled={busy || eventPage <= 1} onClick={() => setEventPage(eventPage - 1)}>{t('上一页')}</button><span>{t('第{{number}}页', { number: eventPage })}</span><button disabled={busy || !moreEvents} onClick={() => setEventPage(eventPage + 1)}>{t('下一页')}</button></nav></div>
  </section>;
}
