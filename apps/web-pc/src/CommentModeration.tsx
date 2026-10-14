import React, { useEffect, useState } from 'react';
import { accountRequest, accountError } from './account';
import { useI18n, MessageKey } from './i18n';

type Series = { id: string; title: string | null; comments: number; reports: number };
type Episode = { id: string; number: number | null; title: string; removed: boolean };
type Comment = { id: string; author: string; body: string; status: 'visible'|'hidden'|'deleted'; seriesTitle: string | null; episodeNumber: number | null; reports: number; created_at: number };
type Report = { series: { id: string; title: string | null }; episodes: Episode[]; items: Comment[]; hasMore: boolean };
const statuses: Record<Comment['status'],MessageKey> = {visible:'可见',hidden:'已隐藏',deleted:'已删除'};

export default function CommentModeration() {
  const { t, localizeError, formatDate } = useI18n();
  const [seriesId,setSeriesId]=useState(''), [episodeId,setEpisodeId]=useState('');
  const [series,setSeries]=useState<Series[]>([]), [report,setReport]=useState<Report|null>(null);
  const [query,setQuery]=useState(''), [search,setSearch]=useState(''), [page,setPage]=useState(1);
  const [hasMore,setHasMore]=useState(false), [loading,setLoading]=useState(true), [busy,setBusy]=useState(false), [error,setError]=useState(''), [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true; setLoading(true); setError('');
    const route=seriesId ? `comments?seriesId=${encodeURIComponent(seriesId)}&episodeId=${encodeURIComponent(episodeId)}&page=${page}` : `comment-series?q=${encodeURIComponent(search)}&page=${page}`;
    accountRequest(`/api/admin/${route}`).then(data=>{
      if (!active) return;
      if (seriesId) setReport(data); else setSeries(data.items);
      setHasMore(data.hasMore);
    }).catch(error=>{if(active)setError(accountError(error));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[seriesId,episodeId,search,page,revision]);
  const refresh=()=>setRevision(value=>value+1);
  const back=()=>{setSeriesId('');setEpisodeId('');setReport(null);setPage(1);setHasMore(false);};
  const moderate=async(id:string,status:Comment['status'])=>{
    if(busy)return;
    setBusy(true);setError('');
    try { await accountRequest(`/api/admin/comments/${id}`,{status}); refresh(); }
    catch(error){setError(accountError(error));}
    finally{setBusy(false);}
  };
  return <section className="admin-panel admin-moderation">
    <div className="admin-panel-title"><h2>{t('评论管理')}</h2><button disabled={loading||busy} onClick={refresh}>{t('刷新')}</button></div>
    <nav className="analytics-breadcrumb" aria-label={t('内容层级')}><button disabled={!seriesId||busy} onClick={back}>{t('剧列表')}</button>{seriesId&&report&&<><span>›</span><strong dir="auto">{report.series.title || t('剧名暂不可用')}</strong>{episodeId&&<><span>›</span><span>{report.episodes.find(episode=>episode.id===episodeId)?.number ? t('第{{number}}集',{number:report.episodes.find(episode=>episode.id===episodeId)!.number!}) : t('集数暂不可用')}</span></>}</>}</nav>
    {!seriesId&&<><p className="analytics-note">{t('选择短剧后按集审核评论')}</p><form className="admin-search" onSubmit={event=>{event.preventDefault();setPage(1);setSearch(query.trim());refresh();}}><input aria-label={t('搜索剧名')} placeholder={t('搜索剧名')} maxLength={200} value={query} onChange={event=>setQuery(event.target.value)}/><button disabled={busy}>{t('搜索')}</button></form></>}
    {seriesId&&report&&<label>{t('选择分集')}<select disabled={busy} value={episodeId} onChange={event=>{setEpisodeId(event.target.value);setPage(1);setHasMore(false);}}><option value="">{t('全部分集')}</option>{report.episodes.map(episode=><option key={episode.id} value={episode.id}>{episode.number ? t('第{{number}}集',{number:episode.number}) : t('集数暂不可用')}{episode.removed ? ` · ${t('已移除分集')}` : ''}</option>)}</select></label>}
    {error&&<p role="alert" className="account-error">{localizeError(error)} <button disabled={loading||busy} onClick={refresh}>{t('重试')}</button></p>}
    {loading ? <p role="status">{t('加载中...')}</p> : !error&&<>
      {!seriesId&&(!series.length ? <p>{t('没有匹配的短剧')}</p> : series.map(row=><button className="admin-series-row" key={row.id} disabled={busy} onClick={()=>{setReport(null);setSeriesId(row.id);setEpisodeId('');setPage(1);setHasMore(false);}}><span><strong dir="auto">{row.title || t('剧名暂不可用')}</strong><small>{t('评论数量：{{count}}',{count:row.comments})} · {t('举报数量：{{count}}',{count:row.reports})}</small></span></button>))}
      {seriesId&&report&&(!report.items.length ? <p>{t('当前范围暂无评论')}</p> : report.items.map(row=><article className="admin-comment-row" key={row.id}><div className="admin-comment-context"><strong dir="auto">{row.seriesTitle || t('剧名暂不可用')}</strong><span>{row.episodeNumber ? t('第{{number}}集',{number:row.episodeNumber}) : t('集数暂不可用')}</span></div><small>{row.author} · {formatDate(row.created_at,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small><p dir="auto">{row.body}</p><small>{t(statuses[row.status])} · {t('举报数量：{{count}}',{count:row.reports})}</small><div>{(Object.keys(statuses) as Comment['status'][]).map(status=><button key={status} disabled={busy||loading||row.status===status} onClick={()=>void moderate(row.id,status)}>{t(statuses[status])}</button>)}</div></article>))}
    </>}
    <nav className="admin-pagination"><button disabled={loading||busy||page<=1} onClick={()=>setPage(value=>value-1)}>{t('上一页')}</button><span>{t('第{{number}}页',{number:page})}</span><button disabled={loading||busy||!!error||!hasMore} onClick={()=>setPage(value=>value+1)}>{t('下一页')}</button></nav>
  </section>;
}
