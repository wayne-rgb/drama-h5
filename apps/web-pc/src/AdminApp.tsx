import React, { useEffect, useRef, useState } from 'react';
import { Film, Upload, Users, MessageSquare, History, Menu, X } from 'lucide-react';
import axios from 'axios';
import { Account, accountRequest, changeAccount, accountError } from './account';
import { useAccountSession } from './AccountArea';
import { useI18n, languages, MessageKey, Language } from './i18n';
import { Detail, CategoryTag } from './types';
import { api } from './api';
import './account.css';
import './admin.css';

type Asset = { id: string; name: string; kind: string; size: number; offset: number; status: string; error?: string; owner_id: string };
type AdminDetail = Omit<Detail, 'episodes'> & { language: string; status: string; coverId: string | null; categoryIds?: string[]; assets?: Asset[]; episodes: (Detail['episodes'][number] & { assetId: string })[] };
const adminRequest = (route: string, body?: unknown) => accountRequest(`/api/admin/${route}`,body);
export default function AdminApp() {
  const { t, localizeLabel, localizeError, formatDate, language, setLanguage } = useI18n();
  const account = useAccountSession();
  const [email,setEmail] = useState(''), [password,setPassword] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [tab,setTab] = useState<'series'|'uploads'|'accounts'|'comments'|'audit'>('series');
  const [sidebarOpen,setSidebarOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeSidebar = () => { setSidebarOpen(false); menuButton.current?.focus(); };
  useEffect(()=>{
    if(!sidebarOpen)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')closeSidebar();};
    document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);
  },[sidebarOpen]);
  const [page,setPage] = useState(1), [pageSize,setPageSize] = useState(0), [uploadRows,setUploadRows] = useState<Asset[]>([]), [uploadFinished,setUploadFinished] = useState(false);
  const [loading,setLoading] = useState(true);
  const [series,setSeries] = useState<AdminDetail[]>([]), [selected,setSelected] = useState<AdminDetail|null>(null), [assets,setAssets] = useState<Asset[]>([]);
  const [accounts,setAccounts] = useState<Account[]>([]), [comments,setComments] = useState<any[]>([]), [audit,setAudit] = useState<any[]>([]), [query,setQuery] = useState('');
  const [title,setTitle] = useState(''), [description,setDescription] = useState(''), [tags,setTags] = useState(''), [contentType,setContentType] = useState('real-drama'), [contentLanguage,setContentLanguage] = useState('en'), [coverId,setCoverId] = useState('');
  const [genres,setGenres] = useState<CategoryTag[]>([]), [genreIds,setGenreIds] = useState<string[]>([]), [genresLoading,setGenresLoading] = useState(false);
  useEffect(()=>{
    if(!account.session?.capabilities.admin)return;
    let active=true;setGenresLoading(true);setGenres([]);
    api.getCategoryTags(contentType).then(data=>{if(active)setGenres(data.tags);}).catch(error=>{if(active)setError(accountError(error));}).finally(()=>{if(active)setGenresLoading(false);});
    return()=>{active=false;};
  },[contentType,account.session?.capabilities.admin]);
  const [number,setNumber] = useState(1), [episodeTitle,setEpisodeTitle] = useState(''), [assetId,setAssetId] = useState('');
  const [member,setMember] = useState<Account|null>(null), [end,setEnd] = useState(''), [reason,setReason] = useState('');
  const [file,setFile] = useState<File|null>(null), [uploadId,setUploadId] = useState(''), [progress,setProgress] = useState(0);
  useEffect(()=>{if(uploadId && assets.find(asset=>asset.id===uploadId)?.status==='failed')setUploadFinished(false);},[assets,uploadId]);
  const defaultVipEnd = (user:Account) => { const date=new Date(Math.max(Date.now()+30*86400000,user.membership.periodEnd||0)); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; };
  const labels: Record<typeof tab,MessageKey> = {series:'短剧管理',uploads:'素材上传',accounts:'用户与会员',comments:'评论管理',audit:'操作记录'};
  const navigationIcons = {series:Film,uploads:Upload,accounts:Users,comments:MessageSquare,audit:History};
  const statusLabels: Record<string,MessageKey> = {draft:'草稿',published:'已上架',uploading:'上传中',processing:'处理中',ready:'可用',failed:'失败',visible:'可见',hidden:'已隐藏',deleted:'已删除'};
  const run = async (action:()=>Promise<void>) => { if(busy)return; setBusy(true);setError('');try{await action();}catch(error){setError(accountError(error));}finally{setBusy(false);} };
  const rememberAssets = (rows:Asset[]) => setAssets(current=>[...rows,...current].filter((row,index,all)=>all.findIndex(asset=>asset.id===row.id)===index));
  const load = async () => {
    setLoading(true);
    try {
    if(tab==='series'){const rows=(await adminRequest(`series?q=${encodeURIComponent(query)}&page=${page}`)).items;setSeries(rows);setPageSize(rows.length);}
    if(tab==='uploads' || tab==='series'){const rows=(await adminRequest(`uploads?page=${tab==='uploads'?page:1}`)).items;rememberAssets(rows);if(tab==='uploads'){setUploadRows(rows);setPageSize(rows.length);}}
    if(tab==='accounts'){const rows=(await adminRequest(`accounts?q=${encodeURIComponent(query)}&page=${page}`)).items;setAccounts(rows);setPageSize(rows.length);}
    if(tab==='comments'){const rows=(await adminRequest(`comments?page=${page}`)).items;setComments(rows);setPageSize(rows.length);}
    if(tab==='audit'){const rows=(await adminRequest(`audit?page=${page}`)).items;setAudit(rows);setPageSize(rows.length);}
    } finally { setLoading(false); }
  };
  useEffect(()=>{if(account.session?.capabilities.admin)void load().catch(error=>setError(accountError(error)));},[tab,page,account.session?.user?.id]);
  useEffect(()=>{
    if(!account.session?.capabilities.admin || !assets.some(asset=>asset.status==='processing'))return;
    const timer=setInterval(()=>{void adminRequest(`uploads?page=${tab==='uploads'?page:1}`).then(data=>{rememberAssets(data.items);if(tab==='uploads')setUploadRows(data.items);}).catch(error=>setError(accountError(error)));},2000);return()=>clearInterval(timer);
  },[account.session?.capabilities.admin,assets.some(asset=>asset.status==='processing'),tab,page]);
  const edit = (data:AdminDetail|null) => {if(data?.assets)rememberAssets(data.assets);setSelected(data);setTitle(data?.title||'');setDescription(data?.description||'');setTags(data?.tags||'');setGenreIds(data?.categoryIds||[]);setContentType(data?.contentType||'real-drama');setContentLanguage(data?.language||'en');setCoverId(data?.coverId||'');setNumber((data?.episodes.length||0)+1);setEpisodeTitle('');setAssetId('');};
  const save = async()=>{const data=await adminRequest(selected?`series/${selected.id}`:'series',{title,description,tags,categoryIds:genreIds,contentType,language:contentLanguage,coverId});edit(data);await load();};
  const upload = async()=>{
    if(!file)return;
    const fingerprint=`drama_upload:${account.session!.user!.id}:${file.name}:${file.size}:${file.lastModified}`;
    let id=uploadId || localStorage.getItem(fingerprint);
    let asset:Asset;
    if(id) {asset=await adminRequest(`uploads/${id}`);if(asset.status==='failed')id=null;}
    if(!id){asset=await adminRequest('uploads',{name:file.name,size:file.size,kind:file.type.startsWith('image/')?'image':'video',mime:file.type || 'video/mp4'});id=asset.id;localStorage.setItem(fingerprint,id);}
    setUploadId(id!);asset=await adminRequest(`uploads/${id}`);
    setProgress(Math.min(100,Math.floor(asset.offset/file.size*100)));
    while(asset.status==='uploading' && asset.offset<file.size){
      const start=asset.offset,finish=Math.min(start+1048576,file.size);
      const response=await axios.put(`/api/admin/uploads/${id}`,file.slice(start,finish),{headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${start}-${finish-1}/${file.size}`},timeout:60000,onUploadProgress:event=>setProgress(Math.floor((start+(event.loaded||0))/file.size*100))});
      asset=response.data;setProgress(Math.floor(asset.offset/file.size*100));
    }
    if(asset.status!=='uploading')localStorage.removeItem(fingerprint);
    setUploadFinished(['ready','processing'].includes(asset.status));
    await load();
  };
  if(!account.session)return <main className="admin-shell"><p>{t('账户加载中...')}</p>{account.error&&<p role="alert">{localizeError(account.error)}</p>}<button onClick={()=>void account.refresh()}>{t('重试')}</button></main>;
  if(!account.session.user)return <main className="admin-login"><h1>{t('内容后台')}</h1><form onSubmit={event=>{event.preventDefault();void run(()=>changeAccount('/api/auth/login',{email,password},'/admin'));}}><label>{t('邮箱')}<input type="email" required autoComplete="username" value={email} onChange={event=>setEmail(event.target.value)}/></label><label>{t('密码')}<input type="password" required autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)}/></label><button disabled={busy}>{t('登录')}</button>{error&&<p role="alert">{localizeError(error)}</p>}</form><a href="/">{t('返回')}</a></main>;
  if(!account.session.capabilities.admin)return <main className="admin-shell"><h1>{t('需要管理员权限')}</h1><p>{t('请使用已配置的管理员账户登录')}</p><button onClick={()=>void run(()=>changeAccount('/api/auth/logout',{},'/admin'))}>{t('退出登录')}</button><a href="/">{t('返回')}</a></main>;
  return <div className="admin-shell admin-layout">
    {sidebarOpen&&<div className="admin-sidebar-backdrop" aria-hidden="true" onClick={closeSidebar}/>}
    <aside className={`admin-sidebar${sidebarOpen?' is-open':''}`}>
      <div className="admin-sidebar-brand"><Film size={23}/><strong>{t('内容后台')}</strong><button className="admin-sidebar-close" aria-label={t('关闭导航')} onClick={closeSidebar}><X size={21}/></button></div>
      <nav className="admin-tabs" aria-label={t('内容后台')}>{(Object.keys(labels) as (typeof tab)[]).map(key=>{const Icon=navigationIcons[key];return <button key={key} aria-current={tab===key?'page':undefined} aria-pressed={tab===key} onClick={()=>{setTab(key);setPage(1);setQuery('');setError('');if(sidebarOpen)closeSidebar();}}><Icon size={19}/><span>{t(labels[key])}</span></button>;})}</nav>
    </aside>
    <div className="admin-workspace">
    <header className="admin-header"><button ref={menuButton} className="admin-menu-toggle" aria-label={t('打开导航')} aria-expanded={sidebarOpen} onClick={()=>setSidebarOpen(true)}><Menu size={22}/></button><h1>{t(labels[tab])}</h1><span>{account.session.user.name}</span><select aria-label={t('界面语言')} value={language} onChange={event=>setLanguage(event.target.value as Language)}>{languages.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select><a href="/">{t('返回产品')}</a><button disabled={busy} onClick={()=>void run(()=>changeAccount('/api/auth/logout',{},'/admin'))}>{t('退出登录')}</button></header>
    <main className="admin-main">
    {error&&<p role="alert" className="account-error">{localizeError(error)}</p>}
    {(tab==='series'||tab==='accounts')&&<form className="admin-search" onSubmit={event=>{event.preventDefault();if(page!==1)setPage(1);else void run(load);}}><input aria-label={t('搜索')} placeholder={t('搜索')} value={query} onChange={event=>setQuery(event.target.value)}/><button disabled={busy}>{t('搜索')}</button></form>}
    {tab==='series'&&<div className="admin-content-columns"><section className="admin-panel">
      <div className="admin-panel-title"><h2>{t('短剧管理')}</h2><button onClick={()=>edit(null)}>{t('新建短剧')}</button><button disabled={busy} onClick={()=>void run(load)}>{t('刷新')}</button></div>
      {loading ? <p role="status">{t('加载中...')}</p> : !series.length&&!error&&<p>{t('尚无上传内容')}</p>}
      {series.map(row=><button className="admin-series-row" key={row.id} disabled={busy} onClick={()=>void run(async()=>edit(await adminRequest(`series/${row.id}`)))}>{row.cover&&<img src={row.cover} alt={row.title}/>}<span><strong>{row.title}</strong><small>{t(statusLabels[row.status])} · {row.episodes.length} {t('集')}</small></span></button>)}
    </section>
      <section className="admin-panel"><h2>{t(selected?'编辑短剧':'新建短剧')}</h2><form onSubmit={event=>{event.preventDefault();void run(save);}}>
        <label>{t('剧名')}<input required maxLength={200} value={title} onChange={event=>setTitle(event.target.value)}/></label>
        <label>{t('简介')}<textarea maxLength={5000} value={description} onChange={event=>setDescription(event.target.value)}/></label>
        <label>{t('内容类型')}<select value={contentType} onChange={event=>{setContentType(event.target.value);setGenreIds([]);}}><option value="real-drama">{t('真人剧')}</option><option value="comic-drama">{t('漫剧')}</option><option value="ai-drama">{t('AI剧')}</option></select></label>
        <div className="admin-genre-options" role="group" aria-label={t('选择分类')}><strong>{t('选择分类')}</strong>{genresLoading&&<span>{t('加载中...')}</span>}{genres.map(genre=><button type="button" key={genre.id} aria-pressed={genreIds.includes(genre.id)} onClick={()=>setGenreIds(current=>current.includes(genre.id)?current.filter(id=>id!==genre.id):[...current,genre.id])}>{localizeLabel(genre.name)}</button>)}</div>
        <label>{t('分类标签')}<input maxLength={500} value={tags} onChange={event=>setTags(event.target.value)}/></label>
        <label>{t('内容语言')}<select value={contentLanguage} onChange={event=>setContentLanguage(event.target.value)}>{languages.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label>{t('封面')}<select value={coverId} onChange={event=>setCoverId(event.target.value)}><option value="">{t('选择已上传素材')}</option>{assets.filter(asset=>asset.kind==='image'&&asset.status==='ready').map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        <button disabled={busy}>{t('保存')}</button><button type="button" onClick={()=>{setTab('uploads');setPage(1);}}>{t('上传素材')}</button>
      </form>
      {selected&&<><div className="admin-publish"><span>{t(statusLabels[selected.status])}</span><button disabled={busy} onClick={()=>void run(async()=>{edit(await adminRequest(`series/${selected.id}/publish`,{status:selected.status==='published'?'draft':'published'}));await load();})}>{t(selected.status==='published'?'下架':'上架')}</button>{selected.episodes.length>0&&<a href={`/?series=${selected.id}&episode=${selected.episodes[0].id}`} target="_blank" rel="noopener noreferrer">{t('预览')}</a>}</div><h3>{t('分集管理')}</h3>{selected.status==='published'&&<p>{t('下架后可调整分集')}</p>}<form onSubmit={event=>{event.preventDefault();void run(async()=>{const data=await adminRequest(`series/${selected.id}/episodes`,{number,title:episodeTitle,assetId});edit(data);await load();});}}><label>{t('集数')}<input type="number" min={1} max={10000} required value={number} onChange={event=>setNumber(Number(event.target.value))}/></label><label>{t('分集标题')}<input maxLength={200} value={episodeTitle} onChange={event=>setEpisodeTitle(event.target.value)}/></label><label>{t('视频')}<select required value={assetId} onChange={event=>setAssetId(event.target.value)}><option value="">{t('选择已上传素材')}</option>{assets.filter(asset=>asset.kind==='video'&&asset.status==='ready').map(asset=><option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><button disabled={busy||selected.status==='published'}>{t('保存分集')}</button></form><div className="admin-episodes">{selected.episodes.map((ep,index)=><div key={ep.id}><span>{ep.number}. {ep.title} · {t(index<3?'免费':'VIP会员')}</span><button disabled={busy||selected.status==='published'||index===0} onClick={()=>void run(async()=>{const ids=selected.episodes.map(ep=>ep.id);[ids[index-1],ids[index]]=[ids[index],ids[index-1]];edit(await adminRequest(`series/${selected.id}/reorder`,{ids}));await load();})}>{t('上移')}</button><button disabled={busy||selected.status==='published'||index===selected.episodes.length-1} onClick={()=>void run(async()=>{const ids=selected.episodes.map(ep=>ep.id);[ids[index],ids[index+1]]=[ids[index+1],ids[index]];edit(await adminRequest(`series/${selected.id}/reorder`,{ids}));await load();})}>{t('下移')}</button><button disabled={busy||selected.status==='published'} onClick={()=>{setNumber(ep.number);setEpisodeTitle(ep.title);setAssetId(ep.assetId);}}>{t('编辑')}</button><button disabled={busy||selected.status==='published'} onClick={()=>void run(async()=>{const response=await axios.delete(`/api/admin/series/${selected.id}/episodes/${ep.id}`);edit(response.data);await load();})}>{t('移除')}</button></div>)}</div></>}
      </section></div>}
    {tab==='uploads'&&<section className="admin-panel"><h2>{t('素材上传')}</h2><p>{t('视频支持H.264与AAC的MP4，封面支持JPEG、PNG、WebP')}</p>
      <label>{t('选择文件')}<input type="file" accept="video/mp4,image/jpeg,image/png,image/webp" disabled={busy} onChange={event=>{setFile(event.target.files?.[0]||null);setUploadId('');setProgress(0);setUploadFinished(false);}}/></label>
      <button disabled={busy||!file||uploadFinished} onClick={()=>void run(upload)}>{t(uploadFinished?'上传完成':uploadId?'继续上传':'开始上传')}</button><progress max={100} value={progress}/><span>{progress}%</span><button disabled={busy} onClick={()=>void run(load)}>{t('刷新')}</button>
      <div className="admin-table">{uploadRows.map(asset=><div key={asset.id}><strong>{asset.name}</strong><span>{t(statusLabels[asset.status])} · {Math.round(asset.size/1024/1024*100)/100} MB</span>{asset.error&&<p role="alert">{localizeError(asset.error)}</p>}</div>)}</div>
    </section>}
    {tab==='accounts'&&<section className="admin-panel"><h2>{t('用户与会员')}</h2><p>{t('手动会员与支付订阅独立，撤销手动会员不会取消付费订阅')}</p>{accounts.map(user=><button className="admin-account-row" key={user.id} onClick={()=>{setMember(user);setEnd(defaultVipEnd(user));setReason('');}}><strong>{user.name}</strong><span>{user.email}</span><span>{t(user.membership.active?'VIP会员':'普通账户')}</span></button>)}{member&&<form onSubmit={event=>{event.preventDefault();void run(async()=>{await adminRequest('membership',{accountId:member.id,periodEnd:new Date(`${end}T23:59:59`).getTime(),reason});await load();setMember(null);});}}><h3>{member.email}</h3><label>{t('有效期至')}<input required type="date" value={end} onChange={event=>setEnd(event.target.value)}/></label><label>{t('操作原因')}<input required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label><button disabled={busy}>{t('开通或延长VIP')}</button><button type="button" disabled={busy||!reason.trim()} onClick={()=>void run(async()=>{await adminRequest('membership',{accountId:member.id,revoke:true,reason});await load();setMember(null);})}>{t('撤销手动会员')}</button></form>}</section>}
    {tab==='comments'&&<section className="admin-panel"><div className="admin-panel-title"><h2>{t('评论管理')}</h2><button disabled={busy} onClick={()=>void run(load)}>{t('刷新')}</button></div>{comments.map(row=><article className="admin-comment-row" key={row.id}><strong>{row.author}</strong><p dir="auto">{row.body}</p><small>{row.series_id} / {row.episode_id} · {t(statusLabels[row.status])} · {t('举报')} {row.reports}</small>{(['visible','hidden','deleted'] as const).map(status=><button key={status} disabled={busy||row.status===status} onClick={()=>void run(async()=>{await adminRequest(`comments/${row.id}`,{status});await load();})}>{t(statusLabels[status])}</button>)}</article>)}</section>}
    {tab==='audit'&&<section className="admin-panel"><h2>{t('操作记录')}</h2><button disabled={busy} onClick={()=>void run(load)}>{t('刷新')}</button>{audit.map(row=><article className="admin-comment-row" key={row.id}><strong>{localizeLabel(row.action)}</strong><p>{row.target_id}</p><small>{row.admin_id} · {formatDate(row.created_at,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small><pre>{row.detail}</pre></article>)}</section>}
    <nav className="admin-pagination"><button disabled={busy||page<=1} onClick={()=>setPage(value=>value-1)}>{t('上一页')}</button><span>{t('第{{number}}页',{number:page})}</span><button disabled={busy||pageSize<(tab==='series'?24:100)} onClick={()=>setPage(value=>value+1)}>{t('下一页')}</button></nav>
    </main>
    </div>
  </div>;
}
