import React, { useEffect, useRef, useState } from 'react';
import { Film, Users, MessageSquare, History, Menu, X, BarChart3, ShieldCheck } from 'lucide-react';
import axios from 'axios';
import { Account, accountRequest, accountError } from './account';
import { TeamGate, TeamMember, TeamSecurity, hasTeamRole, teamLogout } from './TeamAccess';
import TeamManagement from './TeamManagement';
import { useI18n, languages, MessageKey, Language } from './i18n';
import { Detail, CategoryTag } from './types';
import { api } from './api';
import AdminUploadQueue from './AdminUploadQueue';
import AnalyticsDashboard from './AnalyticsDashboard';
import CommentModeration from './CommentModeration';
import AuditLog from './AuditLog';
import './account.css';
import './admin.css';

type Asset = { id: string; name: string; kind: string; size: number; offset: number; status: string; error?: string; owner_id: string; series_id?:string; hls?: { status: string; size: number; error?: string; manifest?: { levels: { key: string }[] } } };
type AdminDetail = Omit<Detail, 'episodes'> & { language: string; status: string; coverId: string | null; categoryIds?: string[]; assets?: Asset[]; episodes: (Detail['episodes'][number] & { assetId: string })[] };
const adminRequest = (route: string, body?: unknown) => accountRequest(`/api/admin/${route}`,body);
export default function AdminApp() {
  return <TeamGate>{session => <AdminWorkspace key={session.member.id} member={session.member}/>}</TeamGate>;
}
function AdminWorkspace({ member: teamMember }: { member: TeamMember }) {
  const { t, localizeLabel, localizeError, formatDate, language, setLanguage } = useI18n();
  const owner=teamMember.roles.includes('owner'), canEdit=hasTeamRole(teamMember,'editor');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [tab,setTab] = useState<'series'|'accounts'|'comments'|'audit'|'analytics'|'security'|'team'>(canEdit?'series':hasTeamRole(teamMember,'moderator')?'comments':'analytics');
  const [analyticsSeriesId,setAnalyticsSeriesId] = useState('');
  const [sidebarOpen,setSidebarOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeSidebar = () => { setSidebarOpen(false); menuButton.current?.focus(); };
  useEffect(()=>{
    if(!sidebarOpen)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')closeSidebar();};
    document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);
  },[sidebarOpen]);
  const [page,setPage] = useState(1), [pageSize,setPageSize] = useState(0);
  const [loading,setLoading] = useState(true);
  const [series,setSeries] = useState<AdminDetail[]>([]), [selected,setSelected] = useState<AdminDetail|null>(null), [assets,setAssets] = useState<Asset[]>([]);
  const [uploadingSeries,setUploadingSeries] = useState<string[]>([]);
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const uploaded=(data:AdminDetail)=>{
    if(data.assets)rememberAssets(data.assets);
    setSeries(rows=>rows.map(row=>row.id===data.id?data:row));
    if(selectedRef.current?.id===data.id){setSelected(data);setCoverId(data.coverId||'');setNumber(Math.max(0,...data.episodes.map(ep=>ep.number))+1);}
  };
  const [accounts,setAccounts] = useState<Account[]>([]), [query,setQuery] = useState('');
  const [title,setTitle] = useState(''), [description,setDescription] = useState(''), [tags,setTags] = useState(''), [contentType,setContentType] = useState('real-drama'), [contentLanguage,setContentLanguage] = useState('en'), [coverId,setCoverId] = useState('');
  const [genres,setGenres] = useState<CategoryTag[]>([]), [genreIds,setGenreIds] = useState<string[]>([]), [genresLoading,setGenresLoading] = useState(false);
  useEffect(()=>{
    if(!canEdit)return;
    let active=true;setGenresLoading(true);setGenres([]);
    api.getCategoryTags(contentType).then(data=>{if(active)setGenres(data.tags);}).catch(error=>{if(active)setError(accountError(error));}).finally(()=>{if(active)setGenresLoading(false);});
    return()=>{active=false;};
  },[contentType,canEdit]);
  const [number,setNumber] = useState(1), [episodeTitle,setEpisodeTitle] = useState(''), [assetId,setAssetId] = useState('');
  const [member,setMember] = useState<Account|null>(null), [end,setEnd] = useState(''), [reason,setReason] = useState('');
  const selectedAssets=[...(selected?.assets || []),...assets].filter((asset,index,all)=>all.findIndex(row=>row.id===asset.id)===index&&(asset.series_id===selected?.id||asset.id===selected?.coverId||selected?.episodes.some(episode=>episode.assetId===asset.id)));
  const defaultVipEnd = (user:Account) => { const date=new Date(Math.max(Date.now()+30*86400000,user.membership.periodEnd||0)); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; };
  const labels: Record<typeof tab,MessageKey> = {series:'短剧管理',accounts:'用户与会员',comments:'评论管理',audit:'操作记录',analytics:'内容分析',security:'账户安全',team:'团队成员'};
  const navigationIcons = {series:Film,accounts:Users,comments:MessageSquare,audit:History,analytics:BarChart3,security:ShieldCheck,team:Users};
  const visibleTabs=(Object.keys(labels) as (typeof tab)[]).filter(key=>key==='security'||owner||key==='series'&&canEdit||key==='comments'&&hasTeamRole(teamMember,'moderator')||key==='analytics'&&hasTeamRole(teamMember,'analyst'));
  const statusLabels: Record<string,MessageKey> = {draft:'草稿',published:'已上架',uploading:'上传中',processing:'处理中',ready:'可用',failed:'失败',visible:'可见',hidden:'已隐藏',deleted:'已删除'};
  useEffect(() => {
    if (!selected?.assets?.some(asset => ['queued','processing'].includes(asset.hls?.status || ''))) return;
    const id = selected.id;
    const timer = setInterval(() => { void adminRequest(`series/${id}`).then(data => setSelected(previous => previous?.id === id ? { ...previous, assets: data.assets } : previous)).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [selected?.id, selected?.assets]);
  const run = async (action:()=>Promise<void>) => { if(busy)return; setBusy(true);setError('');try{await action();}catch(error){setError(accountError(error));}finally{setBusy(false);} };
  const rememberAssets = (rows:Asset[]) => setAssets(current=>[...rows,...current].filter((row,index,all)=>all.findIndex(asset=>asset.id===row.id)===index));
  const load = async () => {
    setLoading(true);
    try {
    if(tab==='series'){const rows=(await adminRequest(`series?q=${encodeURIComponent(query)}&page=${page}`)).items;setSeries(rows);setPageSize(rows.length);}
    if(tab==='accounts'){const rows=(await adminRequest(`accounts?q=${encodeURIComponent(query)}&page=${page}`)).items;setAccounts(rows);setPageSize(rows.length);}
    } finally { setLoading(false); }
  };
  useEffect(()=>{void load().catch(error=>setError(accountError(error)));},[tab,page,teamMember.id]);
  const edit = (data:AdminDetail|null) => {if(data?.assets)rememberAssets(data.assets);setSelected(data);setTitle(data?.title||'');setDescription(data?.description||'');setTags(data?.tags||'');setGenreIds(data?.categoryIds||[]);setContentType(data?.contentType||'real-drama');setContentLanguage(data?.language||'en');setCoverId(data?.coverId||'');setNumber((data?.episodes.length||0)+1);setEpisodeTitle('');setAssetId('');};
  useEffect(()=>{
    const id=teamMember.id;
    if(!canEdit)return;
    const last=localStorage.getItem(`drama_admin_series:${id}`);
    if(last)void adminRequest(`series/${last}`).then(edit).catch(error=>setError(accountError(error)));
  },[teamMember.id]);
  useEffect(()=>{
    const id=teamMember.id;
    if(selected)localStorage.setItem(`drama_admin_series:${id}`,selected.id);
  },[selected?.id,teamMember.id]);
  const save = async()=>{const data=await adminRequest(selected?`series/${selected.id}`:'series',{title,description,tags,categoryIds:genreIds,contentType,language:contentLanguage,coverId});edit(data);await load();};
  return <div className="admin-shell admin-layout">
    {sidebarOpen&&<div className="admin-sidebar-backdrop" aria-hidden="true" onClick={closeSidebar}/>}
    <aside className={`admin-sidebar${sidebarOpen?' is-open':''}`}>
      <div className="admin-sidebar-brand"><Film size={23}/><strong>{t('内容后台')}</strong><button className="admin-sidebar-close" aria-label={t('关闭导航')} onClick={closeSidebar}><X size={21}/></button></div>
      <nav className="admin-tabs" aria-label={t('内容后台')}>{visibleTabs.map(key=>{const Icon=navigationIcons[key];return <button key={key} aria-current={tab===key?'page':undefined} aria-pressed={tab===key} onClick={()=>{setTab(key);setAnalyticsSeriesId('');setPage(1);setQuery('');setError('');if(sidebarOpen)closeSidebar();}}><Icon size={19}/><span>{t(labels[key])}</span></button>;})}</nav>
    </aside>
    <div className="admin-workspace">
    <header className="admin-header"><button ref={menuButton} className="admin-menu-toggle" aria-label={t('打开导航')} aria-expanded={sidebarOpen} onClick={()=>setSidebarOpen(true)}><Menu size={22}/></button><h1>{t(labels[tab])}</h1><bdi>{teamMember.code}</bdi><select aria-label={t('界面语言')} value={language} onChange={event=>setLanguage(event.target.value as Language)}>{languages.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select><a href="/">{t('返回产品')}</a><button disabled={busy} onClick={()=>void run(async()=>{localStorage.removeItem(`drama_admin_series:${teamMember.id}`);await teamLogout();})}>{t('退出登录')}</button></header>
    <main className="admin-main">
    {tab==='security'&&<TeamSecurity member={teamMember}/>}
    {tab==='team'&&owner&&<TeamManagement current={teamMember}/>}
    {error&&<p role="alert" className="account-error">{localizeError(error)}</p>}
    {(tab==='series'||tab==='accounts')&&<form className="admin-search" onSubmit={event=>{event.preventDefault();if(page!==1)setPage(1);else void run(load);}}><input aria-label={t('搜索')} placeholder={t('搜索')} value={query} onChange={event=>setQuery(event.target.value)}/><button disabled={busy}>{t('搜索')}</button></form>}
    {canEdit&&<div hidden={tab!=='series'} className="admin-content-columns admin-series-editor"><section className="admin-panel">
      <div className="admin-panel-title"><h2>{t('短剧管理')}</h2>{owner&&<button onClick={()=>edit(null)}>{t('新建短剧')}</button>}<button disabled={busy} onClick={()=>void run(load)}>{t('刷新')}</button></div>
      <p className="analytics-note">{t('上传按剧说明')}</p>
      <details open={!selected}><summary>{selected?selected.title:t('选择短剧')}</summary>{loading ? <p role="status">{t('加载中...')}</p> : !series.length&&!error&&<p>{t('尚无上传内容')}</p>}
      {series.map(row=><button className="admin-series-row" key={row.id} disabled={busy} onClick={()=>void run(async()=>edit(await adminRequest(`series/${row.id}`)))}>{row.cover&&<img src={row.cover} alt={row.title}/>}<span><strong>{row.title}</strong><small>{t(statusLabels[row.status])} · {row.episodes.length} {t('集')}</small></span></button>)}
      </details></section>
      <div className="admin-series-detail"><section className="admin-panel"><nav className="analytics-breadcrumb" aria-label={t('内容层级')}><button disabled={!selected} onClick={()=>edit(null)}>{t('剧列表')}</button>{selected&&<><span>›</span><strong dir="auto">{selected.title}</strong>{hasTeamRole(teamMember,'analyst')&&<button onClick={()=>{setAnalyticsSeriesId(selected.id);setTab('analytics');}}>{t('内容分析')}</button>}</>}</nav><h2>{selected?selected.title:t('选择短剧')}</h2>{owner&&selected&&<button onClick={()=>setTab('team')}>{t('作品授权')}</button>}<details open={!selected}><summary>{t('基本信息')}</summary><form onSubmit={event=>{event.preventDefault();void run(save);}}>
        <label>{t('剧名')}<input required maxLength={200} value={title} onChange={event=>setTitle(event.target.value)}/></label>
        <label>{t('简介')}<textarea maxLength={5000} value={description} onChange={event=>setDescription(event.target.value)}/></label>
        <label>{t('内容类型')}<select value={contentType} onChange={event=>{setContentType(event.target.value);setGenreIds([]);}}><option value="real-drama">{t('真人剧')}</option><option value="comic-drama">{t('漫剧')}</option><option value="ai-drama">{t('AI剧')}</option></select></label>
        <div className="admin-genre-options" role="group" aria-label={t('选择分类')}><strong>{t('选择分类')}</strong>{genresLoading&&<span>{t('加载中...')}</span>}{genres.map(genre=><button type="button" key={genre.id} aria-pressed={genreIds.includes(genre.id)} onClick={()=>setGenreIds(current=>current.includes(genre.id)?current.filter(id=>id!==genre.id):[...current,genre.id])}>{localizeLabel(genre.name)}</button>)}</div>
        <label>{t('分类标签')}<input maxLength={500} value={tags} onChange={event=>setTags(event.target.value)}/></label>
        <label>{t('内容语言')}<select value={contentLanguage} onChange={event=>setContentLanguage(event.target.value)}>{languages.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>{t('封面')}<select value={coverId} onChange={event=>setCoverId(event.target.value)}><option value="">{t('选择已上传素材')}</option>{selectedAssets.filter(asset=>asset.kind==='image'&&asset.status==='ready').map(asset=><option key={asset.id} value={asset.id}>{t('封面')} · {asset.name}</option>)}</select></label>
        <button disabled={busy||!owner&&!selected}>{t(selected?'保存基本信息':'保存并上传')}</button>
      </form></details>
      {selected&&<>
        <div className="admin-publish"><span>{t(statusLabels[selected.status])} · {selected.episodes.length} {t('集')}</span><button disabled={busy||selected.status!=='published'&&uploadingSeries.includes(selected.id)} onClick={()=>void run(async()=>{edit(await adminRequest(`series/${selected.id}/publish`,{status:selected.status==='published'?'draft':'published'}));await load();})}>{t(selected.status==='published'?'下架':'检查并发布')}</button>{selected.episodes.length>0&&<a href={`/preview?series=${selected.id}&episode=${selected.episodes[0].id}`} target="_blank" rel="noopener noreferrer">{t('预览')}</a>}</div>
        {uploadingSeries.includes(selected.id)&&<p>{t('请先完成或移除未完成的上传任务')}</p>}
        <h3>{t('分集管理')}</h3>{selected.status==='published'&&<p>{t('下架后可调整分集')}</p>}
        <details><summary>{t('复用素材或编辑分集')}</summary><form onSubmit={event=>{event.preventDefault();void run(async()=>{
          const existing=selected.episodes.find(ep=>ep.number===number);
          if(existing&&existing.assetId!==assetId&&!window.confirm(t('确认替换第{{number}}集？',{number})))return;
          const data=await adminRequest(`series/${selected.id}/episodes`,{number,title:episodeTitle,assetId,mode:existing?'replace':'append',expectedEpisodeId:existing?.id,expectedAssetId:existing?.assetId});edit(data);await load();
        });}}>
          <label>{t('集数')}<input type="number" min={1} max={10000} required value={number} onChange={event=>setNumber(Number(event.target.value))}/></label>
          <label>{t('分集标题')}<input maxLength={200} value={episodeTitle} onChange={event=>setEpisodeTitle(event.target.value)}/></label>
          <label>{t('视频')}<select required value={assetId} onChange={event=>setAssetId(event.target.value)}><option value="">{t('选择已上传素材')}</option>{selectedAssets.filter(asset=>asset.kind==='video'&&asset.status==='ready').map(asset=><option key={asset.id} value={asset.id}>{selected.episodes.filter(episode=>episode.assetId===asset.id).map(episode=>t('第{{number}}集',{number:episode.number})).join(' / ')} · {asset.name}</option>)}</select></label>
          <button disabled={busy||selected.status==='published'||uploadingSeries.includes(selected.id)}>{t('保存分集')}</button>
        </form></details>
        <div className="admin-episodes">{selected.episodes.map((ep,index)=><div key={ep.id}>
          <span>{t('第{{number}}集',{number:ep.number})}{ep.title!==`第${ep.number}集`&&<> · <bdi>{ep.title}</bdi></>} · {t(index<3?'免费':'VIP会员')}</span>
          {(() => { const hls = selectedAssets.find(asset => asset.id === ep.assetId)?.hls; return hls ? <span role="status">{t(hls.status === 'ready' ? 'HLS已就绪' : hls.status === 'failed' ? 'HLS失败，MP4可用' : 'HLS转码中，MP4可用')}{hls.status === 'ready' && <> · {hls.manifest?.levels.map(level => level.key).join(' / ')} · {(hls.size / 1024 ** 2).toFixed(1)} MB</>}{hls.status === 'failed' && <><small>{hls.error && localizeError(hls.error)}</small><button disabled={busy} onClick={() => void run(async () => { await adminRequest(`uploads/${ep.assetId}/hls/retry`, {}); const data = await adminRequest(`series/${selected.id}`); setSelected(data); })}>{t('重试转码')}</button></>}</span> : null; })()}
          <button disabled={busy||selected.status==='published'||uploadingSeries.includes(selected.id)||index===0} onClick={()=>void run(async()=>{const ids=selected.episodes.map(ep=>ep.id);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];edit(await adminRequest(`series/${selected.id}/reorder`,{ids}));await load();})}>{t('上移')}</button>
          <button disabled={busy||selected.status==='published'||uploadingSeries.includes(selected.id)||index===selected.episodes.length-1} onClick={()=>void run(async()=>{const ids=selected.episodes.map(ep=>ep.id);[ids[index],ids[index+1]]=[ids[index+1],ids[index]];edit(await adminRequest(`series/${selected.id}/reorder`,{ids}));await load();})}>{t('下移')}</button>
          <button disabled={busy||selected.status==='published'} onClick={()=>{setNumber(ep.number);setEpisodeTitle(ep.title);setAssetId(ep.assetId);}}>{t('编辑')}</button>
          <button disabled={busy||selected.status==='published'||uploadingSeries.includes(selected.id)} onClick={()=>void run(async()=>{const response=await axios.delete(`/api/admin/series/${selected.id}/episodes/${ep.id}`);edit(response.data);await load();})}>{t('移除')}</button>
        </div>)}</div>
      </>}
      </section><AdminUploadQueue key={teamMember.id} accountId={teamMember.id} administrator={owner} series={selected} visible={tab==='series'&&!!selected} onUpdated={uploaded} onActivity={setUploadingSeries}/></div></div>}
    {tab==='accounts'&&<section className="admin-panel"><h2>{t('用户与会员')}</h2><p>{t('手动会员与支付订阅独立，撤销手动会员不会取消付费订阅')}</p>{accounts.map(user=><button className="admin-account-row" key={user.id} onClick={()=>{setMember(user);setEnd(defaultVipEnd(user));setReason('');}}><strong>{user.name}</strong><span>{user.email}</span><span>{t(user.membership.active?'VIP会员':'普通账户')}</span></button>)}{member&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{await adminRequest('membership',{accountId:member.id,periodEnd:new Date(`${end}T23:59:59`).getTime(),reason});await load();setMember(null);});}}><h3>{member.email}</h3><label>{t('有效期至')}<input required type="date" value={end} onChange={event=>setEnd(event.target.value)}/></label><label>{t('操作原因')}<input required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label><button disabled={busy}>{t('开通或延长VIP')}</button><button type="button" disabled={busy||!reason.trim()} onClick={()=>void run(async()=>{await adminRequest('membership',{accountId:member.id,revoke:true,reason});await load();setMember(null);})}>{t('撤销手动会员')}</button></form>}</section>}
    {tab==='comments'&&<CommentModeration key={teamMember.id}/>}
    {tab==='audit'&&<AuditLog key={teamMember.id}/>}
    {tab==='analytics'&&<AnalyticsDashboard initialSeriesId={analyticsSeriesId}/>}
    {(tab==='series'||tab==='accounts')&&<nav className="admin-pagination"><button disabled={busy||page<=1} onClick={()=>setPage(value=>value-1)}>{t('上一页')}</button><span>{t('第{{number}}页',{number:page})}</span><button disabled={busy||pageSize<(tab==='series'?24:100)} onClick={()=>setPage(value=>value+1)}>{t('下一页')}</button></nav>}
    </main>
    </div>
  </div>;
}
