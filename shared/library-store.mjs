import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class LibraryError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail = message => { throw new LibraryError(400,message); };
const text = (value,name,max=256) => typeof value==='string' && value.trim() && value.length<=max ? value : fail(`invalid ${name}`);
const number = (value,name,min=0,max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)&&value>=min&&value<=max ? value : fail(`invalid ${name}`);
const contentTypes=['real-drama','comic-drama','ai-drama'];
const compactableKinds=['history','recommendation','favorite','search'];
const contentType = value => contentTypes.includes(value) ? value : fail('invalid content type');
const series = value => ({id:text(value?.id,'series id'),title:text(value?.title,'title',1000),...Object.fromEntries(['cover','description','badge','tags'].map(key=>[key,typeof value[key]==='string'?value[key].slice(0,key==='description'?20000:8192):''])),...(value.contentType==null?{}:{contentType:contentType(value.contentType)})});
export function validateEvent(input) {
  if (!input || typeof input!=='object') fail('event required');
  const event={id:text(input.id,'event id'),deviceId:text(input.deviceId,'device id'),seq:number(input.seq,'sequence',1),kind:input.kind,key:text(input.key,'key',1000),op:input.op,at:number(input.at,'event time'),value:null};
  if (!['history','favorite','search','preference','recommendation'].includes(event.kind)||!['set','delete','clear'].includes(event.op)) fail('invalid event kind or operation');
  if (event.op==='clear') { if(event.key!=='*'||event.kind==='preference')fail('invalid clear'); return event; }
  if (event.key==='*') fail('reserved key');
  if(event.kind==='recommendation') {
    const parts=event.key.split(':');
    if(parts.length!==2)fail('invalid recommendation key');
    text(parts[0],'session id');text(parts[1],'series id');
  }
  if (event.op==='delete') { if(event.kind==='preference')fail('preferences must be reset explicitly'); return event; }
  const value=input.value;
  if(event.kind==='favorite') {event.value=series(value);if(event.value.id!==event.key)fail('favorite key mismatch');}
  if(event.kind==='history') {
    const metadata=series({...value,id:value?.seriesId});
    if(metadata.id!==event.key)fail('history key mismatch');
    event.value={seriesId:metadata.id,title:metadata.title,cover:metadata.cover,description:metadata.description,badge:metadata.badge,tags:metadata.tags,...(metadata.contentType?{contentType:metadata.contentType}:{}),
      episodeId:text(value.episodeId,'episode id'),episodeNumber:number(value.episodeNumber,'episode number',1,1000000),positionMs:number(value.positionMs,'position',0,31536000000),durationMs:number(value.durationMs??0,'duration',0,31536000000),completed:value.completed??false};
    if(typeof event.value.completed!=='boolean')fail('invalid completed state');
  }
  if(event.kind==='search') {const query=text(value?.query,'query',1000).trim();if(query.toLowerCase()!==event.key)fail('search key mismatch');event.value={query};}
  if(event.kind==='recommendation') {
    const seriesId=text(value?.seriesId,'series id');
    if(event.key.split(':')[1]!==seriesId)fail('recommendation key mismatch');
    if(typeof value.tags!=='string'||value.tags.length>8192)fail('invalid recommendation tags');
    if(typeof value.completed!=='boolean')fail('invalid completed state');
    event.value={seriesId,title:text(value.title,'title',1000),tags:value.tags,contentType:contentType(value.contentType),watchMs:number(value.watchMs,'watch time'),exposures:number(value.exposures,'exposures'),skips:number(value.skips,'skips'),completed:value.completed};
  }
  if(event.kind==='preference') {
    if(event.key==='quality') event.value={value:text(value?.value,'quality',32)};
    else if(event.key==='speed'&&typeof value?.value==='number'&&Number.isFinite(value.value)&&value.value>=.25&&value.value<=4)event.value={value:value.value};
    else if(event.key==='recommendationMode'&&['mixed',...contentTypes].includes(value?.value))event.value={value:value.value};
    else if(event.key==='recommendationResetAt')event.value={value:number(value?.value,'recommendation reset time')};
    else fail('invalid preference');
  }
  return event;
}
export function compareEvents(a,b) {return a.at-b.at || (a.deviceId<b.deviceId?-1:a.deviceId>b.deviceId?1:0) || a.seq-b.seq;}
const fingerprint = event => createHash('sha256').update(JSON.stringify(event)).digest('hex');

export class LibraryStore {
  constructor(filename,{compactLocal=false}={}) {
    this.compactLocal=compactLocal;this.compactionTicks=0;this.compactionBacklog=false;this.counts=new Map();this.readInstance=randomUUID();this.mutations=0;
    if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    if(compactLocal&&this.db.prepare('PRAGMA page_count').get().page_count===0)this.db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS library_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_events(revision INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,device_id TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,item_key TEXT NOT NULL,event_time INTEGER NOT NULL,event_json TEXT NOT NULL,fingerprint TEXT NOT NULL,is_local INTEGER NOT NULL,UNIQUE(device_id,seq));
      CREATE INDEX IF NOT EXISTS library_event_item ON library_events(kind,item_key,event_time);
      CREATE TABLE IF NOT EXISTS library_records(kind TEXT NOT NULL,item_key TEXT NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(kind,item_key));
      CREATE INDEX IF NOT EXISTS library_record_order ON library_records(kind,json_extract(event_json,'$.at') DESC,json_extract(event_json,'$.deviceId') DESC,json_extract(event_json,'$.seq') DESC);`);
    this.db.exec("DROP TABLE IF EXISTS library_ack; DELETE FROM library_meta WHERE key='syncConfig' OR key='clockOffset' OR key='instanceId' OR key LIKE 'seed:%' OR key LIKE 'cursor:%'");
    if(!this.getMeta('deviceId'))this.setMeta('deviceId',randomUUID());
    if(compactLocal){
      this.db.exec(`CREATE TABLE IF NOT EXISTS library_receipts(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,seq INTEGER NOT NULL,event_time INTEGER NOT NULL,fingerprint TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS library_compact_floor(kind TEXT NOT NULL,item_key TEXT NOT NULL,event_time INTEGER NOT NULL,PRIMARY KEY(kind,item_key));
        CREATE TABLE IF NOT EXISTS library_pins(id TEXT PRIMARY KEY);`);
      this.maintain(true);
    }
  }
  close(){this.db.close();}
  getMeta(key){const row=this.db.prepare('SELECT value FROM library_meta WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
  setMeta(key,value){this.db.prepare('INSERT INTO library_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{/* SQLite满额时可能已自动回滚，保留原始错误供调用方识别。 */}throw error;}}
  write(input) {
    this.maintain();const result=this.transaction(()=>this.writeInTransaction(input));
    if(input.op==='clear')this.maintain(true);return result;
  }
  writeInTransaction(input) {
      if(input.id){const previous=this.db.prepare('SELECT * FROM library_events WHERE id=?').get(input.id);if(previous){const saved=JSON.parse(previous.event_json);const retry=validateEvent({...input,deviceId:saved.deviceId,seq:saved.seq,at:input.at??saved.at});if(fingerprint(retry)!==previous.fingerprint&&fingerprint(retry)!==fingerprint(saved))throw new LibraryError(409,'operation ID was reused');return saved;}}
      if(this.compactLocal&&input.id){
        const receipt=this.db.prepare('SELECT * FROM library_receipts WHERE id=?').get(input.id);
        if(receipt){const retry=validateEvent({...input,deviceId:receipt.device_id,seq:receipt.seq,at:input.at??receipt.event_time});if(fingerprint(retry)!==receipt.fingerprint)throw new LibraryError(409,'操作编号不能重复用于不同内容');return retry;}
      }
      const seq=(this.getMeta('sequence')||0)+1;
      const clock=Date.now();
      const last=this.getMeta('lastTime')||0;
      const at=input.at??Math.max(clock,Math.abs(last-clock)>300000?clock:last+1);
      const event=validateEvent({...input,id:input.id||randomUUID(),deviceId:this.getMeta('deviceId'),seq,at});
      if(this.compactLocal&&input.at!=null&&compactableKinds.includes(event.kind)){
        const floor=this.db.prepare('SELECT event_time FROM library_compact_floor WHERE kind=? AND item_key=?').get(event.kind,event.key);
        // 已整理的旧进度只能作为过期重试确认，不能复活删除记录或覆盖新的续播位置。
        if(floor&&event.at<=floor.event_time)return {...event,ignored:true};
      }
      if(event.op==='clear'&&this.canCompact()&&compactableKinds.includes(event.kind))this.db.prepare("DELETE FROM library_records WHERE kind=? AND item_key<>'*' AND json_extract(event_json,'$.at')<=?").run(event.kind,event.at);
      this.setMeta('sequence',seq);this.setMeta('lastTime',at);this.insert(event);
      if(this.compactLocal&&input.at==null&&compactableKinds.includes(event.kind))this.db.prepare('INSERT OR IGNORE INTO library_pins VALUES(?)').run(event.id);
      return event;
  }
  writeBatch(inputs) {
    if(!Array.isArray(inputs)||inputs.length>256)fail('每批最多导入256条资料');
    this.maintain();
    return this.transaction(()=>inputs.map(input=>this.writeInTransaction(input)));
  }
  importOperations({migrationId,operations,offset=0,total=operations?.length}) {
    const id=text(migrationId,'迁移编号');
    if(!Array.isArray(operations)||operations.length>256)fail('每批最多导入256条资料');
    number(offset,'迁移位置',0,10000);number(total,'迁移总数',0,10000);
    if(offset+operations.length>total || !operations.length && offset!==total)fail('迁移批次无效');
    if(this.getMeta(`migration:${id}`))return {ok:true,next:total,complete:true};
    const progressKey=`migration-progress:${id}`,progress=this.getMeta(progressKey)||{next:0,total};
    if(progress.total!==total || offset>progress.next || offset<progress.next && offset+operations.length>progress.next)throw new LibraryError(409,'迁移批次已变化，请重新加载');
    return this.transaction(()=>{
      for(let index=0;index<operations.length;index++){
        // 兼容旧版本已提交的操作编号，长编号改用固定长度摘要。
        const raw=`migration:${id}:${offset+index}`,eventId=raw.length<=256?raw:`migration:${createHash('sha256').update(id).digest('hex')}:${offset+index}`;
        this.writeInTransaction({...operations[index],id:eventId});
      }
      const next=Math.max(progress.next,offset+operations.length),complete=next===total;
      if(complete){this.setMeta(`migration:${id}`,true);this.db.prepare('DELETE FROM library_meta WHERE key=?').run(progressKey);}
      else this.setMeta(progressKey,{next,total});
      return {ok:true,next,complete};
    });
  }
  insert(event,original=event) {
    const known=this.db.prepare('SELECT * FROM library_events WHERE id=?').get(event.id);
    if(known){
      if(known.fingerprint!==fingerprint(original)&&fingerprint(JSON.parse(known.event_json))!==fingerprint(original))throw new LibraryError(409,'event ID was reused');
      return JSON.parse(known.event_json);
    }
    try {this.db.prepare('INSERT INTO library_events(id,device_id,seq,kind,item_key,event_time,event_json,fingerprint,is_local) VALUES(?,?,?,?,?,?,?,?,1)').run(event.id,event.deviceId,event.seq,event.kind,event.key,event.at,JSON.stringify(event),fingerprint(original));}
    catch(error){if(error.message.includes('UNIQUE'))throw new LibraryError(409,'device sequence was reused');throw error;}
    this.materialize(event);return event;
  }
  canCompact(){
    return this.compactLocal;
  }
  maintain(force=false){
    if(!this.compactLocal || !force&&!this.compactionBacklog&&this.compactionTicks++%64!==0 || !this.canCompact())return 0;
    const maximum=this.db.prepare('SELECT MAX(revision) AS revision FROM library_events').get().revision||0;
    const rows=this.db.prepare(`SELECT e.* FROM library_events e WHERE e.kind IN ('history','recommendation','favorite','search') AND e.revision<=? AND NOT EXISTS(SELECT 1 FROM library_pins p WHERE p.id=e.id) AND NOT EXISTS(SELECT 1 FROM library_records r WHERE r.kind=e.kind AND r.item_key=e.item_key AND json_extract(r.event_json,'$.id')=e.id) ORDER BY e.revision LIMIT 512`).all(maximum-256);
    this.compactionBacklog=rows.length===512;if(!rows.length)return 0;
    this.transaction(()=>{
      const remove=this.db.prepare('DELETE FROM library_events WHERE id=?'),receipt=this.db.prepare('INSERT OR REPLACE INTO library_receipts VALUES(?,?,?,?,?)'),floor=this.db.prepare('INSERT INTO library_compact_floor VALUES(?,?,?) ON CONFLICT(kind,item_key) DO UPDATE SET event_time=MAX(event_time,excluded.event_time)');
      // 先释放旧日志页面，再存小体积重试凭据；已接近页数上限的库也能整理。
      for(const row of rows)remove.run(row.id);
      for(const row of rows){receipt.run(row.id,row.device_id,row.seq,row.event_time,row.fingerprint);floor.run(row.kind,row.item_key,row.event_time);}
      this.db.exec('DELETE FROM library_receipts WHERE id IN (SELECT id FROM library_receipts ORDER BY seq DESC LIMIT -1 OFFSET 512)');
    });
    const pages=this.db.prepare('PRAGMA page_count').get().page_count,free=this.db.prepare('PRAGMA freelist_count').get().freelist_count,size=this.db.prepare('PRAGMA page_size').get().page_size;
    if(this.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum===2)this.db.exec('PRAGMA incremental_vacuum(128)');
    else if(pages*size<=256*1024**2&&free*size>=1024**2&&free>pages*.5)this.db.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return rows.length;
  }
  materialize(event) {
    this.counts.clear();this.mutations++;
    const row=this.db.prepare('SELECT event_json FROM library_records WHERE kind=? AND item_key=?').get(event.kind,event.key);
    if(row&&compareEvents(event,JSON.parse(row.event_json))<=0)return;
    this.db.prepare('INSERT INTO library_records VALUES(?,?,?) ON CONFLICT(kind,item_key) DO UPDATE SET event_json=excluded.event_json').run(event.kind,event.key,JSON.stringify(event));
  }
  importEvents(inputs,{canonical=false}={}) {
    if(!Array.isArray(inputs)||inputs.length>256)fail('at most 256 events are allowed');
    const events=inputs.map(validateEvent);
    return this.transaction(()=>events.map(original=>{
      const event=original;
      const known=this.db.prepare('SELECT * FROM library_events WHERE id=?').get(event.id);
      if(canonical&&known){
        const previous=JSON.parse(known.event_json);
        if(fingerprint({...previous,at:event.at})!==fingerprint(event))throw new LibraryError(409,'canonical event changed identity');
        if(previous.at!==event.at){
          this.counts.clear();this.mutations++;
          this.db.prepare('UPDATE library_events SET event_time=?,event_json=? WHERE id=?').run(event.at,JSON.stringify(event),event.id);
          const winner=this.db.prepare('SELECT event_json FROM library_events WHERE kind=? AND item_key=? ORDER BY event_time DESC,device_id DESC,seq DESC LIMIT 1').get(event.kind,event.key);
          this.db.prepare('INSERT INTO library_records VALUES(?,?,?) ON CONFLICT(kind,item_key) DO UPDATE SET event_json=excluded.event_json').run(event.kind,event.key,winner.event_json);
        }
        return event;
      }
      return this.insert(event,original);
    }));
  }
  snapshot() {
    const events=this.db.prepare('SELECT event_json FROM library_records').all().map(row=>JSON.parse(row.event_json));
    const clears=new Map(events.filter(event=>event.op==='clear').map(event=>[event.kind,event]));
    const active=events.filter(event=>event.op==='set'&&(!clears.has(event.kind)||compareEvents(event,clears.get(event.kind))>0)).sort((a,b)=>compareEvents(b,a));
    return {favorites:active.filter(e=>e.kind==='favorite').map(e=>({...e.value,updatedAt:e.at})),
      history:active.filter(e=>e.kind==='history').map(e=>({...e.value,updatedAt:e.at})),
      recommendationSignals:active.filter(e=>e.kind==='recommendation').map(e=>({...e.value,sessionId:e.key.split(':')[0],updatedAt:e.at})),
      searchHistory:active.filter(e=>e.kind==='search').slice(0,10).map(e=>e.value.query),
      preferences:Object.fromEntries([['quality','auto'],['speed',1],['recommendationMode','mixed'],['recommendationResetAt',0],...active.filter(e=>e.kind==='preference').map(e=>[e.key,e.value.value])])};
  }
  record(kind,key){
    const row=this.db.prepare('SELECT event_json FROM library_records WHERE kind=? AND item_key=?').get(kind,key);
    const clear=this.db.prepare("SELECT event_json FROM library_records WHERE kind=? AND item_key='*'").get(kind),event=row&&JSON.parse(row.event_json);
    return event?.op==='set'&&(!clear||compareEvents(event,JSON.parse(clear.event_json))>0)?{...event.value,updatedAt:event.at}:null;
  }
  listPage(kind,{limit=50,cursor=''}={}){
    if(!['favorite','history','recommendation','search','preference'].includes(kind))fail('资料类型无效');
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('资料分页无效');let before=[Number.MAX_SAFE_INTEGER,'\uffff',Number.MAX_SAFE_INTEGER];
    if(cursor){try{before=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(before)||before.length!==3||!Number.isSafeInteger(before[0])||typeof before[1]!=='string'||before[1].length>256||!Number.isSafeInteger(before[2]))throw Error();}catch{fail('资料分页无效');}}
    const row=this.db.prepare("SELECT event_json FROM library_records WHERE kind=? AND item_key='*'").get(kind),clear=row?JSON.parse(row.event_json):{at:-1,deviceId:'',seq:0};
    const active="kind=? AND json_extract(event_json,'$.op')='set' AND (json_extract(event_json,'$.at'),json_extract(event_json,'$.deviceId'),json_extract(event_json,'$.seq'))>(?,?,?)",bindings=[kind,clear.at,clear.deviceId,clear.seq];
    if(!this.counts.has(kind))this.counts.set(kind,this.db.prepare(`SELECT COUNT(*) AS count FROM library_records WHERE ${active}`).get(...bindings).count);
    const rows=this.db.prepare(`SELECT event_json FROM library_records WHERE ${active} AND (json_extract(event_json,'$.at'),json_extract(event_json,'$.deviceId'),json_extract(event_json,'$.seq'))<(?,?,?) ORDER BY json_extract(event_json,'$.at') DESC,json_extract(event_json,'$.deviceId') DESC,json_extract(event_json,'$.seq') DESC LIMIT ?`).all(...bindings,...before,limit+1);
    const events=[];let bytes=0;
    for(const row of rows){const size=Buffer.byteLength(row.event_json);if(events.length>=limit||events.length&&bytes+size>1048576)break;events.push(JSON.parse(row.event_json));bytes+=size;}
    const last=events.at(-1),more=events.length<rows.length;
    return {items:events.map(event=>({...event.value,...(kind==='preference'?{key:event.key}:{}),...(kind==='recommendation'?{sessionId:event.key.split(':')[0]}:{}),updatedAt:event.at})),count:this.counts.get(kind),next:more&&last?Buffer.from(JSON.stringify([last.at,last.deviceId,last.seq])).toString('base64url'):null};
  }
  snapshotPage(){
    const favorites=this.listPage('favorite'),history=this.listPage('history'),recommendation=this.listPage('recommendation'),preferences=this.listPage('preference'),search=this.listPage('search',{limit:10});
    return {favorites:favorites.items,history:history.items,recommendationSignals:recommendation.items,searchHistory:search.items.map(item=>item.query),preferences:{quality:'auto',speed:1,recommendationMode:'mixed',recommendationResetAt:0,...Object.fromEntries(preferences.items.map(item=>[item.key,item.value]))},pagination:{favorite:{next:favorites.next,count:favorites.count},history:{next:history.next,count:history.count},recommendation:{next:recommendation.next,count:recommendation.count}}};
  }
  profile(){
    // 推荐只读取真实偏好字段，不加载完整简介、封面和事件日志。
    const snapshot=this.snapshotPage();
    const select=kind=>{
      const row=this.db.prepare("SELECT event_json FROM library_records WHERE kind=? AND item_key='*'").get(kind),clear=row?JSON.parse(row.event_json):{at:-1,deviceId:'',seq:0};
      return this.db.prepare("SELECT item_key AS id,json_extract(event_json,'$.value.tags') AS tags,json_extract(event_json,'$.value.badge') AS badge,json_extract(event_json,'$.value.contentType') AS contentType,json_extract(event_json,'$.value.completed') AS completed,json_extract(event_json,'$.value.episodeNumber') AS episodeNumber,json_extract(event_json,'$.value.positionMs') AS positionMs,json_extract(event_json,'$.value.durationMs') AS durationMs,json_extract(event_json,'$.value.watchMs') AS watchMs,json_extract(event_json,'$.value.exposures') AS exposures,json_extract(event_json,'$.value.skips') AS skips,json_extract(event_json,'$.at') AS updatedAt FROM library_records WHERE kind=? AND json_extract(event_json,'$.op')='set' AND (json_extract(event_json,'$.at'),json_extract(event_json,'$.deviceId'),json_extract(event_json,'$.seq'))>(?,?,?)").all(kind,clear.at,clear.deviceId,clear.seq);
    };
    return {...snapshot,favorites:select('favorite'),history:select('history').map(({id,...item})=>({...item,seriesId:id,completed:!!item.completed})),recommendationSignals:select('recommendation').map(({id,...item})=>({...item,seriesId:id.split(':')[1],completed:!!item.completed}))};
  }
}
