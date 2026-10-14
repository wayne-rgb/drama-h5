import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Upload, ImagePlus, CheckCircle2, AlertCircle } from 'lucide-react';
import { accountRequest, accountError } from './account';
import { useI18n, MessageKey } from './i18n';

type Episode = { id: string; number: number; title: string; assetId: string };
type Series = { id: string; title: string; status: string; coverId: string | null; cover: string; episodes: Episode[] };
type Task = {
  id: string; seriesId: string; seriesTitle: string; name: string; size: number; modified: number; digest: string;
  kind: 'video' | 'image'; mime: string; number: number; title: string; assetId?: string;
  mode: 'append' | 'replace'; expectedEpisodeId?: string; expectedAssetId?: string;
  state: 'confirm' | 'queued' | 'uploading' | 'processing' | 'saving' | 'ready' | 'failed' | 'paused' | 'needsFile';
  progress: number; error?: string;
};
const request = (route: string, data?: unknown) => accountRequest(`/api/admin/${route}`, data);
const labels: Record<Task['state'], MessageKey> = {
  confirm:'待确认', queued:'等待上传', uploading:'上传中', processing:'处理中', saving:'正在保存分集',
  ready:'已保存', failed:'失败', paused:'已暂停', needsFile:'请重新选择原文件',
};
const activeStates = ['queued', 'uploading', 'processing', 'saving'];
// 文件身份包含首尾内容、大小和修改时间；续传前避免把另一份同名文件拼入原上传。
async function identity(file: File) {
  const parts = await Promise.all([file.slice(0,65536).arrayBuffer(),file.slice(Math.max(0,file.size-65536)).arrayBuffer()]);
  const bytes = new Uint8Array(parts[0].byteLength+parts[1].byteLength);
  bytes.set(new Uint8Array(parts[0])); bytes.set(new Uint8Array(parts[1]),parts[0].byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function fileNumber(name: string) {
  const stem=name.replace(/\.mp4$/i,'');
  const match=/(?:第\s*|ep(?:isode)?[\s_.-]*)(\d+)\s*(?:集)?/i.exec(stem) || /^(\d+)(?:\D|$)/.exec(stem) || /(?:^|[\s_.-])(\d+)$/.exec(stem);
  const value=Number(match?.[1]); return value>0&&value<=10000 ? value : null;
}

export default function AdminUploadQueue({accountId, series, visible, onUpdated, onActivity}: {
  accountId: string; series: Series | null; visible: boolean;
  onUpdated: (data: any) => void; onActivity: (seriesIds: string[]) => void;
}) {
  const {t,localizeError}=useI18n();
  const key=`drama_batch_upload_v1:${accountId}`;
  const [tasks,setTasks]=useState<Task[]>(()=>{
    try {
      const saved=JSON.parse(localStorage.getItem(key)||'[]');
      if(!Array.isArray(saved))return [];
      return saved.filter(task=>task.id&&task.seriesId&&task.name).map(task=>({...task,state:activeStates.includes(task.state)?'queued':task.state}));
    } catch { return []; }
  });
  const tasksRef=useRef(tasks), files=useRef(new Map<string,File>()), running=useRef(new Set<string>());
  const alive=useRef(true), notifications=useRef(Promise.resolve()), callbacks=useRef({onUpdated,onActivity}); callbacks.current={onUpdated,onActivity};
  const [error,setError]=useState(''), [selecting,setSelecting]=useState(false), [maximum,setMaximum]=useState(2*1024**3);
  const [replacement,setReplacement]=useState<Episode|null>(null), [dragging,setDragging]=useState(false);
  const [showCompleted,setShowCompleted]=useState(false);
  const replaceInput=useRef<HTMLInputElement>(null), dragged=useRef<string|null>(null);
  useEffect(()=>{setReplacement(null);setError('');setDragging(false);setShowCompleted(false);},[series?.id]);
  const change=(action:(rows:Task[])=>Task[])=>{
    if(!alive.current)return;
    const rows=action(tasksRef.current); tasksRef.current=rows; setTasks(rows);
    try {localStorage.setItem(key,JSON.stringify(rows));} catch {setError('无法保存续传记录，请勿关闭页面');}
    callbacks.current.onActivity([...new Set(rows.filter(row=>row.state!=='ready').map(row=>row.seriesId))]);
  };
  const patch=(id:string,data:Partial<Task>)=>change(rows=>rows.map(row=>row.id===id?{...row,...data}:row));
  useEffect(()=>{
    alive.current=true;
    void request('uploads').then(data=>setMaximum(data.maximum)).catch(()=>{});
    return()=>{alive.current=false;};
  },[]);
  useEffect(()=>{
    callbacks.current.onActivity([...new Set(tasks.filter(row=>row.state!=='ready').map(row=>row.seriesId))]);
    const timer=setInterval(()=>{
      // 队列不随模块切换卸载，两条真实上传并行，处理状态按素材标识查询。
      for(const task of tasksRef.current) {
        if(running.current.size>=2)break;
        if(task.state!=='queued'||running.current.has(task.id))continue;
        running.current.add(task.id);
        void execute(task).finally(()=>{running.current.delete(task.id);change(rows=>[...rows]);});
      }
    },350);
    return()=>clearInterval(timer);
  },[]);
  const execute=async(initial:Task)=>{
    const id=initial.id;
    try {
      if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
      let asset=initial.assetId ? await request(`uploads/${initial.assetId}`) : null;
      const file=files.current.get(id);
      if(asset?.status==='failed') {
        if(!file){patch(id,{state:'needsFile',error:asset.error});return;}
        // 清理成功后才放弃旧编号，避免失败重试留下无法从队列移除的文件。
        await axios.delete(`/api/admin/uploads/${asset.id}`);
        asset=null;patch(id,{assetId:undefined});
      }
      if(!asset || asset.status==='uploading') {
        if(!file) {patch(id,{state:'needsFile'});return;}
        if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
        if(!asset) {asset=await request('uploads',{name:initial.name,size:initial.size,kind:initial.kind,mime:initial.mime,seriesId:initial.seriesId,number:initial.number});patch(id,{assetId:asset.id});}
        if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
        patch(id,{state:'uploading',progress:Math.floor(asset.offset/initial.size*100),error:''});
        while(asset.status==='uploading' && asset.offset<initial.size && alive.current) {
          if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
          const start=asset.offset,end=Math.min(start+1048576,initial.size);
          asset=(await axios.put(`/api/admin/uploads/${asset.id}`,file.slice(start,end),{
            headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${start}-${end-1}/${initial.size}`},timeout:60000,
            onUploadProgress:event=>{if(tasksRef.current.find(row=>row.id===id)?.state!=='paused')patch(id,{progress:Math.min(100,Math.floor((start+event.loaded)/initial.size*100))});},
          })).data;
          if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
          patch(id,{progress:Math.min(100,Math.floor(asset.offset/initial.size*100))});
        }
      }
      while(asset?.status==='processing' && alive.current) {
        patch(id,{state:'processing',progress:100});
        await new Promise(resolve=>setTimeout(resolve,1500));
        if(!alive.current)return;
        if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
        asset=await request(`uploads/${asset.id}`);
      }
      if(!alive.current)return;
      if(tasksRef.current.find(row=>row.id===id)?.state==='paused')return;
      if(asset?.status!=='ready') {patch(id,{state:'failed',error:asset?.error||'视频处理失败，请检查文件后重新上传'});return;}
      patch(id,{state:'saving',progress:100});
      if(initial.kind==='image') {
        // 获取最新元数据，仅替换封面，不能用旧页面快照覆盖别人的编辑。
        const latest=await request(`series/${initial.seriesId}`);
        await request(`series/${initial.seriesId}`,{...latest,coverId:asset.id});
      } else {
        await request(`series/${initial.seriesId}/episodes`,{
          number:initial.number,title:initial.title,assetId:asset.id,mode:initial.mode,
          expectedEpisodeId:initial.expectedEpisodeId,expectedAssetId:initial.expectedAssetId,
        });
      }
      patch(id,{state:'ready',error:''}); files.current.delete(id);
      // 顺序刷新，避免并行上传的较早响应把页面分集列表倒退。
      notifications.current=notifications.current.catch(()=>{}).then(async()=>{
        const data=await request(`series/${initial.seriesId}`);if(alive.current)callbacks.current.onUpdated(data);
      });
      await notifications.current;
    } catch(error) {
      if(tasksRef.current.find(row=>row.id===id)?.state!=='paused')patch(id,{state:'failed',error:axios.isAxiosError(error)&&!error.response?'网络连接中断，请检查网络后继续上传':accountError(error)});
    }
  };
  const addFiles=async(list:File[],kind:'video'|'image',replace?:Episode)=>{
    if(!series)return;
    setSelecting(true);setError('');
    try {
      const sorted=[...list].sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'}));
      for(const file of sorted) {
        const valid=kind==='video'?/\.mp4$/i.test(file.name):['image/jpeg','image/png','image/webp'].includes(file.type);
        if(!valid||file.size<=0||file.size>(kind==='image'?8*1024**2:maximum)) {setError('文件格式或大小不符合要求');continue;}
        const digest=await identity(file);
        const existing=tasksRef.current.find(row=>row.seriesId===series.id&&row.kind===kind&&row.name===file.name&&row.size===file.size&&row.modified===file.lastModified&&row.digest===digest&&row.state!=='ready'&&row.mode===(replace?'replace':'append'));
        if(existing) {files.current.set(existing.id,file);patch(existing.id,{state:existing.state==='confirm'?'confirm':'queued',error:''});continue;}
        if(tasksRef.current.some(row=>row.seriesId===series.id&&row.kind==='image'&&row.state!=='ready')&&kind==='image')throw Error('请先完成或移除当前封面任务');
        const used=[...series.episodes.map(ep=>ep.number),...tasksRef.current.filter(row=>row.seriesId===series.id&&row.kind==='video'&&row.state!=='ready').map(row=>row.number)];
        const number=replace?.number||fileNumber(file.name)||Math.max(0,...used)+1;
        const task:Task={id:crypto.randomUUID(),seriesId:series.id,seriesTitle:series.title,name:file.name,size:file.size,modified:file.lastModified,digest,kind,mime:kind==='video'?'video/mp4':file.type,
          number,title:replace?.title||'',mode:replace?'replace':'append',expectedEpisodeId:replace?.id,expectedAssetId:replace?.assetId,state:'confirm',progress:0};
        files.current.set(task.id,file);change(rows=>[...rows,task]);
      }
    } catch(error) {setError(error instanceof Error?error.message:accountError(error));}
    finally {setSelecting(false);setReplacement(null);}
  };
  const current=tasks.filter(row=>row.seriesId===series?.id), pending=current.filter(row=>row.state==='confirm');
  const conflict=pending.some(row=>row.kind==='video'&&(!Number.isInteger(row.number)||row.number<1||row.number>10000||
    (row.mode==='append'&&series?.episodes.some(ep=>ep.number===row.number))||current.some(other=>other.id!==row.id&&other.kind==='video'&&other.state!=='ready'&&other.number===row.number)));
  const allNumbers=new Set([...(series?.episodes.map(ep=>ep.number)||[]),...pending.filter(row=>row.kind==='video').map(row=>row.number)]);
  const last=Math.max(0,...allNumbers), missing=Array.from({length:Math.min(10000,last)},(_,i)=>i+1).filter(number=>!allNumbers.has(number));
  const move=(id:string,targetId:string)=>{
    const rows=pending.filter(row=>row.kind==='video'&&row.mode==='append'), source=rows.findIndex(row=>row.id===id), target=rows.findIndex(row=>row.id===targetId);
    if(source<0||target<0)return;
    const numbers=rows.map(row=>row.number).sort((a,b)=>a-b), [item]=rows.splice(source,1);rows.splice(target,0,item);
    const ids=new Set(rows.map(row=>row.id));let position=0;
    change(all=>all.map(row=>{if(!ids.has(row.id))return row;const next={...rows[position],number:numbers[position]};position++;return next;}));
  };
  const remove=async(task:Task)=>{
    try {if(task.assetId)await axios.delete(`/api/admin/uploads/${task.assetId}`);files.current.delete(task.id);change(rows=>rows.filter(row=>row.id!==task.id));}
    catch(error){setError(accountError(error));}
  };
  const reselect=async(task:Task,file?:File)=>{
    if(!file)return;
    setSelecting(true);setError('');
    try {
      if(file.name!==task.name||file.size!==task.size||file.lastModified!==task.modified||await identity(file)!==task.digest) {setError('请选择原文件，名称、大小或内容不匹配');return;}
      files.current.set(task.id,file);patch(task.id,{state:'queued',error:''});
    } finally {setSelecting(false);}
  };
  return <section hidden={!visible} className="admin-batch">
    <div className="admin-panel-title"><h3>{series?.title||t('封面与批量分集')}</h3><span>{t('前3集免费，后续集数需VIP')}</span></div>
    {!series?<p>{t('先保存剧名，再上传封面与分集')}</p>:<>
      {series.status==='published'&&<p>{t('下架后可调整分集')}</p>}
      <div className="admin-upload-entry">
        <label className="admin-cover-upload"><ImagePlus size={22}/>{t('上传封面')}<input aria-label={t('上传封面')} type="file" accept="image/jpeg,image/png,image/webp" disabled={selecting} onChange={event=>{void addFiles(Array.from(event.target.files||[]),'image');event.target.value='';}}/>{series.cover&&<img src={series.cover} alt={series.title}/>}</label>
        <label className={`admin-batch-drop${dragging?' is-dragging':''}`} onDragOver={event=>{event.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);if(!selecting&&series.status!=='published')void addFiles(Array.from(event.dataTransfer.files),'video');}}>
          <Upload size={28}/><strong>{t('批量上传分集')}</strong><span>{t('拖入或选择多个MP4，确认顺序后开始')}</span><small>{t('单个视频最大{{size}}GB，封面最大8MB',{size:Math.round(maximum/1024**3*10)/10})}</small>
          <input aria-label={t('批量上传分集')} type="file" multiple accept="video/mp4,.mp4" disabled={selecting||series.status==='published'} onChange={event=>{void addFiles(Array.from(event.target.files||[]),'video');event.target.value='';}}/>
        </label>
      </div>
      <p className="admin-upload-hint">{t('视频支持H.264与AAC的MP4，封面支持JPEG、PNG、WebP')}</p>
      {current.length>0&&<div className="admin-batch-summary"><strong>{t('已完成{{done}}／{{total}}个文件',{done:current.filter(row=>row.state==='ready').length,total:current.length})}</strong>{current.some(row=>row.state==='ready')&&<button aria-pressed={showCompleted} onClick={()=>setShowCompleted(value=>!value)}>{t(showCompleted?'收起已完成记录':'查看已完成记录')}</button>}</div>}
      {selecting&&<p role="status">{t('正在检查文件')}</p>}
      {pending.length===0&&missing.length>0&&<p className="admin-upload-hint">{t('缺少第{{numbers}}集，发布前需补齐',{numbers:missing.slice(0,20).join(', ')})}</p>}
      {pending.length>0&&<div className="admin-batch-confirm"><strong>{t('确认集数及排序')}</strong><p>{t('已有集数不会被覆盖；可修改集数或拖动调整顺序')}</p>{conflict&&<p role="alert">{t('集数重复或已存在，请调整后开始')}</p>}{missing.length>0&&<p>{t('缺少第{{numbers}}集，发布前需补齐',{numbers:missing.slice(0,20).join(', ')})}</p>}<button disabled={conflict||selecting||series.status==='published'&&pending.some(row=>row.kind==='video')} onClick={()=>change(rows=>rows.map(row=>row.seriesId===series.id&&row.state==='confirm'?{...row,state:'queued'}:row))}>{t('确认并开始上传')}</button></div>}
      <div className="admin-batch-list" aria-live="polite">{current.map((task,index)=>task.state==='ready'&&!showCompleted?null:<article key={task.id} className={`admin-upload-task is-${task.state}`} draggable={task.state==='confirm'&&task.kind==='video'&&task.mode==='append'} onDragStart={()=>{dragged.current=task.id;}} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();if(dragged.current)move(dragged.current,task.id);dragged.current=null;}}>
        <div className="admin-upload-task-heading">{task.state==='ready'?<CheckCircle2 size={20}/>:task.state==='failed'?<AlertCircle size={20}/>:<Upload size={20}/>}<strong>{task.kind==='video'?t('第{{number}}集',{number:task.number}):t('封面')} · <bdi>{task.name}</bdi></strong><small>{(task.size/1024**2).toFixed(1)} MB</small></div>
        <div className="admin-upload-task-controls">{task.kind==='video'&&<><label>{t('集数')}<input aria-label={`${t('集数')} ${task.name}`} type="number" min={1} max={10000} value={task.number} disabled={task.state!=='confirm'||task.mode==='replace'} onChange={event=>patch(task.id,{number:Number(event.target.value)})}/></label>{task.state==='confirm'&&<label>{t('分集标题')}<input aria-label={`${t('分集标题')} ${task.name}`} maxLength={200} placeholder={t('可留空')} value={task.title} onChange={event=>patch(task.id,{title:event.target.value})}/></label>}{task.mode==='replace'&&<span>{t('替换第{{number}}集',{number:task.number})}</span>}</>}
          <span role="status">{t(labels[task.state])}{task.state==='uploading'?` · ${task.progress}%`:''}</span>
          {task.state==='confirm'&&task.kind==='video'&&task.mode==='append'&&<><button disabled={!current.slice(0,index).some(row=>row.state==='confirm'&&row.kind==='video'&&row.mode==='append')} onClick={()=>{const target=[...current.slice(0,index)].reverse().find(row=>row.state==='confirm'&&row.kind==='video'&&row.mode==='append');if(target)move(task.id,target.id);}}>{t('上移')}</button><button disabled={!current.slice(index+1).some(row=>row.state==='confirm'&&row.kind==='video'&&row.mode==='append')} onClick={()=>{const target=current.slice(index+1).find(row=>row.state==='confirm'&&row.kind==='video'&&row.mode==='append');if(target)move(task.id,target.id);}}>{t('下移')}</button></>}
          {['queued','uploading','processing'].includes(task.state)&&<button onClick={()=>patch(task.id,{state:'paused'})}>{t('暂停')}</button>}
          {['paused','failed'].includes(task.state)&&<button disabled={running.current.has(task.id)} onClick={()=>patch(task.id,{state:'queued',error:''})}>{t('继续上传')}</button>}
          {task.state==='needsFile'&&<label className="admin-reselect">{t('请重新选择原文件')}<input aria-label={`${t('请重新选择原文件')} ${task.name}`} disabled={selecting} type="file" accept={task.kind==='video'?'.mp4':'image/*'} onChange={event=>{void reselect(task,event.target.files?.[0]);event.target.value='';}}/></label>}
          {['confirm','needsFile','paused','failed','ready'].includes(task.state)&&<button disabled={running.current.has(task.id)} onClick={()=>void remove(task)}>{t(task.state==='ready'?'清除记录':'移除')}</button>}
        </div>
        {['uploading','processing','saving'].includes(task.state)&&<progress max={100} value={task.progress}/>}
        {task.error&&<p role="alert">{localizeError(task.error)}</p>}
      </article>)}</div>
      {series.episodes.length>0&&<details className="admin-replace"><summary>{t('替换已有分集')}</summary><p>{t('选择明确替换的集数，原视频保留，其他分集不受影响')}</p><div>{series.episodes.map(ep=><button key={ep.id} disabled={series.status==='published'||selecting||current.some(row=>row.kind==='video'&&row.number===ep.number&&row.state!=='ready')} onClick={()=>{setReplacement(ep);replaceInput.current?.click();}}>{t('替换第{{number}}集',{number:ep.number})}</button>)}</div><input ref={replaceInput} aria-label={t('替换已有分集')} type="file" accept="video/mp4,.mp4" hidden onChange={event=>{void addFiles(Array.from(event.target.files||[]),'video',replacement||undefined);event.target.value='';}}/></details>}
      <p className="admin-upload-hint">{t('切换模块不会中断上传；刷新后重选原文件可续传，已上传文件会继续处理')}</p>
    </>}
    {error&&<p role="alert">{localizeError(error)}</p>}
  </section>;
}
