import { historyUuid } from './history-outbox.mjs';
export class LibraryJournal {
 constructor(storage,namespace,send,uuid=historyUuid,clock=()=>performance.now()){this.storage=storage;this.prefix=`hg_library_pending_v1:${namespace}:`;this.send=send;this.uuid=uuid;this.clock=clock;this.busy=null;this.sent=new Map();}
 entries(){const rows=[];for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(this.prefix)){const event=JSON.parse(this.storage.getItem(key));if(event)rows.push({key,event});}}return rows.sort((a,b)=>a.event.at-b.event.at||a.event.id.localeCompare(b.event.id));}
 save(operation){const event={...operation,id:this.uuid()};const key=this.prefix+event.id;this.storage.setItem(key,JSON.stringify(event));for(const row of this.entries())if(row.key!==key&&row.event.kind===event.kind&&(row.event.key===event.key||event.op==='clear')&&row.event.at<=event.at)this.storage.removeItem(row.key);return event;}
 flush(force=false){
  if(this.busy)return force?this.busy.then(()=>this.flush(true)):this.busy;
  this.busy=(async()=>{
   const now=this.clock();for(const [key,row] of this.sent)if(now-row.at>60000)this.sent.delete(key);
   for(const row of this.entries()){
    const event=row.event,key=`${event.kind}:${event.key}`,last=this.sent.get(key);
    // 本地进度实时落盘；重复进度合并上传，删除、完播及换集不等待节流周期。
    const frequent=['history','recommendation'].includes(event.kind)&&event.op==='set'&&!event.value?.completed;
    if(!force&&frequent&&last&&last.episodeId===event.value?.episodeId&&this.clock()-last.at<5000)continue;
    await this.send(event);this.sent.set(key,{at:this.clock(),episodeId:event.value?.episodeId});this.storage.removeItem(row.key);
   }
  })().finally(()=>{this.busy=null;});return this.busy;
 }
}
