import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class LibraryError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail = message => { throw new LibraryError(400,message); };
const text = (value,name,max=256) => typeof value==='string' && value.trim() && value.length<=max ? value : fail(`invalid ${name}`);
const number = (value,name,min=0,max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value)&&value>=min&&value<=max ? value : fail(`invalid ${name}`);
const contentTypes=['real-drama','comic-drama','ai-drama'];
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
    this.compactLocal=compactLocal;this.compactionTicks=0;this.compactionBacklog=false;
    if(filename!==':memory:')mkdirSync(dirname(filename),{recursive:true});
    this.db=new DatabaseSync(filename);
    if(compactLocal&&this.db.prepare('PRAGMA page_count').get().page_count===0)this.db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS library_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_events(revision INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,device_id TEXT NOT NULL,seq INTEGER NOT NULL,kind TEXT NOT NULL,item_key TEXT NOT NULL,event_time INTEGER NOT NULL,event_json TEXT NOT NULL,fingerprint TEXT NOT NULL,is_local INTEGER NOT NULL,UNIQUE(device_id,seq));
      CREATE INDEX IF NOT EXISTS library_event_item ON library_events(kind,item_key,event_time);
      CREATE TABLE IF NOT EXISTS library_records(kind TEXT NOT NULL,item_key TEXT NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(kind,item_key));
      CREATE TABLE IF NOT EXISTS library_ack(target TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(target,event_id));`);
    for(const key of ['deviceId','instanceId'])if(!this.getMeta(key))this.setMeta(key,randomUUID());
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
      const clock=Math.round(Date.now()+(this.getMeta('clockOffset')||0));
      const last=this.getMeta('lastTime')||0;
      const at=input.at??Math.max(clock,Math.abs(last-clock)>300000?clock:last+1);
      const event=validateEvent({...input,id:input.id||randomUUID(),deviceId:this.getMeta('deviceId'),seq,at});
      if(this.compactLocal&&input.at!=null&&['history','recommendation'].includes(event.kind)){
        const floor=this.db.prepare('SELECT event_time FROM library_compact_floor WHERE kind=? AND item_key=?').get(event.kind,event.key);
        // 已整理的旧进度只能作为过期重试确认，不能复活删除记录或覆盖新的续播位置。
        if(floor&&event.at<=floor.event_time)return {...event,ignored:true};
      }
      if(event.op==='clear'&&this.canCompact()&&['history','recommendation'].includes(event.kind))this.db.prepare("DELETE FROM library_records WHERE kind=? AND item_key<>'*' AND json_extract(event_json,'$.at')<=?").run(event.kind,event.at);
      this.setMeta('sequence',seq);this.setMeta('lastTime',at);this.insert(event,1);
      if(this.compactLocal&&input.at==null&&['history','recommendation'].includes(event.kind))this.db.prepare('INSERT OR IGNORE INTO library_pins VALUES(?)').run(event.id);
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
  insert(event,isLocal,original=event) {
    const known=this.db.prepare('SELECT * FROM library_events WHERE id=?').get(event.id);
    if(known){
      if(known.fingerprint!==fingerprint(original)&&fingerprint(JSON.parse(known.event_json))!==fingerprint(original))throw new LibraryError(409,'event ID was reused');
      return JSON.parse(known.event_json);
    }
    try {this.db.prepare('INSERT INTO library_events(id,device_id,seq,kind,item_key,event_time,event_json,fingerprint,is_local) VALUES(?,?,?,?,?,?,?,?,?)').run(event.id,event.deviceId,event.seq,event.kind,event.key,event.at,JSON.stringify(event),fingerprint(original),isLocal);}
    catch(error){if(error.message.includes('UNIQUE'))throw new LibraryError(409,'device sequence was reused');throw error;}
    this.materialize(event);return event;
  }
  canCompact(){
    return this.compactLocal&&!this.getMeta('syncConfig')&&!this.db.prepare("SELECT 1 FROM library_meta WHERE key LIKE 'seed:%' OR key LIKE 'cursor:%' LIMIT 1").get()&&!this.db.prepare('SELECT 1 FROM library_ack LIMIT 1').get()&&!this.db.prepare('SELECT 1 FROM library_events WHERE is_local=0 LIMIT 1').get();
  }
  maintain(force=false){
    if(!this.compactLocal || !force&&!this.compactionBacklog&&this.compactionTicks++%64!==0 || !this.canCompact())return 0;
    const maximum=this.db.prepare('SELECT MAX(revision) AS revision FROM library_events').get().revision||0;
    const rows=this.db.prepare(`SELECT e.* FROM library_events e WHERE e.kind IN ('history','recommendation') AND e.revision<=? AND NOT EXISTS(SELECT 1 FROM library_pins p WHERE p.id=e.id) AND NOT EXISTS(SELECT 1 FROM library_records r WHERE r.kind=e.kind AND r.item_key=e.item_key AND json_extract(r.event_json,'$.id')=e.id) ORDER BY e.revision LIMIT 512`).all(maximum-256);
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
    else if(pages*size<=32*1024**2&&free*size>=1024**2&&free>pages*.75)this.db.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return rows.length;
  }
  materialize(event) {
    const row=this.db.prepare('SELECT event_json FROM library_records WHERE kind=? AND item_key=?').get(event.kind,event.key);
    if(row&&compareEvents(event,JSON.parse(row.event_json))<=0)return;
    this.db.prepare('INSERT INTO library_records VALUES(?,?,?) ON CONFLICT(kind,item_key) DO UPDATE SET event_json=excluded.event_json').run(event.kind,event.key,JSON.stringify(event));
  }
  receive(inputs,{clampFuture=false,canonical=false}={}) {
    if(!Array.isArray(inputs)||inputs.length>256)fail('at most 256 events are allowed');
    const events=inputs.map(validateEvent);
    return this.transaction(()=>events.map(original=>{
      const event=clampFuture?{...original,at:Math.min(original.at,Date.now()+300000)}:original;
      const known=this.db.prepare('SELECT * FROM library_events WHERE id=?').get(event.id);
      if(canonical&&known){
        const previous=JSON.parse(known.event_json);
        if(fingerprint({...previous,at:event.at})!==fingerprint(event))throw new LibraryError(409,'canonical event changed identity');
        if(previous.at!==event.at){
          this.db.prepare('UPDATE library_events SET event_time=?,event_json=? WHERE id=?').run(event.at,JSON.stringify(event),event.id);
          const winner=this.db.prepare('SELECT event_json FROM library_events WHERE kind=? AND item_key=? ORDER BY event_time DESC,device_id DESC,seq DESC LIMIT 1').get(event.kind,event.key);
          this.db.prepare('INSERT INTO library_records VALUES(?,?,?) ON CONFLICT(kind,item_key) DO UPDATE SET event_json=excluded.event_json').run(event.kind,event.key,winner.event_json);
        }
        return event;
      }
      return this.insert(event,0,original);
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
      preferences:Object.fromEntries([['quality','1080P'],['speed',1],['recommendationMode','mixed'],['recommendationResetAt',0],...active.filter(e=>e.kind==='preference').map(e=>[e.key,e.value.value])])};
  }
  pending(target,limit=256){return this.db.prepare('SELECT event_json FROM library_events WHERE is_local=1 AND id NOT IN(SELECT event_id FROM library_ack WHERE target=?) ORDER BY revision LIMIT ?').all(target,limit).map(row=>JSON.parse(row.event_json));}
  acknowledge(target,ids){this.transaction(()=>{const statement=this.db.prepare('INSERT OR IGNORE INTO library_ack VALUES(?,?)');for(const id of ids)statement.run(target,id);});}
  changes(cursor=0,limit=256){number(cursor,'cursor');number(limit,'limit',1,256);const rows=this.db.prepare('SELECT revision,event_json FROM library_events WHERE revision>? ORDER BY revision LIMIT ?').all(cursor,limit+1);return{events:rows.slice(0,limit).map(row=>({revision:row.revision,...JSON.parse(row.event_json)})),cursor:rows.length?rows[Math.min(rows.length,limit)-1].revision:cursor,hasMore:rows.length>limit};}
  seedTarget(target){if(this.getMeta(`seed:${target}`))return;this.transaction(()=>{
    for(const row of this.db.prepare('SELECT event_json FROM library_records').all()){
      const event=JSON.parse(row.event_json);
      this.db.prepare('UPDATE library_events SET is_local=1 WHERE id=?').run(event.id);
    }
    this.setMeta(`seed:${target}`,true);
  });}
}
