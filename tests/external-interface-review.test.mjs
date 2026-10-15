import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {fork} from 'node:child_process';
import {AccountStore} from '../server/account-store.mjs';
import {createAccountService} from '../server/account-routes.mjs';
import {createContentService} from '../server/content-service.mjs';
import {createApiPolicy} from '../server/api-policy.mjs';

const origin='http://127.0.0.1:8793';
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-external-review-')),users=new AccountStore(path.join(directory,'accounts.sqlite'));
  const admin=users.create({email:'admin@example.test',name:'隔离管理员'}),viewer=users.create({email:'viewer@example.test',name:'真实回归观众'});
  const config={APP_ORIGIN:origin,ADMIN_ACCOUNT_IDS:admin.id},accounts=createAccountService(users,config),content=createContentService(directory,users,accounts,{},config),store=content.store;
  const cover=crypto.randomUUID(),video=crypto.randomUUID(),bytes=Buffer.alloc(512*1024,1);
  for(const [id,kind,mime] of [[cover,'image','image/png'],[video,'video','video/mp4']]){
    await fs.writeFile(path.join(directory,'media',id),bytes);
    store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,admin.id,'传输权限回归素材',kind,mime,bytes.length,'ready',JSON.stringify({duration:600,width:360,height:640}),Date.now());
  }
  let series=store.saveSeries(admin,{title:'接口权限边界回归',description:'独立数据库与本机字节夹具',contentType:'real-drama',language:'en',coverId:cover});
  for(let number=1;number<=4;number++)series=store.saveEpisode(admin,series.id,{assetId:video,number});
  store.publish(admin,series.id,'published');
  const cleanup=[];
  t.after(async()=>{for(const finish of cleanup)await finish();content.close();users.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=(url,token)=>({method:'GET',url,headers:{origin,...(token?{cookie:`hg_account_session=${token}`}:{})},socket:{remoteAddress:'127.0.0.1'}});
  return {directory,users,admin,viewer,accounts,content,store,config,series,cover,video,bytes,request,cleanup};
}

test('播放连接复核当前免费集序、会员权益、分集存在性和素材版本',async t=>{
  const f=await fixture(t),token=f.users.session(f.viewer.id),req=f.request('/',token),episode=f.series.episodes[0];
  await f.content.resolveEpisode(req,f.series.id,episode.id);assert.doesNotThrow(()=>req.revalidatePlayback(true));
  f.store.publish(f.admin,f.series.id,'draft');f.store.reorder(f.admin,f.series.id,[...f.series.episodes.slice(1).map(row=>row.id),episode.id]);f.store.publish(f.admin,f.series.id,'published');
  assert.throws(()=>req.revalidatePlayback(true),error=>error.status===403&&error.message==='VIP_REQUIRED');
  f.users.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?)').run(f.viewer.id,Date.now()+60000,f.admin.id,'独立会员回归',Date.now());assert.doesNotThrow(()=>req.revalidatePlayback(true));
  f.users.db.prepare('DELETE FROM account_manual_vip WHERE account_id=?').run(f.viewer.id);assert.throws(()=>req.revalidatePlayback(true),error=>error.status===403);
  f.store.publish(f.admin,f.series.id,'draft');f.store.reorder(f.admin,f.series.id,f.series.episodes.map(row=>row.id));f.store.publish(f.admin,f.series.id,'published');assert.doesNotThrow(()=>req.revalidatePlayback(true));
  const replacement=crypto.randomUUID();f.store.db.prepare('INSERT INTO content_assets SELECT ?,owner_id,name,kind,mime,size,offset,status,metadata,error,created_at,series_id,episode_number FROM content_assets WHERE id=?').run(replacement,f.video);
  f.store.publish(f.admin,f.series.id,'draft');f.store.saveEpisode(f.admin,f.series.id,{number:1,assetId:replacement,mode:'replace',expectedEpisodeId:episode.id,expectedAssetId:f.video});f.store.publish(f.admin,f.series.id,'published');
  assert.throws(()=>req.revalidatePlayback(true),error=>error.status===409);
  const updated=f.request('/',token);await f.content.resolveEpisode(updated,f.series.id,episode.id);assert.doesNotThrow(()=>updated.revalidatePlayback(true));
  f.store.publish(f.admin,f.series.id,'draft');f.store.removeEpisode(f.admin,f.series.id,episode.id);
  const preview=f.request('/',f.users.session(f.admin.id));await assert.rejects(f.content.resolveEpisode(preview,f.series.id,episode.id),error=>error.status===404);
});

for(const kind of ['likes','comments'])test(`正文等待期间下架或移除分集，${kind}拒绝写入且正常重试可用`,async t=>{
  const f=await fixture(t),token=f.users.session(f.viewer.id),episode=f.series.episodes[0],route=`/api/episodes/${episode.id}/${kind}?seriesId=${f.series.id}`;
  const req=new PassThrough();Object.assign(req,f.request(route,token));req.method='POST';req.headers['content-type']='application/json';
  const res={setHeader(){},writeHead(){},end(){assert.fail('过期内容资格不能返回成功');}};
  createApiPolicy(f.accounts,f.users,f.config)(req,res,new URL(route,origin));
  let reading;const started=new Promise(resolve=>{reading=resolve;}),iterator=req.iterator.bind(req);req.iterator=options=>{reading();return iterator(options);};
  const handling=f.content.handle(req,res,new URL(route,origin)),rejected=assert.rejects(handling,error=>error.status===404);
  await started;f.store.publish(f.admin,f.series.id,'draft');if(kind==='comments')f.store.removeEpisode(f.admin,f.series.id,episode.id);
  req.end(JSON.stringify(kind==='likes'?{liked:true}:{body:'正常评论内容'}));await rejected;
  assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${kind==='likes'?'episode_likes':'episode_comments'}`).get().count,0);
  if(kind==='comments')f.store.saveEpisode(f.admin,f.series.id,{number:1,assetId:f.video});f.store.publish(f.admin,f.series.id,'published');
  const current=f.store.detail(f.series.id).episodes[0],retryRoute=`/api/episodes/${current.id}/${kind}?seriesId=${f.series.id}`,retry=new PassThrough();Object.assign(retry,f.request(retryRoute,token));retry.method='POST';retry.headers['content-type']='application/json';
  let status;const response={setHeader(){},writeHead(value){status=value;},end(){}};createApiPolicy(f.accounts,f.users,f.config)(retry,response,new URL(retryRoute,origin));retry.end(JSON.stringify(kind==='likes'?{liked:true}:{body:'正常重试评论'}));await f.content.handle(retry,response,new URL(retryRoute,origin));assert.equal(status,200);
});

for(const access of ['published','creator','admin'])test(`封面在途传输持续检查当前访问权限：${access}`,async t=>{
  const f=await fixture(t);let token;
  if(access!=='published'){
    f.store.publish(f.admin,f.series.id,'draft');
    if(access==='creator'){f.users.db.prepare('INSERT INTO account_creators VALUES(?,?,?)').run(f.viewer.id,f.admin.id,Date.now());f.store.assignCreator(f.admin,f.series.id,f.viewer.id);}
    token=f.users.session(access==='admin'?f.admin.id:f.viewer.id);
  }
  const req=f.request(`/api/content/covers/${f.cover}`,token),res=new EventEmitter();let source;
  Object.assign(res,{setHeader(){},writeHead(){},end(){}});req.sendDownload=value=>{source=value;};req.guardPublicAsset=()=>{req.revalidatePlayback=()=>{};};
  f.cleanup.push(()=>res.emit('close'));await f.content.handle(req,res,new URL(req.url,origin));assert.ok(source);assert.doesNotThrow(()=>req.revalidatePlayback(true));
  if(access==='published')f.store.publish(f.admin,f.series.id,'draft');else if(access==='creator')f.users.db.prepare('DELETE FROM account_creators WHERE account_id=?').run(f.viewer.id);else f.users.logout(token);
  assert.throws(()=>req.revalidatePlayback(true),error=>error.status===404);
  f.store.publish(f.admin,f.series.id,'published');assert.doesNotThrow(()=>req.revalidatePlayback(true));res.emit('close');
});

test('草稿详情预览限制来源，退出或撤销管理员后停止私有响应，不返回素材或归属字段',async t=>{
  const f=await fixture(t);f.store.publish(f.admin,f.series.id,'draft');
  const token=f.users.session(f.admin.id),req=f.request(`/api/series/${f.series.id}`,token),data=await f.content.publicDetail(req,f.series.id);
  assert.equal(Object.hasOwn(data,'creatorId'),false);assert.equal(data.episodes.some(row=>'assetId' in row),false);assert.doesNotThrow(()=>req.revalidateAccess());
  f.users.logout(token);assert.throws(()=>req.revalidateAccess(),error=>error.status===404);
  const outside=f.request(req.url,f.users.session(f.admin.id));outside.headers.origin='https://external.example';await assert.rejects(f.content.publicDetail(outside,f.series.id),error=>error.status===403);
  const revoked=f.request(req.url,f.users.session(f.admin.id));await f.content.publicDetail(revoked,f.series.id);f.config.ADMIN_ACCOUNT_IDS='';assert.throws(()=>revoked.revalidateAccess(),error=>error.status===404);
});

test('真实HTTP正在传输的旧免费集在调整为VIP后停止，正常范围请求及错误脱敏保留',async t=>{
  const f=await fixture(t),guest=f.users.guestSession(),episode=f.series.episodes[0];
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_ENV_FILE:path.join(f.directory,'absent.env'),HG_HOST:'127.0.0.1',PORT:'0',HG_DATA_DIR:f.directory,APP_ORIGIN:origin,HG_MANAGED:'',ADMIN_ACCOUNT_IDS:f.admin.id,ADMIN_EMAILS:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none',TRUSTED_PROXY_IPS:'',CONTENT_ENFORCE_DAILY_LIMITS:'0',DOWNLOAD_VIEWER_BYTES_PER_SECOND:'65536',DOWNLOAD_GLOBAL_BYTES_PER_SECOND:'65536',DOWNLOAD_VIEWER_BURST_BYTES:'65536',DOWNLOAD_GLOBAL_BURST_BYTES:'65536'},stdio:['ignore','ignore','ignore','ipc']});
  f.cleanup.push(async()=>{if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await stopped;}});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离服务启动超时')),10000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('隔离服务提前退出'));});child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});});
  const base=`http://127.0.0.1:${port}`,route=`/api/episodes/${episode.id}/stream?seriesId=${f.series.id}`,headers={Origin:origin,Cookie:`hg_guest_session=${guest.token}`};
  const small=await fetch(base+route,{headers:{...headers,Range:'bytes=0-15'}});assert.equal(small.status,206);assert.deepEqual(Buffer.from(await small.arrayBuffer()),f.bytes.subarray(0,16));
  const video=await fetch(base+route,{headers}),reader=video.body.getReader();let received=(await reader.read()).value.length;
  f.store.publish(f.admin,f.series.id,'draft');f.store.reorder(f.admin,f.series.id,[...f.series.episodes.slice(1).map(row=>row.id),episode.id]);f.store.publish(f.admin,f.series.id,'published');
  await assert.rejects(async()=>{while(true){const row=await reader.read();if(row.done)break;received+=row.value.length;}});assert.ok(received<f.bytes.length);
  const forbidden=await fetch(base+route,{headers});assert.equal(forbidden.status,403);assert.deepEqual(await forbidden.json(),{error:'VIP_REQUIRED'});
  const ordinary=await fetch(`${base}/api/episodes/${f.series.episodes[1].id}/stream?seriesId=${f.series.id}`,{headers:{...headers,Range:'bytes=0-15'}});assert.equal(ordinary.status,206);await ordinary.arrayBuffer();
  const missing=await fetch(`${base}/api/content/covers/${crypto.randomUUID()}`,{headers});assert.equal(missing.status,404);assert.equal(await missing.text(),JSON.stringify({error:'封面不存在'}));assert.equal(missing.headers.get('server'),null);assert.equal(missing.headers.get('x-powered-by'),null);
  await fs.unlink(path.join(f.directory,'media',f.video));
  const unavailable=await fetch(`${base}/api/episodes/${f.series.episodes[1].id}/stream?seriesId=${f.series.id}`,{headers});assert.equal(unavailable.status,500);assert.deepEqual(await unavailable.json(),{error:'操作失败，请稍后重试'});
  assert.equal((await fetch(base+'/health')).status,200);
});
