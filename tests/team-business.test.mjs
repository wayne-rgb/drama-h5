import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { AccountStore } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { createContentService } from '../server/content-service.mjs';
import { createApiPolicy } from '../server/api-policy.mjs';

const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-team-business-')),users=new AccountStore(path.join(directory,'accounts.sqlite'));
  const origin='http://127.0.0.1:8794',config={APP_ORIGIN:origin},accounts=createAccountService(users,config),content=createContentService(directory,users,accounts,{},config),team=content.team,business=team.business,store=content.store;
  const owner=team.create('测试凭证',['owner'],[]),editor=team.create('测试凭证',['editor'],[]),other=team.create('测试凭证',['editor'],[]);
  const series=store.saveSeries(owner,{title:'真实业务数据',contentType:'real-drama',language:'en'});
  const second=store.saveSeries(owner,{title:'另一部作品',contentType:'real-drama',language:'en'});
  for(const member of [editor,other])team.db.prepare('INSERT INTO team_series_members VALUES(?,?)').run(series.id,member.id);
  const tokens=Object.fromEntries([owner,editor,other].map(member=>[member.id,`drama_team_session=${team.session(member,true)}`]));
  const policy=createApiPolicy(accounts,users,config,team);
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,origin);policy(req,res,url);if(await content.handle(req,res,url))return;throw Error('未处理路由');}catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=async(route,{member=owner,data,method=data===undefined?'GET':'POST',headers={}}={})=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{Origin:origin,Cookie:tokens[member.id],...(data===undefined?{}:{'Content-Type':Buffer.isBuffer(data)?'application/octet-stream':'application/json'}),...headers},body:data===undefined?undefined:Buffer.isBuffer(data)?data:JSON.stringify(data)});
    return {status:response.status,data:await response.json()};
  };
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await content.close();users.close();await fs.rm(directory,{recursive:true,force:true});});
  const asset=async({member=editor,status='uploading',bytes=Buffer.from('原始上传内容'),offset=0,sha256=null,seriesId=series.id}={})=>{
    const id=crypto.randomUUID();store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,offset,status,created_at,series_id,episode_number,source_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,member.id,'原上传者的文件名.mp4','video','video/mp4',bytes.length,offset,status,Date.now(),seriesId,1,sha256);
    if(status==='uploading')await fs.writeFile(path.join(directory,'media',`${id}.part`),bytes.subarray(0,offset));
    return store.asset(id);
  };
  const legacy=async()=>{
    const actor=users.create({email:'legacy@example.invalid',name:'旧操作者真实姓名'}),viewer=users.create({email:'viewer@example.invalid',name:'真实观众'});
    users.db.prepare('INSERT INTO account_creators VALUES(?,?,?)').run(actor.id,actor.id,Date.now());
    users.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?)').run(viewer.id,Date.now()+86400000,actor.id,'保留会员权益',Date.now());
    users.saveSubscription('测试付款事件',{id:'真实订阅',accountId:viewer.id,planId:'monthly',status:'active',periodEnd:Date.now()+86400000,cancelAtPeriodEnd:false},Date.now());
    store.db.prepare('UPDATE content_series SET creator_id=? WHERE id=?').run(actor.id,series.id);
    const logId=crypto.randomUUID();store.db.prepare('INSERT INTO content_audit VALUES(?,?,?,?,?,?)').run(logId,actor.id,'保存短剧',series.id,JSON.stringify({title:series.title,adminName:actor.name,adminEmail:actor.email}),12345);
    const uploaded=await asset({member:actor,offset:3});
    return {actor,viewer,logId,asset:uploaded};
  };
  return {directory,users,content,team,business,store,owner,editor,other,series,second,tokens,request,asset,legacy};
}

test('管理员无需改归属即可查看、校验和取消其他成员及旧账号的上传',async t=>{
  const f=await fixture(t),legacy=await f.legacy(),bytes=Buffer.from('原始上传内容'),id=legacy.asset.id;
  const listed=await f.request(`/api/admin/uploads?seriesId=${f.series.id}&pending=1`);assert.equal(listed.status,200);assert.equal(listed.data.items[0].name,`${id}.mp4`);assert.equal(listed.data.items[0].owner_id,null);
  assert.equal((await f.request(`/api/admin/uploads/${id}`,{member:f.other,method:'DELETE'})).status,403);
  const verified=await f.request(`/api/admin/uploads/${id}/verify`,{data:{revision:1,offset:3,sha256:hash(bytes),prefixSha256:hash(bytes.subarray(0,3))}});assert.equal(verified.status,200);assert.equal(verified.data.upload_revision,2);
  assert.equal(f.store.asset(id).owner_id,legacy.actor.id);
  assert.equal((await f.request(`/api/admin/uploads/${id}`,{method:'DELETE',headers:{'X-Upload-Revision':'1'}})).status,409);
  assert.equal((await f.request(`/api/admin/uploads/${id}`,{method:'DELETE',headers:{'X-Upload-Revision':'2'}})).status,200);
  assert.equal(f.store.asset(id).status,'failed');await assert.rejects(fs.stat(path.join(f.directory,'media',`${id}.part`)),{code:'ENOENT'});
  assert.equal((await f.request(`/api/team/uploads/${id}/transfer`,{data:{}})).status,404);
});

test('完整摘要和已上传部分都校验，错误文件不能拼入现有断点',async t=>{
  const f=await fixture(t),bytes=Buffer.from('原始上传内容'),asset=await f.asset({offset:3});
  const wrong=await f.request(`/api/admin/uploads/${asset.id}/verify`,{member:f.editor,data:{revision:1,offset:3,sha256:hash(bytes),prefixSha256:hash(Buffer.from('错误'))}});assert.equal(wrong.status,409);assert.equal(f.store.asset(asset.id).source_sha256,null);
  const verified=await f.request(`/api/admin/uploads/${asset.id}/verify`,{member:f.editor,data:{revision:1,offset:3,sha256:hash(bytes),prefixSha256:hash(bytes.subarray(0,3))}});assert.equal(verified.status,200);
  const remainder=Buffer.alloc(bytes.length-3,0);
  const chunk=await f.request(`/api/admin/uploads/${asset.id}`,{member:f.editor,method:'PUT',data:remainder,headers:{'Content-Range':`bytes 3-${bytes.length-1}/${bytes.length}`,'X-Upload-Revision':'2'}});assert.equal(chunk.status,409);
  assert.equal(f.store.asset(asset.id).offset,3);assert.deepEqual(await fs.readFile(path.join(f.directory,'media',`${asset.id}.part`)),bytes.subarray(0,3));
});

test('校验期间锁住上传，旧版本和无权限成员均不能并发写入',async t=>{
  const f=await fixture(t),asset=await f.asset({bytes:Buffer.from('abcdefgh')});
  const req=new PassThrough();Object.assign(req,{method:'PUT',url:`/api/admin/uploads/${asset.id}`,headers:{cookie:f.tokens[f.editor.id],origin:'http://127.0.0.1:8794','content-range':'bytes 0-1/8','x-upload-revision':'1'},socket:{remoteAddress:'127.0.0.1'}});
  f.content.team.authorize(req,new URL(req.url,'http://localhost'));
  const uploads=(await import('../server/content-upload.mjs')).createUploads(f.store,f.directory,{});
  const pending=uploads.chunk(req,f.editor,asset.id);
  await assert.rejects(uploads.verifySource({},f.owner,asset.id,{revision:1,offset:0,sha256:hash(Buffer.from('abcdefgh')),prefixSha256:hash(Buffer.alloc(0))}),error=>error.status===409);
  req.end(Buffer.from('ab'));await pending;await uploads.close();
  assert.equal(f.store.asset(asset.id).offset,2);
});

test('业务和审计共同回滚，会员事件跨库重试不会重复记账',async t=>{
  const f=await fixture(t),original=f.store.audit.bind(f.store),viewer=f.users.create({email:'membership@example.invalid',name:'会员观众'});
  f.store.audit=()=>{throw Error('模拟审计不可用');};
  assert.throws(()=>f.store.saveSeries(f.owner,{title:'不应保留',contentType:'real-drama',language:'en'},f.series.id));assert.equal(f.store.row(f.series.id).title,'真实业务数据');
  assert.throws(()=>f.business.recordMembership(f.owner,viewer,Date.now()+86400000,'有效操作',false));assert.equal(f.users.membership(viewer.id).active,true);
  assert.equal(f.users.db.prepare('SELECT delivered FROM account_team_events').get().delivered,0);
  f.store.audit=original;f.business.flush();f.business.flush();assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM content_audit WHERE action='开通手动会员'").get().n,1);
});

test('迁移清理旧关联并保留历史操作者、素材编号、会员及观众账号',async t=>{
  const f=await fixture(t),legacy=await f.legacy(),beforeVip=f.users.membership(legacy.viewer.id),before=f.business.invariants(),preview=f.business.preview();
  assert.equal(preview.accounts.some(row=>row.id===legacy.actor.id),true);f.business.pause(f.owner);
  const result=await f.business.migrate(f.owner,{snapshot:preview.snapshot});assert.equal(f.business.invariants(),before);assert.deepEqual(f.users.membership(legacy.viewer.id),beforeVip);
  assert.equal(f.users.byId(legacy.actor.id).email,legacy.actor.email);assert.equal(f.store.row(f.series.id).creator_id,null);assert.equal(f.users.isCreator(legacy.actor.id),false);
  const raw=f.store.db.prepare('SELECT * FROM content_audit WHERE id=?').get(legacy.logId),detail=JSON.parse(raw.detail);assert.match(detail.actorCode,/^H-/);assert.equal(raw.created_at,12345);assert.equal(detail.adminName,undefined);assert.equal(JSON.stringify(raw).includes(legacy.actor.id),false);
  assert.equal(f.store.asset(legacy.asset.id).owner_id,raw.admin_id);assert.equal(f.users.db.prepare('SELECT admin_id FROM account_manual_vip WHERE account_id=?').get(legacy.viewer.id).admin_id,raw.admin_id);
  assert.equal(f.business.preview().counts.actors,0);assert.equal(f.business.preview().counts.oldNames,0);await assert.rejects(fs.stat(path.join(f.directory,'.team-migration-journal')),{code:'ENOENT'});
  assert.equal((await fs.stat(path.join(result.backup,'content.sqlite'))).mode&0o777,0o600);
  const retained=f.store.asset(legacy.asset.id);
  await f.business.migrate(f.owner,{snapshot:f.business.preview().snapshot});
  assert.deepEqual(f.store.asset(legacy.asset.id),retained);assert.deepEqual(f.store.db.prepare('SELECT * FROM content_audit WHERE id=?').get(legacy.logId),raw);
  const allowed=await f.request(`/api/admin/uploads/${legacy.asset.id}/verify`,{data:{revision:f.store.asset(legacy.asset.id).upload_revision,offset:3,sha256:hash(Buffer.from('原始上传内容')),prefixSha256:hash(Buffer.from('原始上传内容').subarray(0,3))}});assert.equal(allowed.status,503);
  f.business.resume(f.owner);assert.equal((await f.request(`/api/admin/uploads/${legacy.asset.id}`)).status,200);
});

test('跨库迁移中断可继续，重复恢复不改动观众互动和订阅',async t=>{
  const f=await fixture(t),legacy=await f.legacy();f.business.pause(f.owner);
  const original=f.users.transaction.bind(f.users);f.users.transaction=()=>{throw Error('模拟账户库中断');};
  await assert.rejects(f.business.migrate(f.owner,{snapshot:f.business.preview().snapshot}));assert.equal(f.business.preview().recoverable,true);assert.throws(()=>f.business.resume(f.owner));
  const code=JSON.parse(f.store.db.prepare('SELECT detail FROM content_audit WHERE id=?').get(legacy.logId).detail).actorCode;
  f.users.transaction=original;const result=await f.business.migrate(f.owner,{});assert.equal(JSON.parse(f.store.db.prepare('SELECT detail FROM content_audit WHERE id=?').get(legacy.logId).detail).actorCode,code);
  const commentId=crypto.randomUUID();f.store.db.prepare('INSERT INTO episode_comments(id,episode_id,series_id,account_id,body,created_at) VALUES(?,?,?,?,?,?)').run(commentId,'维护期间分集',f.series.id,legacy.viewer.id,'维护期间保留的评论',Date.now());
  const joined=f.team.create('维护期间新成员凭证',['editor'],[f.series.id]);
  const vip=f.users.membership(legacy.viewer.id);f.business.restore(f.owner,result.id);assert.equal(f.store.db.prepare('SELECT body FROM episode_comments WHERE id=?').get(commentId).body,'维护期间保留的评论');assert.deepEqual(f.users.membership(legacy.viewer.id),vip);
  assert.equal(f.store.asset(legacy.asset.id).owner_id,legacy.actor.id);assert.equal(f.users.isCreator(legacy.actor.id),true);
  assert.equal(f.team.allowed(joined,'editor',f.series.id),true);
  assert.throws(()=>f.business.restore(f.owner,result.id),error=>error.status===409);f.business.resume(f.owner);
});

test('维护权限、过期预检和恢复时机受控，不能误恢复后续业务改动',async t=>{
  const f=await fixture(t);await f.legacy();
  assert.equal((await f.request('/api/team/maintenance/preview',{member:f.editor})).status,403);
  const stale=f.business.preview().snapshot;f.store.saveSeries(f.owner,{title:'真实新增操作',contentType:'real-drama',language:'en'},f.series.id);f.business.pause(f.owner);
  await assert.rejects(f.business.migrate(f.owner,{snapshot:stale}),error=>error.status===409);
  assert.equal((await f.request(`/api/admin/series/${f.series.id}`,{data:{title:'不应保存'}})).status,503);
  const result=await f.business.migrate(f.owner,{snapshot:f.business.preview().snapshot});f.business.resume(f.owner);f.business.pause(f.owner);assert.throws(()=>f.business.restore(f.owner,result.id),error=>error.status===409);f.business.resume(f.owner);
});

test('先迁移再删除确认账号，历史操作、其他观众及评论点赞全部保留',async t=>{
  const f=await fixture(t),legacy=await f.legacy(),confirmed=[{id:legacy.actor.id,email:legacy.actor.email}],comment=crypto.randomUUID();
  f.store.db.prepare('INSERT INTO episode_comments(id,episode_id,series_id,account_id,body,created_at) VALUES(?,?,?,?,?,?)').run(comment,'历史分集',f.series.id,legacy.actor.id,'保留历史评论',Date.now());
  f.store.db.prepare('INSERT INTO episode_likes VALUES(?,?,?)').run('历史分集',legacy.actor.id,Date.now());
  const before=f.users.byId(legacy.viewer.id),vip=f.users.membership(legacy.viewer.id),invariants=f.business.invariants();
  assert.throws(()=>f.users.retireConfirmedAccounts(confirmed),error=>error.status===409);
  f.business.pause(f.owner);await f.business.migrate(f.owner,{snapshot:f.business.preview().snapshot});f.business.resume(f.owner);
  assert.deepEqual(f.users.retireConfirmedAccounts(confirmed).deleted,[legacy.actor.id]);assert.deepEqual(f.users.byId(legacy.viewer.id),before);assert.deepEqual(f.users.membership(legacy.viewer.id),vip);assert.equal(f.business.invariants(),invariants);
  assert.equal(f.store.db.prepare('SELECT body FROM episode_comments WHERE id=?').get(comment).body,'保留历史评论');assert.ok(f.store.db.prepare('SELECT 1 FROM episode_likes WHERE account_id=?').get(legacy.actor.id));
  assert.match(JSON.parse(f.store.db.prepare('SELECT detail FROM content_audit WHERE id=?').get(legacy.logId).detail).actorCode,/^H-/);assert.equal(f.business.preview().accounts.some(row=>row.id===legacy.actor.id),false);
});
