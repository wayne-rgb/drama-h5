import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {fork} from 'node:child_process';
import {AccountStore,passwordHash} from '../server/account-store.mjs';
import {createAccountService} from '../server/account-routes.mjs';
import {createApiPolicy} from '../server/api-policy.mjs';
import {createContentService} from '../server/content-service.mjs';
import {LibraryStore} from '../shared/library-store.mjs';
import {PersonalStorage} from '../server/personal-storage.mjs';
import {RequestGuard} from '../server/request-guard.mjs';
import {DownloadProtection,mp4TransferRate} from '../server/download-protection.mjs';
import {AnalyticsResource} from '../server/analytics-resource.mjs';
import {DatabaseSync} from 'node:sqlite';

const origin='http://127.0.0.1:8793';
async function fixture(t,provider={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-deep-fix-')),users=new AccountStore(':memory:');
  const admin=users.create({email:'deep-admin@example.test',name:'独立回归管理员'}),config={APP_ORIGIN:origin,ADMIN_ACCOUNT_IDS:admin.id};
  const accounts=createAccountService(users,config),content=createContentService(directory,users,accounts,provider,config);
  const teamAdmin=content.team.create(await passwordHash('深度回归团队密码2026'),['owner'],[]);
  t.after(async()=>{content.close();users.close();await fs.rm(directory,{recursive:true,force:true});});
  return {directory,users,admin,teamAdmin,accounts,content,config};
}

for(const route of ['/api/admin/comments?seriesId=91','/api/admin/comment-series'])test(`管理员退出后待完成的私有读取拒绝返回：${route}`,async t=>{
  let finish,arrived;const started=new Promise(resolve=>{arrived=resolve;});
  const f=await fixture(t,{detail:()=>{arrived();return new Promise(resolve=>{finish=resolve;});}});
  f.content.store.db.prepare('INSERT INTO episode_comments(id,episode_id,series_id,account_id,body,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),'101','91',f.admin.id,'独立数据库中的隐藏审核记录','hidden',Date.now());
  const token=f.content.team.session(f.teamAdmin,true),req={method:'GET',url:route,headers:{origin,cookie:`drama_team_session=${token}`},socket:{remoteAddress:'127.0.0.1'}};
  let responded=false;const res={setHeader(){},writeHead(){responded=true;},end(){responded=true;}};
  createApiPolicy(f.accounts,f.users,f.config,f.content.team)(req,res,new URL(route,origin));
  const reading=f.content.handle(req,res,new URL(route,origin));const rejected=assert.rejects(reading,error=>[401,409].includes(error.status));
  await started;f.content.team.logout(req);finish({id:'91',title:'真实目录边界',episodes:[{id:'101',number:1,title:'第一集'}]});await rejected;assert.equal(responded,false);
});

test('预检独立限频、正常接口额度保留，关闭连接准确释放并发',()=>{
  let now=1000;const guard=new RequestGuard({API_IP_REQUESTS_PER_MINUTE:1,API_GLOBAL_REQUESTS_PER_MINUTE:2},()=>now),req=new EventEmitter(),res=new EventEmitter();req.url='/api/rank/types';
  guard.acquirePreflight(req,res,'同一地址');res.emit('finish');
  assert.throws(()=>guard.acquirePreflight(req,new EventEmitter(),'同一地址'),error=>error.status===429);
  const normal=new EventEmitter();assert.doesNotThrow(()=>guard.acquire(req,normal,'观众','同一地址'));normal.emit('close');assert.equal(guard.active.size,0);
  now+=60001;assert.doesNotThrow(()=>guard.acquirePreflight(req,res,'同一地址'));res.emit('close');assert.equal(guard.active.size,0);
});

test('传输保留首屏突发，持续下载平滑等待，个人独立且全站速度有界',()=>{
  let now=0;const guard=new DownloadProtection({DOWNLOAD_VIEWER_BYTES_PER_SECOND:10,DOWNLOAD_GLOBAL_BYTES_PER_SECOND:20,DOWNLOAD_VIEWER_BURST_BYTES:20,DOWNLOAD_GLOBAL_BURST_BYTES:30},()=>now);
  assert.equal(guard.delay('观众甲',10),0);assert.equal(guard.delay('观众甲',20),1000);assert.equal(guard.delay('观众乙',10),500);
  now=2000;assert.equal(guard.delay('观众甲',10),0);assert.equal(guard.delay('观众乙',10),0);
});

test('取消正在等待的下载立即结束，不遗留定时器监听或继续发送',async()=>{
  const guard=new DownloadProtection({DOWNLOAD_VIEWER_BYTES_PER_SECOND:1,DOWNLOAD_GLOBAL_BYTES_PER_SECOND:1,DOWNLOAD_VIEWER_BURST_BYTES:1,DOWNLOAD_GLOBAL_BURST_BYTES:1}),req=new EventEmitter(),res=new EventEmitter();
  const waiting=guard.wait(req,res,'观众',32),rejected=assert.rejects(waiting,/传输已结束/);res.destroyed=true;res.emit('close');await rejected;
  assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
  assert.equal(guard.rows.get('global').tokens,1);assert.equal(guard.rows.get('viewer:观众').tokens,1);
});

test('真实MP4时长字段支持两种版本，高清倍速传输按码率计算，异常头安全回退',()=>{
  for(const version of [0,1]){
    const mvhd=Buffer.alloc(version===1?40:28);mvhd.writeUInt32BE(mvhd.length,0);mvhd.write('mvhd',4);mvhd[8]=version;
    const offset=version===1?28:20;mvhd.writeUInt32BE(1000,offset);if(version===1)mvhd.writeBigUInt64BE(2000n,offset+4);else mvhd.writeUInt32BE(2000,offset+4);
    const moov=Buffer.alloc(8+mvhd.length);moov.writeUInt32BE(moov.length,0);moov.write('moov',4);mvhd.copy(moov,8);
    assert.equal(mp4TransferRate(1000000,moov),12000000);assert.equal(mp4TransferRate(1000000,moov.subarray(0,10)),undefined);
  }
  assert.equal(mp4TransferRate(1000,Buffer.alloc(8)),undefined);
});

test('资料页同时限制数量及正文体积，游标完整遍历且旧剧续播保持可用',t=>{
  const store=new LibraryStore(':memory:',{compactLocal:true});t.after(()=>store.close());
  for(let index=0;index<64;index++){
    store.write({id:`追剧${index}`,kind:'favorite',key:String(index+1),op:'set',at:1000,value:{id:String(index+1),title:`完整追剧${index}`,description:'真实简介'.repeat(3000),tags:'爱情'}});
    store.write({kind:'history',key:String(index+1),op:'set',at:1000,value:{seriesId:String(index+1),title:'真实续播',badge:'全1集',episodeId:'101',episodeNumber:1,positionMs:1000,durationMs:1000,completed:true}});
    store.write({kind:'recommendation',key:`观看${index}:${index+1}`,op:'set',at:1000,value:{seriesId:String(index+1),title:'真实偏好',tags:'爱情',contentType:'real-drama',watchMs:31000,exposures:1,skips:0,completed:true}});
  }
  store.write({kind:'preference',key:'quality',op:'set',value:{value:'360P'}});store.write({kind:'preference',key:'speed',op:'set',value:{value:1.5}});
  const ids=[];let cursor='';do{const page=store.listPage('favorite',{limit:100,cursor});assert.ok(page.items.length<=100);assert.ok(Buffer.byteLength(JSON.stringify(page.items))<=1048576);ids.push(...page.items.map(item=>item.id));cursor=page.next;}while(cursor);
  assert.equal(new Set(ids).size,64);assert.equal(ids.length,64);assert.equal(store.snapshotPage().pagination.favorite.count,64);
  assert.equal(store.snapshotPage().preferences.quality,'360P');assert.equal(store.snapshotPage().preferences.speed,1.5);assert.equal(store.record('history','1').positionMs,1000);
  assert.equal(store.profile().history.length,64);assert.equal(store.profile().recommendationSignals.length,64);assert.equal(store.profile().history[0].completed,true);
  assert.throws(()=>store.listPage('favorite',{cursor:'不合法的游标'}));
});

test('注册账户单库保护拒绝继续增长，超额旧资料仍可分页读取和清理',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-profile-cap-')),location=path.join(directory,'accounts',crypto.randomUUID()),store=new LibraryStore(path.join(location,'library.sqlite'),{compactLocal:true});
  for(let index=0;index<20;index++)store.write({kind:'favorite',key:String(index),op:'set',at:index+1,value:{id:String(index),title:'容量回归资料',description:'完整历史简介'.repeat(2000)}});
  const storage=new PersonalStorage(directory,{PERSONAL_ACCOUNT_PROFILE_BYTES:131072,PERSONAL_TOTAL_BYTES:16*1024**2,PERSONAL_MIN_FREE_BYTES:1}),req=new EventEmitter(),res=new EventEmitter();req.method='POST';req.url='/api/library/operations';req.headers={'content-length':'32'};
  t.after(async()=>{res.emit('close');store.close();await fs.rm(directory,{recursive:true,force:true});});
  assert.ok(storage.size(location)>131072);assert.equal(store.listPage('favorite').count,20);storage.attach(req,res,location,false,[store.db]);
  assert.throws(()=>req.checkLibraryOperation({op:'set'}),error=>error.status===507);assert.doesNotThrow(()=>req.checkLibraryOperation({op:'clear'}));
  store.write({kind:'favorite',key:'*',op:'clear',at:5000});assert.equal(store.listPage('favorite').items.length,0);res.emit('finish');assert.equal(storage.reserved,0);
});

test('公开采集空会话有界，真实观看、错误、会员拦截及同编号重试保留',async t=>{
  const f=await fixture(t),store=f.content.store;let now=Date.now();f.content.analytics.clock=()=>now;
  const series=store.saveSeries(f.admin,{title:'采集保护回归',description:'',contentType:'real-drama',language:'en'}),asset=crypto.randomUUID();
  store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(asset,f.admin.id,'独立素材边界','video','video/mp4',32,'ready',JSON.stringify({duration:60,width:360,height:640}),now);
  let detail;for(let number=1;number<=4;number++)detail=store.saveEpisode(f.admin,series.id,{assetId:asset,number});store.db.prepare("UPDATE content_series SET status='published' WHERE id=?").run(series.id);
  const resource=new AnalyticsResource(store,f.directory,{ANALYTICS_MAX_ACTOR_EMPTY_SESSIONS:2,ANALYTICS_MAX_EMPTY_SESSIONS:3},()=>now),guest=f.users.guestSession(),req={headers:{cookie:`hg_guest_session=${guest.token}`}};
  const input=episodeId=>({seriesId:series.id,episodeId,requestId:crypto.randomUUID(),entry:'feed'}),start=value=>resource.start(f.content.analytics,req,value),firstInput=input(detail.episodes[0].id),first=start(firstInput);
  now+=1000;f.content.analytics.progress(req,{id:first.id,sequence:1,watchMs:1000,ranges:[[0,1000]],errors:0});
  start(input(detail.episodes[0].id));start(input(detail.episodes[0].id));start(input(detail.episodes[0].id));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM analytics_sessions WHERE watch_ms=0 AND errors=0 AND gate=0').get().count,2);assert.equal(start(firstInput).id,first.id);
  const row=start(input(detail.episodes[0].id));f.content.analytics.progress(req,{id:row.id,sequence:1,watchMs:0,ranges:[],errors:1});
  const gate=start(input(detail.episodes[3].id));assert.equal(gate.gate,true);
  now+=6*3600000+1;start(input(detail.episodes[0].id));assert.ok(store.db.prepare('SELECT 1 FROM analytics_sessions WHERE id=?').get(first.id));assert.ok(store.db.prepare('SELECT 1 FROM analytics_sessions WHERE id=?').get(row.id));assert.ok(store.db.prepare('SELECT 1 FROM analytics_sessions WHERE id=?').get(gate.id));
  const stopped=new AnalyticsResource(store,f.directory,{ANALYTICS_DATABASE_BYTES:1},()=>now);assert.equal(stopped.start(f.content.analytics,req,input(detail.episodes[0].id)).deferred,true);
});

test('真实HTTP媒体拒绝外站与无身份请求，静态和头像字节计量且缓存命中不重复计费',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-download-http-')),web=path.join(directory,'web');await fs.mkdir(web);
  const script='console.log("实际构建字节")';await fs.writeFile(path.join(web,'app.js'),script);await fs.writeFile(path.join(web,'index.html'),'<!doctype html><title>独立正常页面</title>');
  const users=new AccountStore(path.join(directory,'accounts.sqlite')),user=users.create({email:'viewer@example.test',name:'头像回归账户'}),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7tQAAAAASUVORK5CYII=','base64');users.updateProfile(user.id,{avatar:png.toString('base64')});const token=users.session(user.id);
  const other=users.create({email:'other@example.test',name:'独立头像账户'});users.updateProfile(other.id,{avatar:png.toString('base64')});users.db.prepare('UPDATE accounts SET updated_at=? WHERE id=?').run(users.byId(user.id).updated_at,other.id);const otherToken=users.session(other.id);users.close();
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_ENV_FILE:path.join(directory,'absent.env'),HG_HOST:'127.0.0.1',PORT:'0',HG_DATA_DIR:directory,HG_WEB_DIR:web,APP_ORIGIN:origin,HG_MANAGED:'',ADMIN_ACCOUNT_IDS:'',ADMIN_EMAILS:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none',TRUSTED_PROXY_IPS:''},stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await stopped;}await fs.rm(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('独立HTTP服务启动超时')),10000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('独立HTTP服务提前退出'));});child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});}),base=`http://127.0.0.1:${port}`;
  const asset=await fetch(base+'/app.js');assert.equal(await asset.text(),script);const etag=asset.headers.get('etag');assert.ok(etag);
  assert.equal((await fetch(base+'/app.js',{headers:{'If-None-Match':etag}})).status,304);assert.equal((await fetch(base+'/app.js',{method:'HEAD'})).status,200);
  const headers={Origin:origin,Cookie:`hg_account_session=${token}`},avatar=await fetch(base+'/api/account/avatar',{headers});assert.deepEqual(Buffer.from(await avatar.arrayBuffer()),png);
  assert.equal((await fetch(base+'/api/account/avatar',{headers:{...headers,'If-None-Match':avatar.headers.get('etag')}})).status,304);
  const otherAvatar=await fetch(base+'/api/account/avatar',{headers:{Origin:origin,Cookie:`hg_account_session=${otherToken}`,'If-None-Match':avatar.headers.get('etag')}});assert.equal(otherAvatar.status,200);assert.notEqual(otherAvatar.headers.get('etag'),avatar.headers.get('etag'));await otherAvatar.arrayBuffer();
  assert.equal((await fetch(base+'/api/episodes/101/stream?seriesId=91')).status,401);
  assert.equal((await fetch(base+'/api/episodes/101/stream?seriesId=91',{headers:{...headers,Origin:'https://other.example','Sec-Fetch-Site':'cross-site'}})).status,403);
  const catalog=await(await fetch(base+'/api/rank/types')).text();assert.ok(JSON.parse(catalog).types.length>0);
  const budget=new DatabaseSync(path.join(directory,'resource-usage.sqlite'),{readOnly:true});try{assert.equal(budget.prepare("SELECT SUM(bytes) AS bytes FROM traffic_budget WHERE identity='global'").get().bytes,Buffer.byteLength(script)+png.length*2+Buffer.byteLength(catalog));}finally{budget.close();}
});
