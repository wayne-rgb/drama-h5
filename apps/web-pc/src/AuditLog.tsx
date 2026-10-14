import React, { useEffect, useState } from 'react';
import { accountRequest, accountError } from './account';
import { useI18n, MessageKey } from './i18n';

type Series = { id:string;title:string|null;count:number };
type Episode = { id:string;number:number|null;title:string;removed:boolean };
type Target = { seriesTitle:string|null;number:number|null;title:string };
type Entry = { id:string;action:string;createdAt:number;actorName:string|null;actorEmail:string|null;targets:Target[];filename:string|null;kind:string|null;order:{number:number;title:string}[];accountName:string|null;accountEmail:string|null;creatorName:string|null;creatorEmail:string|null;creatorAssigned:boolean|null;status:string|null;reason:string|null;periodEnd:number|null };
type Report = {series:{id:string;title:string|null}|null;episodes:Episode[];items:Entry[];hasMore:boolean};
const statusKeys:Record<string,MessageKey>={visible:'可见',hidden:'已隐藏',deleted:'已删除'};

export default function AuditLog() {
  const { t,localizeLabel,localizeError,formatDate }=useI18n();
  const [scope,setScope]=useState<'content'|'platform'>('content'),[seriesId,setSeriesId]=useState(''),[episodeId,setEpisodeId]=useState(''),[unassigned,setUnassigned]=useState(false);
  const [series,setSeries]=useState<Series[]>([]),[report,setReport]=useState<Report|null>(null),[orphanCount,setOrphanCount]=useState(0);
  const [query,setQuery]=useState(''),[search,setSearch]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[hasMore,setHasMore]=useState(false);
  const root=scope==='content'&&!seriesId&&!unassigned;
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    const params=new URLSearchParams({scope,seriesId,episodeId,unassigned:unassigned?'1':'0',q:search,page:String(page)});
    accountRequest(`/api/admin/${root?'audit-series':'audit'}?${params}`).then(data=>{
      if(!active)return;
      if(root){setSeries(data.items);setOrphanCount(data.unassigned);}else setReport(data);
      setHasMore(data.hasMore);
    }).catch(error=>{if(active)setError(accountError(error));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[scope,seriesId,episodeId,unassigned,search,page,revision,root]);
  const refresh=()=>setRevision(value=>value+1);
  const reset=()=>{setSeriesId('');setEpisodeId('');setUnassigned(false);setReport(null);setPage(1);setHasMore(false);};
  const targetGroups=(targets:Target[])=>{
    const groups=new Map<string,Set<number>>();
    for(const target of targets){const name=target.seriesTitle || t('剧名暂不可用');if(!groups.has(name))groups.set(name,new Set());if(target.number)groups.get(name)!.add(target.number);}
    return [...groups].map(([name,numbers])=><div key={name} className="admin-comment-context"><strong dir="auto">{name}</strong><span>{[...numbers].map(number=>t('第{{number}}集',{number})).join(' · ')}</span></div>);
  };
  return <section className="admin-panel admin-audit">
    <div className="admin-panel-title"><h2>{t('操作记录')}</h2><button disabled={loading} onClick={refresh}>{t('刷新')}</button></div>
    <div className="admin-audit-scopes"><button aria-pressed={scope==='content'} onClick={()=>{setScope('content');reset();}}>{t('内容操作记录')}</button><button aria-pressed={scope==='platform'} onClick={()=>{setScope('platform');reset();}}>{t('账户与权限记录')}</button></div>
    {scope==='content'&&<nav className="analytics-breadcrumb" aria-label={t('内容层级')}><button disabled={root} onClick={reset}>{t('剧列表')}</button>{seriesId&&report?.series&&<><span>›</span><strong dir="auto">{report.series.title || t('剧名暂不可用')}</strong>{episodeId&&<><span>›</span><span>{report.episodes.find(episode=>episode.id===episodeId)?.number ? t('第{{number}}集',{number:report.episodes.find(episode=>episode.id===episodeId)!.number!}) : t('集数暂不可用')}</span></>}</>}{unassigned&&<><span>›</span><strong>{t('未关联作品')}</strong></>}</nav>}
    {root&&<><p className="analytics-note">{t('选择短剧后按集查看操作记录')}</p><form className="admin-search" onSubmit={event=>{event.preventDefault();setSearch(query.trim());setPage(1);refresh();}}><input aria-label={t('搜索剧名')} placeholder={t('搜索剧名')} maxLength={200} value={query} onChange={event=>setQuery(event.target.value)}/><button>{t('搜索')}</button></form></>}
    {seriesId&&report&&<label>{t('选择分集')}<select value={episodeId} onChange={event=>{setEpisodeId(event.target.value);setPage(1);setHasMore(false);}}><option value="">{t('全部分集')}</option>{report.episodes.map(episode=><option key={episode.id} value={episode.id}>{episode.number ? t('第{{number}}集',{number:episode.number}) : t('集数暂不可用')}{episode.removed?` · ${t('已移除分集')}`:''}</option>)}</select></label>}
    {unassigned&&<p className="analytics-note">{t('未关联操作记录说明')}</p>}
    {seriesId&&<p className="analytics-note">{t('历史操作名称说明')}</p>}
    {error&&<p role="alert" className="account-error">{localizeError(error)} <button disabled={loading} onClick={refresh}>{t('重试')}</button></p>}
    {loading ? <p role="status">{t('加载中...')}</p> : !error&&<>
      {root&&<>{!series.length&&(!orphanCount||!!search||page!==1)&&<p>{t('没有匹配的短剧')}</p>}{series.map(row=><button className="admin-series-row" key={row.id} onClick={()=>{setSeriesId(row.id);setEpisodeId('');setReport(null);setPage(1);setHasMore(false);}}><span><strong dir="auto">{row.title || t('剧名暂不可用')}</strong><small>{t('操作数量：{{count}}',{count:row.count})}</small></span></button>)}{orphanCount>0&&page===1&&!search&&<button className="admin-series-row" onClick={()=>{setUnassigned(true);setReport(null);setPage(1);setHasMore(false);}}><span><strong>{t('未关联作品')}</strong><small>{t('操作数量：{{count}}',{count:orphanCount})}</small></span></button>}</>}
      {!root&&report&&<>{!report.items.length&&<p>{t('当前范围暂无操作记录')}</p>}{report.items.map(row=><article className="admin-comment-row" key={row.id}><h3>{localizeLabel(row.action)}</h3>{targetGroups(row.targets)}{!row.targets.length&&scope==='content'&&<p>{t('未关联作品')}</p>}{row.accountName||row.accountEmail?<p dir="auto">{row.accountName} {row.accountEmail}</p>:scope==='platform'&&<p>{t('账户资料暂不可用')}</p>}<small>{t('操作人')}：<bdi>{row.actorName || t('账户资料暂不可用')}{row.actorEmail&&` · ${row.actorEmail}`}</bdi> · {formatDate(row.createdAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small>
        <dl className="admin-audit-details">{row.filename&&<><dt>{t(row.kind==='image'?'封面':row.kind==='video'?'视频':'文件名')}</dt><dd dir="auto">{row.filename}</dd></>}{row.order.length>0&&<><dt>{t('分集顺序')}</dt><dd>{row.order.map(episode=><div key={episode.number}>{t('第{{number}}集',{number:episode.number})}{episode.title&&episode.title!==`第${episode.number}集`&&<> · <bdi>{episode.title}</bdi></>}</div>)}</dd></>}{row.creatorAssigned!==null&&<><dt>{t('作品归属')}</dt><dd dir="auto">{row.creatorAssigned ? [row.creatorName,row.creatorEmail].filter(Boolean).join(' · ') || t('创作者资料暂不可用') : t('未分配创作者')}</dd></>}{row.status&&statusKeys[row.status]&&<><dt>{t('评论状态')}</dt><dd>{t(statusKeys[row.status])}</dd></>}{row.periodEnd&&<><dt>{t('有效期至')}</dt><dd>{formatDate(row.periodEnd,{year:'numeric',month:'short',day:'numeric'})}</dd></>}{row.reason&&<><dt>{t('操作原因')}</dt><dd dir="auto">{row.reason}</dd></>}</dl>
      </article>)}</>}
    </>}
    <nav className="admin-pagination"><button disabled={loading||page<=1} onClick={()=>setPage(value=>value-1)}>{t('上一页')}</button><span>{t('第{{number}}页',{number:page})}</span><button disabled={loading||!!error||!hasMore} onClick={()=>setPage(value=>value+1)}>{t('下一页')}</button></nav>
  </section>;
}
