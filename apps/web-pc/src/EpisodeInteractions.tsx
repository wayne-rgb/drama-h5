import React, { useEffect, useRef, useState } from 'react';
import { Heart, MessageCircle, Share2, X, Crown, ArrowLeft, Layers, Copy } from 'lucide-react';
import { accountRequest, AccountSession, accountError } from './account';
import { useI18n } from './i18n';
import { PlayerSideAction } from './mobile-prototype/PlayerActions';
import { playbackLocation } from './playback-location';
import './interactions.css';
import { notifyLikesChanged } from './LikedEpisodes';

type Social = { liked: boolean; likes: number; comments: number };
type Comment = { id: string; body: string; author: string; own: boolean; createdAt: number };
export function EpisodeInteractions({ seriesId, episodeId, title, session, onLogin }: { seriesId: string; episodeId: string; title: string; session: AccountSession | null; onLogin: () => void }) {
  const { t, localizeError, formatDate } = useI18n();
  const [social, setSocial] = useState<Social | null>(null), [open, setOpen] = useState(false), [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]), [next, setNext] = useState<string | null>(null), [body, setBody] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), shareDialog = useRef<HTMLDialogElement>(null);
  const path = `/api/episodes/${episodeId}`, params = `?seriesId=${encodeURIComponent(seriesId)}`;
  const url = playbackLocation(`${window.location.origin}/`, seriesId, episodeId);
  const refresh = () => accountRequest<Social>(`${path}/interactions${params}`).then(setSocial);
  useEffect(() => { let active = true; accountRequest<Social>(`${path}/interactions${params}`).then(data => { if (active) setSocial(data); }).catch(() => { if (active) setSocial(null); }); return () => { active = false; }; }, [episodeId, seriesId, session?.user?.id]);
  useEffect(() => { const element = dialog.current; if (open && element && !element.open) element.showModal(); if (!open && element?.open) element.close(); }, [open]);
  useEffect(() => { const element = shareDialog.current; if (sharing && element && !element.open) element.showModal(); if (!sharing && element?.open) element.close(); }, [sharing]);
  const load = async (before?: string) => { setLoading(true); try { const data = await accountRequest<{ items: Comment[]; next: string | null }>(`${path}/comments${params}${before ? `&before=${encodeURIComponent(before)}` : ''}`); setComments(current => before ? [...current,...data.items] : data.items); setNext(data.next); setError(''); } catch(error) { setError(accountError(error)); } finally { setLoading(false); } };
  const action = async (operation: () => Promise<void>) => { if (busy) return; if (!session?.user) { setOpen(false); onLogin(); return; } setBusy(true); setError(''); try { await operation(); } catch(error) { setError(accountError(error)); } finally { setBusy(false); } };
  return <div className="episode-interactions" data-gesture-exclude onClick={event => event.stopPropagation()}>
    <PlayerSideAction disabled={busy || !social} active={!!social?.liked} icon={<Heart size={27} fill={social?.liked ? 'currentColor' : 'none'} />} label={String(social?.likes ?? '—')} ariaLabel={social ? `${t('点赞')} ${social.likes}` : t('点赞')} onClick={() => void action(async () => { setSocial(await accountRequest<Social>(`${path}/likes${params}`, { liked: !social?.liked })); notifyLikesChanged(); })} />
    <PlayerSideAction icon={<MessageCircle size={27} />} label={String(social?.comments ?? '—')} ariaLabel={social ? `${t('评论')} ${social.comments}` : t('评论')} onClick={() => { setOpen(true); void load(); }} />
    <PlayerSideAction icon={<Share2 size={26} />} label={t('分享')} onClick={() => { setCopied(false); setSharing(true); setError(''); }} />
    {error && !open && !sharing && <span role="alert" className="social-inline-error">{localizeError(error)}</span>}
    <dialog ref={dialog} className="social-dialog" aria-label={t('评论')} onCancel={event => { event.preventDefault(); setOpen(false); }}>
      <header><strong>{t('评论')} · {social?.comments ?? '—'}</strong><button aria-label={t('关闭')} onClick={() => setOpen(false)}><X size={21} /></button></header>
      <div className="social-comments">
        {error && <p role="alert">{localizeError(error)}<button onClick={() => void load()}>{t('重试')}</button></p>}
        {!loading && !error && !comments.length && <p>{t('还没有评论，来聊聊这一集')}</p>}
        {comments.map(comment => <article key={comment.id}><span className="comment-avatar">{Array.from(comment.author)[0]}</span><div><strong dir="auto">{comment.author}</strong><p dir="auto">{comment.body}</p><small>{formatDate(comment.createdAt,{month:'short',day:'numeric'})}</small><button disabled={busy} onClick={() => void action(async () => { if (comment.own) { await fetch(`/api/comments/${comment.id}`,{method:'DELETE',credentials:'same-origin'}).then(async response => { if(!response.ok) throw {response:{data:await response.json()}}; }); await load(); await refresh(); } else { await accountRequest(`/api/comments/${comment.id}/report`,{}); setError('举报已提交'); } })}>{t(comment.own ? '删除评论' : '举报')}</button></div></article>)}
        {loading && <p role="status">{t('加载中...')}</p>}{next && <button disabled={loading} onClick={() => void load(next)}>{t('加载更多')}</button>}
      </div>
      <form onSubmit={event => { event.preventDefault(); void action(async () => { await accountRequest(`${path}/comments${params}`,{body}); setBody(''); await load(); await refresh(); }); }}><textarea aria-label={t('写评论')} placeholder={t(session?.user ? '写评论' : '登录后发表评论')} readOnly={!session?.user} value={body} maxLength={1000} onChange={event => setBody(event.target.value)} /><button disabled={busy || !!session?.user && !body.trim()}>{t(session?.user ? '发布' : '登录')}</button></form>
    </dialog>
    <dialog ref={shareDialog} className="social-dialog share-dialog" aria-label={t('分享')} onCancel={event => { event.preventDefault(); setSharing(false); }}><header><strong>{t('分享')}</strong><button aria-label={t('关闭')} onClick={() => setSharing(false)}><X size={21} /></button></header><p dir="auto">{title}</p><input aria-label={t('分享链接')} value={url} readOnly onFocus={event => event.target.select()} /><button className="account-primary" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setError('请长按复制链接'))}><Copy size={16}/>{t(copied ? '链接已复制' : '复制链接')}</button>{typeof navigator.share === 'function' && <button className="account-text-button" onClick={() => void navigator.share({title,url}).catch(error => { if(error.name!=='AbortError') setError('操作失败，请稍后重试'); })}>{t('系统分享')}</button>}{error && <p role="status">{localizeError(error)}</p>}</dialog>
  </div>;
}

export function VipGate({ cover, onSubscribe, onBack, onEpisodes, loading, number }: { cover: string; onSubscribe: () => void; onBack?: () => void; onEpisodes?: () => void; loading?: boolean; number?: number }) {
  const { t } = useI18n();
  return <div className="vip-gate" style={{backgroundImage:`linear-gradient(#090b14b8,#090b14f0),url(${cover})`}}>
    {onBack && <button className="vip-gate-back" aria-label={t('返回')} onClick={onBack}><ArrowLeft size={22}/></button>}
    {number && <span className="vip-gate-episode">{t('第{{number}}集',{number})}</span>}
    <Crown size={42}/><h3>{t('VIP专享剧集')}</h3><p>{t('前3集免费，开通VIP继续观看')}</p><button className="account-primary" disabled={loading} onClick={onSubscribe}>{t(loading ? '账户加载中...' : '查看会员套餐')}</button>{onEpisodes && <button className="account-text-button" onClick={onEpisodes}><Layers size={16}/>{t('选集')}</button>}
  </div>;
}
