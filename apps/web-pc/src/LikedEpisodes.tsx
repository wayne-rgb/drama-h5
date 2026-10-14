import React, { useEffect, useState } from 'react';
import { Heart, Play, ThumbsUp } from 'lucide-react';
import { accountError, accountRequest } from './account';
import { useI18n } from './i18n';
import { Series } from './types';

type LikedEpisode = { episodeId: string; series: Series | null; episodeNumber: number | null; available: boolean; createdAt: number };
type LikePage = { count: number; items: LikedEpisode[]; next: string | null };
export const notifyLikesChanged = () => window.dispatchEvent(new Event('episode-likes-changed'));

export function useLikeCount(accountId: string | undefined, page: string) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let active = true, sequence = 0;
    setCount(accountId ? null : 0);
    if (!accountId) return;
    const refresh = () => { const current = ++sequence; void accountRequest<{ count: number }>('/api/me/likes?summary=1').then(data => { if (active && current === sequence) setCount(data.count); }).catch(() => { if (active && current === sequence) setCount(null); }); };
    const visible = () => { if (!document.hidden) refresh(); };
    refresh(); window.addEventListener('episode-likes-changed',refresh); document.addEventListener('visibilitychange',visible);
    return () => { active = false; window.removeEventListener('episode-likes-changed',refresh); document.removeEventListener('visibilitychange',visible); };
  }, [accountId,page]);
  return count;
}

export function LikedEpisodes({ loggedIn, onLogin, onPlay }: { loggedIn: boolean; onLogin: () => void; onPlay: (series: Series, episodeId: string) => void }) {
  const { t, localizeError, formatDate } = useI18n();
  const [items,setItems] = useState<LikedEpisode[]>([]), [next,setNext] = useState<string | null>(null);
  const [loading,setLoading] = useState(true), [error,setError] = useState(''), [removing,setRemoving] = useState('');
  const load = async (cursor?: string) => {
    setLoading(true); setError('');
    try { const data = await accountRequest<LikePage>(`/api/me/likes${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`); setItems(current => cursor ? [...current,...data.items.filter(item => !current.some(row => row.episodeId === item.episodeId))] : data.items); setNext(data.next); }
    catch (error) { setError(accountError(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (loggedIn) void load(); else setLoading(false); }, [loggedIn]);
  if (!loggedIn) return <div className="account-liked-empty"><ThumbsUp size={32}/><p>{t('登录后查看点赞的剧集')}</p><button className="account-primary" onClick={onLogin}>{t('登录')}</button></div>;
  return <section className="account-liked" aria-label={t('我的点赞')}>
    {error && <div className="account-error" role="alert">{localizeError(error)} <button disabled={loading} onClick={() => void load()}>{t('重试')}</button></div>}
    {!loading && !error && !items.length && !next && <div className="account-liked-empty"><ThumbsUp size={32}/><p>{t('还没有点赞的剧集')}</p></div>}
    <div className="account-liked-list">{items.map(item => <article key={item.episodeId}>
      <button className="account-liked-play" disabled={!item.available || !item.series} onClick={() => item.series && onPlay(item.series,item.episodeId)}>
        <span className="account-liked-cover">{item.series?.cover ? <img src={item.series.cover} alt="" onError={event => { event.currentTarget.hidden = true; }}/> : <Play size={22}/>}</span>
        <span><strong dir="auto">{item.series?.title || t('剧集信息暂不可用')}</strong><small>{item.episodeNumber ? t('第{{number}}集',{number:item.episodeNumber}) : t('剧集信息暂不可用')}</small><small>{item.available ? formatDate(item.createdAt,{month:'short',day:'numeric'}) : t('内容暂不可播放')}</small></span>
        {item.available && <Play size={18}/>} 
      </button>
      <button className="account-unlike" disabled={!!removing} aria-label={t('取消点赞')} onClick={() => { setRemoving(item.episodeId); setError(''); void accountRequest(`/api/me/likes/${item.episodeId}`,{}).then(() => { setItems(current => current.filter(row => row.episodeId !== item.episodeId)); notifyLikesChanged(); }).catch(error => setError(accountError(error))).finally(() => setRemoving('')); }}><Heart size={21} fill="currentColor"/></button>
    </article>)}</div>
    {loading && <p role="status">{t('加载中...')}</p>}
    {next && <button className="account-text-button" disabled={loading} onClick={() => void load(next)}>{t('加载更多')}</button>}
  </section>;
}
