import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {LibraryStore} from '../shared/library-store.mjs';
import {LibraryJournal} from '../apps/web-pc/src/library-journal.mjs';
import {PlaybackGuard} from '../server/playback-guard.mjs';
import {TrafficBudget} from '../server/traffic-budget.mjs';

const progress=(id,at,positionMs=at)=>({id,kind:'history',key:'91',op:'set',at,value:{seriesId:'91',title:'续播日志回归',episodeId:'101',episodeNumber:1,positionMs,durationMs:1000000,completed:false}});
const count=store=>store.db.prepare('SELECT COUNT(*) AS count FROM library_events').get().count;
class Storage{constructor(){this.rows=new Map();}get length(){return this.rows.size;}key(index){return [...this.rows.keys()][index];}getItem(key){return this.rows.get(key)||null;}setItem(key,value){this.rows.set(key,value);}removeItem(key){this.rows.delete(key);}}

test('同一IP的25名已验证观众不会互相占用匿名IP额度，单观众及全站保护仍生效',()=>{
  const guard=new PlaybackGuard({CONTENT_MAX_IP_STREAMS:1,CONTENT_MAX_ACTIVE_STREAMS:28,CONTENT_MAX_VIEWER_STREAMS:1}),pairs=[];
  try{
    for(let index=0;index<25;index++){const req=new EventEmitter(),res=new EventEmitter();guard.acquire(req,res,`观众${index}`,'共享网络',true);pairs.push([req,res]);}
    assert.equal(guard.active,25);assert.throws(()=>guard.acquire(new EventEmitter(),new EventEmitter(),'观众0','共享网络',true),error=>error.status===429);
    const req=new EventEmitter(),res=new EventEmitter();guard.acquire(req,res,'匿名请求','共享网络');pairs.push([req,res]);
    assert.throws(()=>guard.acquire(new EventEmitter(),new EventEmitter(),'另一个匿名请求','共享网络'),error=>error.status===429);
    for(let index=25;index<27;index++){const req=new EventEmitter(),res=new EventEmitter();guard.acquire(req,res,`观众${index}`,'共享网络',true);pairs.push([req,res]);}
    assert.throws(()=>guard.acquire(new EventEmitter(),new EventEmitter(),'超出全站容量','其他网络',true),error=>error.status===429);
  }finally{for(const [req,res] of pairs){res.emit('finish');res.emit('close');req.emit('aborted');}}
  assert.equal(guard.active,0);assert.equal(guard.addresses.size,0);assert.equal(guard.anonymousAddresses.size,0);
});

test('进度实时保存在本地，间隔内合并上传，强制保存及换集不等待',async()=>{
  let now=0,id=0;const storage=new Storage(),sent=[],journal=new LibraryJournal(storage,'回归',async event=>sent.push(event),()=>String(++id),()=>now);
  journal.save(progress('忽略外部编号',1,1000));await journal.flush();
  now=1000;journal.save(progress('忽略外部编号',2,2000));await journal.flush();assert.equal(sent.length,1);assert.equal(journal.entries()[0].event.value.positionMs,2000);
  now=5000;journal.save(progress('忽略外部编号',3,3000));await journal.flush();assert.equal(sent.length,2);assert.equal(sent[1].value.positionMs,3000);
  now=5100;journal.save(progress('忽略外部编号',4,4000));await journal.flush(true);assert.equal(sent.length,3);
  journal.save({...progress('忽略外部编号',5,0),value:{...progress('忽略外部编号',5).value,episodeId:'102'}});await journal.flush();assert.equal(sent.length,4);assert.equal(storage.length,0);
});

test('正在上传的旧进度不会吞掉随后强制保存的新进度，离线失败保留待上传数据',async()=>{
  const storage=new Storage();let id=0,release;const sent=[];
  const journal=new LibraryJournal(storage,'回归',async event=>{sent.push(event);if(sent.length===1)await new Promise(resolve=>{release=resolve;});},()=>String(++id),()=>0);
  journal.save(progress('忽略外部编号',1,1000));const first=journal.flush();journal.save(progress('忽略外部编号',2,2000));const forced=journal.flush(true);release();await Promise.all([first,forced]);assert.equal(sent.length,2);assert.equal(sent[1].value.positionMs,2000);assert.equal(storage.length,0);
  const offline=new LibraryJournal(storage,'回归',async()=>{throw Error('独立回归模拟离线');});offline.save(progress('忽略外部编号',3,3000));await assert.rejects(offline.flush(true));assert.equal(offline.entries()[0].event.value.positionMs,3000);
});

test('旧H5日志分批整理并释放空间，保留真实续播、收藏、近期重试与过期重试边界',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-local-compaction-')),file=path.join(directory,'library.sqlite');let store=new LibraryStore(file);
  t.after(async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});});
  for(let index=1;index<=3000;index++)store.write(progress(`进度${index}`,index));store.write({kind:'favorite',key:'91',op:'set',at:3001,value:{id:'91',title:'保留的收藏'}});
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before=store.snapshot(),oldSize=(await fs.stat(file)).size;store.close();store=new LibraryStore(file,{compactLocal:true});while(store.maintain(true)){}
  assert.deepEqual(store.snapshot(),before);assert.ok(count(store)<=258);assert.ok((await fs.stat(file)).size<oldSize,JSON.stringify({oldSize,size:(await fs.stat(file)).size,pages:store.db.prepare('PRAGMA page_count').get(),free:store.db.prepare('PRAGMA freelist_count').get()}));assert.ok(store.db.prepare('SELECT COUNT(*) AS count FROM library_receipts').get().count<=512);
  assert.equal(store.write(progress('进度2500',2500)).seq,2500);assert.throws(()=>store.write(progress('进度2500',2500,9999)),error=>error.status===409);
  assert.equal(store.write(progress('进度1',1)).ignored,true);assert.deepEqual(store.snapshot(),before);
  store.write({id:'清空历史',kind:'history',key:'*',op:'clear',at:4000});assert.equal(store.snapshot().history.length,0);assert.equal(store.snapshot().favorites.length,1);
  store.write(progress('进度1',1));assert.equal(store.snapshot().history.length,0);
  store.write(progress('新续播',4100,7000));assert.equal(store.snapshot().history[0].positionMs,7000);
});

test('没有客户端时间的旧接口操作不被整理，重试仍保持原始编号与位置',t=>{
  const store=new LibraryStore(':memory:',{compactLocal:true});t.after(()=>store.close());const input=progress('旧接口',0,1000);delete input.at;const saved=store.write(input);
  for(let index=1;index<=600;index++)store.write(progress(`新进度${index}`,saved.at+index,index));while(store.maintain(true)){}
  assert.deepEqual(store.write(input),saved);assert.equal(store.snapshot().history[0].positionMs,600);
});

test('已有同步关系保留全部未确认事件，整理后的快照也能首次同步并保留清空标记',t=>{
  const store=new LibraryStore(':memory:',{compactLocal:true}),remote=new LibraryStore(':memory:');t.after(()=>{store.close();remote.close();});
  for(let index=1;index<=700;index++)store.write(progress(`进度${index}`,index));while(store.maintain(true)){}
  store.write({id:'清空',kind:'history',key:'*',op:'clear',at:800});store.seedTarget('远端');const before=count(store);
  for(let index=1;index<=700;index++)store.write(progress(`同步进度${index}`,1000+index,index));assert.equal(count(store),before+700);assert.equal(store.maintain(true),0);
  while(store.pending('远端').length){const events=store.pending('远端');remote.receive(events);store.acknowledge('远端',events.map(event=>event.id));}
  assert.deepEqual(remote.snapshot(),store.snapshot());assert.equal(remote.snapshot().history[0].positionMs,700);
});

test('关闭紧急限制时无效监测参数只采用默认值，开启时仍严格拒绝配置错误',()=>{
  const config={CONTENT_DAILY_BYTES:0,CONTENT_VIEWER_DAILY_BYTES:'无效',CONTENT_IP_DAILY_BYTES:-1,CONTENT_VIP_RESERVED_BYTES:-1},budget=new TrafficBudget(':memory:',config);
  try{assert.deepEqual(budget.limits,[100*1024**3,5*1024**3,50*1024**3]);assert.doesNotThrow(()=>budget.check('观众','网络'));const meter=budget.meter('观众','网络');meter.consume(4);meter.close();}finally{budget.close();}
  assert.throws(()=>new TrafficBudget(':memory:',{...config,CONTENT_ENFORCE_DAILY_LIMITS:'1'}));
});
