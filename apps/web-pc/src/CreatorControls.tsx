import React, { useEffect, useState } from 'react';
import { Account, accountError, accountRequest } from './account';
import { useI18n } from './i18n';
import './analytics.css';

export function CreatorAccessControl({ user, onChanged }: { user: Account; onChanged: () => void }) {
  const { t, localizeError } = useI18n();
  const [enabled, setEnabled] = useState(!!user.creator), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setEnabled(!!user.creator); setError(''); }, [user.id, user.creator]);
  return <div className="analytics-owner"><strong>{t('创作者')}</strong><p>{user.email}</p><button type="button" disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try { await accountRequest('/api/admin/creators', { accountId: user.id, enabled: !enabled }); setEnabled(!enabled); onChanged(); }
    catch (error) { setError(accountError(error)); }
    finally { setBusy(false); }
  }}>{t(enabled ? '撤销创作者权限' : '授予创作者权限')}</button>{error && <p role="alert">{localizeError(error)}</p>}</div>;
}
export function SeriesCreatorControl({ seriesId, creatorId, onChanged }: { seriesId: string; creatorId: string | null; onChanged: (data: any) => void }) {
  const { t, localizeError } = useI18n();
  const [creators, setCreators] = useState<Account[]>([]), [assigned,setAssigned]=useState<Account|null>(null), [loading,setLoading]=useState(true), [selected, setSelected] = useState(creatorId || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setSelected(creatorId || ''); }, [seriesId, creatorId]);
  useEffect(() => {
    let active = true;setLoading(true);setAssigned(null);setError('');
    accountRequest(`/api/admin/creators?seriesId=${encodeURIComponent(seriesId)}`).then(data => { if (active) {setCreators(data.items);setAssigned(data.assignedCreator);} }).catch(error => { if (active) setError(accountError(error)); }).finally(()=>{if(active)setLoading(false);});
    return () => { active = false; };
  }, [seriesId,creatorId]);
  return <div className="analytics-owner"><label>{t('作品归属')}<select disabled={loading||busy} value={selected} onChange={event => setSelected(event.target.value)}><option value="">{t('未分配创作者')}</option>{creatorId && !creators.some(user => user.id === creatorId) && <option value={creatorId}>{loading ? t('加载中...') : assigned ? `${assigned.name} · ${assigned.email} · ${t('创作者权限已撤销')}` : t('创作者资料暂不可用')}</option>}{creators.map(user => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}</select></label><button type="button" disabled={loading||busy || selected === (creatorId || '')} onClick={async () => {
    setBusy(true); setError('');
    try { onChanged(await accountRequest(`/api/admin/series/${seriesId}/creator`, { creatorId: selected || null })); }
    catch (error) { setError(accountError(error)); }
    finally { setBusy(false); }
  }}>{t('设置短剧创作者')}</button>{error && <p role="alert">{localizeError(error)}</p>}</div>;
}
