import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountStore, passwordHash } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { createContentService } from '../server/content-service.mjs';
import { isAdministrator } from '../server/account-role.mjs';
import { safeAccountReturn } from '../server/account-return.mjs';
import { ContentStore } from '../server/content-store.mjs';
import { DatabaseSync } from 'node:sqlite';

test('登录与支付返回保留分集和套餐，拒绝外站跳转与任意令牌参数',()=>{
  const origin='https://drama.example';
  assert.equal(safeAccountReturn('/?series=91791939281275855854&episode=91791939297593338772&account=membership&plan=monthly&token=private&checkout=untrusted',origin),'/?series=91791939281275855854&episode=91791939297593338772&account=membership&plan=monthly');
  for(const value of ['https://untrusted.example/','//untrusted.example/','javascript:alert(1)','/admin'])assert.equal(safeAccountReturn(value,origin),'/?account=profile');
  assert.equal(safeAccountReturn('/?series=bad&episode=4&account=reset&plan=bad',origin),'/?account=profile');
  assert.equal(safeAccountReturn('//untrusted.example/',origin,'/?account=membership'),'/?account=membership');
});

test('管理员邮箱必须已验证，普通账户不能通过请求参数取得权限', () => {
  const user = { id: '真实账户编号', email: 'admin@example.invalid', email_verified: 0 };
  assert.equal(isAdministrator(user,{ADMIN_EMAILS:user.email}),false);
  assert.equal(isAdministrator({...user,email_verified:1},{ADMIN_EMAILS:user.email}),true);
  assert.equal(isAdministrator(user,{ADMIN_ACCOUNT_IDS:user.id}),true);
  assert.equal(isAdministrator({...user,id:'另一账户'},{ADMIN_ACCOUNT_IDS:user.id}),false);
});

test('手动会员不能遮蔽真实付费订阅的管理状态，撤销赠送权益保留付费权益', () => {
  const store=new AccountStore(':memory:');
  try {
    const user=store.create({email:'vip@example.invalid',name:'订阅状态测试'}),now=Date.now();
    store.saveSubscription('paid-event',{id:'paid-subscription',accountId:user.id,planId:'monthly',status:'active',periodEnd:now+86400000,cancelAtPeriodEnd:false},now);
    store.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?)').run(user.id,now+10*86400000,'管理员','测试赠送',now);
    const vip=store.membership(user.id);
    assert.equal(vip.planId,'manual');assert.equal(vip.active,true);
    assert.equal(vip.billingSubscription.planId,'monthly');assert.equal(vip.billingSubscription.cancelAtPeriodEnd,false);
    store.db.prepare('UPDATE account_manual_vip SET period_end=0 WHERE account_id=?').run(user.id);
    assert.equal(store.membership(user.id).planId,'monthly');assert.equal(store.membership(user.id).active,true);
  }finally{store.close();}
});

test('上传、发布、VIP边界、互动隔离与后台权限使用真实HTTP和数据库', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'drama-content-'));
  const store = new AccountStore(path.join(directory,'accounts.sqlite'));
  const admin = store.create({email:'admin@example.invalid',name:'管理员'}), first = store.create({email:'a@example.invalid',name:'用户一'}), second = store.create({email:'b@example.invalid',name:'用户二'});
  const actors = Object.fromEntries([['admin',admin],['first',first],['second',second]].map(([key,user])=>[key,{user,cookie:`hg_account_session=${store.session(user.id)}`} ]));
  const origin = 'http://127.0.0.1:4318', config = {APP_ORIGIN:origin,ADMIN_ACCOUNT_IDS:admin.id};
  const accounts = createAccountService(store,config);
  const content = createContentService(directory,store,accounts,{detail:async()=>{throw Error('测试禁止访问外部内容源');}},config);
  const teamAdmin=content.team.create(await passwordHash('内容回归团队密码2026'),['owner'],[]);
  actors.admin.cookie=`drama_team_session=${content.team.session(teamAdmin,true)}`;
  const server = http.createServer(async(req,res)=>{
    try {
      const url = new URL(req.url,origin);
      if(await accounts.handle(req,res,url)||await content.handle(req,res,url))return;
      const match = /^\/api\/episodes\/(\d+)\/(qualities|play|stream)$/.exec(url.pathname);
      if(match){const resolved=await content.resolveEpisode(req,url.searchParams.get('seriesId'),match[1]);await content.ownPlayback(req,res,match[2],resolved);return;}
      const detail = /^\/api\/series\/(\d+)$/.exec(url.pathname);
      res.setHeader('Content-Type','application/json');if(detail){res.end(JSON.stringify(await content.publicDetail(req,detail[1])));return;}
      res.writeHead(404);res.end('{}');
    }catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));content.close();store.close();await fs.rm(directory,{recursive:true,force:true});});
  const request = async(route,{actor,body,method=body===undefined?'GET':'POST',headers={},requestOrigin=origin}={})=>{
    const response=await fetch(`${base}${route}`,{method,headers:{...(actor?{Cookie:actor.cookie}:{}),...(['GET','HEAD'].includes(method)?{}:{Origin:requestOrigin}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body)});
    return {response,status:response.status,data:method==='HEAD'?null:response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer())};
  };
  assert.equal((await request('/api/admin/series')).status,401);
  assert.equal((await request('/api/admin/series',{actor:actors.first})).status,401);
  assert.equal((await request('/api/admin/series',{actor:actors.admin,body:{},requestOrigin:'https://untrusted.example'})).status,403);
  const upload = async(data,kind,mime)=>{
    const created=await request('/api/admin/uploads',{actor:actors.admin,body:{name:'测试素材',size:data.length,kind,mime}});assert.equal(created.status,200);
    const id=created.data.id;
    assert.equal((await request(`/api/admin/uploads/${id}`,{actor:actors.first,method:'PUT',body:data,headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes 0-${data.length-1}/${data.length}`}})).status,401);
    const initial=await request(`/api/admin/uploads/${id}`,{actor:actors.admin,method:'PUT',body:data.subarray(0,7),headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes 0-6/${data.length}`}});assert.equal(initial.status,200);assert.equal(initial.data.offset,7);
    assert.equal((await request(`/api/admin/uploads/${id}`,{actor:actors.admin,method:'PUT',body:data.subarray(0,7),headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes 0-6/${data.length}`}})).status,409);
    const resume=(await request(`/api/admin/uploads/${id}`,{actor:actors.admin})).data.offset;
    for(let offset=resume;offset<data.length;offset+=1048576){const end=Math.min(data.length,offset+1048576);const result=await request(`/api/admin/uploads/${id}`,{actor:actors.admin,method:'PUT',body:data.subarray(offset,end),headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${offset}-${end-1}/${data.length}`}});assert.equal(result.status,200);}
    let state;
    for(let attempt=0;attempt<100;attempt++){state=await request(`/api/admin/uploads/${id}`,{actor:actors.admin});if(state.data.status!=='processing')break;await new Promise(resolve=>setTimeout(resolve,50));}
    return state.data;
  };
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg==','base64');
  const cover=await upload(image,'image','image/png');assert.equal(cover.status,'ready');
  const videoPath=path.join(directory,'test.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=160x240:r=24:d=1','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',videoPath]);
  const video=await upload(await fs.readFile(videoPath),'video','video/mp4');assert.equal(video.status,'ready');assert.equal(video.metadata.width,160);
  const created=await request('/api/admin/series',{actor:actors.admin,body:{title:'数据库验收短剧',description:'测试用独立内容',tags:'Romance',categoryIds:['romance'],contentType:'real-drama',language:'en',coverId:cover.id}});assert.equal(created.status,200);const id=created.data.id;
  assert.equal((await request(`/api/series/${id}`)).status,404);
  const privateCover=await request(`/api/content/covers/${cover.id}`,{actor:actors.admin});
  assert.equal(privateCover.status,200);assert.equal(privateCover.response.headers.get('cache-control'),'private, no-store');assert.equal(privateCover.response.headers.get('etag'),null);
  assert.equal((await request(`/api/admin/series/${id}/publish`,{actor:actors.admin,body:{status:'published'}})).status,400);
  for(let number=1;number<=4;number++)assert.equal((await request(`/api/admin/series/${id}/episodes`,{actor:actors.admin,body:{number,title:`测试第${number}集`,assetId:video.id}})).status,200);
  const draft=(await request(`/api/admin/series/${id}`,{actor:actors.admin})).data;
  assert.equal(draft.assets.length,2);
  // 使用真正处理完成的第二份视频，验证补集不会覆盖，以及替换校验和重试幂等。
  const replacement=await upload(await fs.readFile(videoPath),'video','video/mp4');assert.equal(replacement.status,'ready');
  const episode=draft.episodes[1],episodeRoute=`/api/admin/series/${id}/episodes`;
  assert.equal((await request(episodeRoute,{actor:actors.admin,body:{number:2,assetId:replacement.id,mode:'append'}})).status,409);
  assert.equal((await request(episodeRoute,{actor:actors.admin,body:{number:2,assetId:replacement.id}})).status,409);
  assert.equal((await request(episodeRoute,{actor:actors.admin,body:{number:2,assetId:replacement.id,mode:'replace',expectedEpisodeId:episode.id,expectedAssetId:'已变化的素材'}})).status,409);
  const replaceInput={number:2,title:'明确替换第二集',assetId:replacement.id,mode:'replace',expectedEpisodeId:episode.id,expectedAssetId:video.id};
  for(let attempt=0;attempt<2;attempt++) {
    const result=await request(episodeRoute,{actor:actors.admin,body:replaceInput});assert.equal(result.status,200);
    assert.equal(result.data.episodes.length,4);assert.equal(result.data.episodes[1].id,episode.id);assert.equal(result.data.episodes[1].assetId,replacement.id);
  }
  assert.equal((await request(episodeRoute,{actor:actors.admin,body:{...replaceInput,assetId:video.id}})).status,409);
  assert.equal((await request(`/api/admin/uploads/${video.id}`,{actor:actors.admin})).data.status,'ready');
  const disposable=(await request('/api/admin/uploads',{actor:actors.admin,body:{name:'待取消.mp4',size:100,kind:'video',mime:'video/mp4'}})).data;
  assert.equal((await request(`/api/admin/uploads/${disposable.id}`,{actor:actors.first,method:'DELETE'})).status,401);
  assert.equal((await request(`/api/admin/uploads/${disposable.id}`,{actor:actors.admin,method:'DELETE'})).data.status,'failed');
  await assert.rejects(fs.stat(path.join(directory,'media',`${disposable.id}.part`)),{code:'ENOENT'});
  assert.equal((await request(`/api/admin/uploads/${video.id}`,{actor:actors.admin,method:'DELETE'})).data.status,'ready');
  assert.ok((await fs.stat(path.join(directory,'media',video.id))).size>0);
  assert.equal((await request('/api/admin/series?page=2',{actor:actors.admin})).data.items.length,0);
  assert.equal((await request('/api/admin/uploads?page=2',{actor:actors.admin})).data.items.length,0);
  const ids=draft.episodes.map(row=>row.id);
  assert.equal((await request(`/api/admin/series/${id}/reorder`,{actor:actors.admin,body:{ids:[ids[1],ids[0],ids[2],ids[3]]}})).status,200);
  assert.equal((await request(`/api/admin/series/${id}/reorder`,{actor:actors.admin,body:{ids}})).status,200);
  assert.equal((await request(`/api/admin/series/${id}/publish`,{actor:actors.admin,body:{status:'published'}})).status,200);
  assert.equal((await request(`/api/admin/series/${id}/episodes`,{actor:actors.admin,body:{number:1,title:'替换',assetId:video.id}})).status,409);
  const detail=(await request(`/api/series/${id}`)).data;assert.deepEqual(detail.episodes.map(row=>row.locked),[false,false,false,true]);
  assert.equal(detail.tags,'Romance');assert.equal(content.list({tag:'romance',tagLabel:'爱情'}).length,1);assert.equal(content.list({tag:'urban',tagLabel:'都市'}).length,0);
  for(const episode of detail.episodes.slice(0,3))assert.equal((await request(`/api/episodes/${episode.id}/qualities?seriesId=${id}`)).status,200);
  const paid=detail.episodes[3].id, free=detail.episodes[0].id;
  for(const endpoint of ['qualities','play','stream'])assert.equal((await request(`/api/episodes/${paid}/${endpoint}?seriesId=${id}`)).status,403);
  assert.equal((await request(`/api/episodes/${paid}/stream?seriesId=${id}`,{method:'HEAD'})).status,403);
  assert.equal((await request(`/api/episodes/${paid}/stream`)).status,400);
  const range=await request(`/api/episodes/${free}/stream?seriesId=${id}`,{headers:{Range:'bytes=0-15'}});assert.equal(range.status,206);assert.equal(range.data.length,16);assert.match(range.response.headers.get('content-range'),/^bytes 0-15\//);
  assert.equal(range.response.headers.get('x-video-quality'),'160P');
  assert.equal((await request(`/api/episodes/${free}/stream?seriesId=${id}&quality=1080P`)).status,400);
  assert.equal((await request(`/api/episodes/${free}/stream?seriesId=${id}`,{headers:{Range:'bytes=-8'}})).data.length,8);
  assert.equal((await request(`/api/episodes/${free}/stream?seriesId=${id}`,{headers:{Range:'bytes=10-2'}})).status,416);
  const another=await request('/api/admin/series',{actor:actors.admin,body:{title:'归属校验短剧',description:'',tags:'爱情',contentType:'real-drama',language:'en',coverId:cover.id}});
  await request(`/api/admin/series/${another.data.id}/episodes`,{actor:actors.admin,body:{number:1,title:'独立分集',assetId:video.id}});
  await request(`/api/admin/series/${another.data.id}/publish`,{actor:actors.admin,body:{status:'published'}});
  assert.equal((await request(`/api/episodes/${paid}/stream?seriesId=${another.data.id}`)).status,404);
  const grant=()=>request('/api/admin/membership',{actor:actors.admin,body:{accountId:first.id,periodEnd:Date.now()+86400000,reason:'接口验收'}});
  assert.equal((await grant()).status,200);
  assert.equal((await request(`/api/episodes/${paid}/qualities?seriesId=${id}`,{actor:actors.first})).status,200);
  assert.equal((await request(`/api/episodes/${paid}/qualities?seriesId=${id}`,{actor:actors.second})).status,403);
  store.db.prepare('UPDATE account_manual_vip SET period_end=? WHERE account_id=?').run(Date.now()-1,first.id);
  assert.equal((await request(`/api/episodes/${paid}/qualities?seriesId=${id}`,{actor:actors.first})).status,403);
  await grant();
  const social=`/api/episodes/${free}`,query=`?seriesId=${id}`;
  assert.equal((await request(`${social}/likes${query}`,{body:{liked:true}})).status,401);
  await request(`${social}/likes${query}`,{actor:actors.first,body:{liked:true}});await request(`${social}/likes${query}`,{actor:actors.first,body:{liked:true}});
  assert.equal((await request(`${social}/interactions${query}`)).data.likes,1);
  assert.equal((await request(`/api/episodes/${paid}/interactions${query}`)).data.likes,0);
  assert.equal((await request('/api/me/likes')).status,401);
  const liked=(await request('/api/me/likes',{actor:actors.first})).data;
  assert.equal(liked.count,1);assert.equal(liked.items[0].episodeId,free);assert.equal(liked.items[0].series.id,id);assert.equal(liked.items[0].episodeNumber,1);assert.equal(liked.items[0].available,true);
  assert.equal((await request(`/api/me/likes?accountId=${first.id}`,{actor:actors.second})).data.count,0);
  assert.deepEqual((await request('/api/me/likes?summary=1',{actor:actors.first})).data,{count:1});
  assert.equal((await request('/api/me/likes?before=invalid',{actor:actors.first})).status,400);
  assert.equal((await request(`/api/me/likes/${free}`,{actor:actors.first,body:{},requestOrigin:'https://untrusted.example'})).status,403);
  const comment=await request(`${social}/comments${query}`,{actor:actors.first,body:{body:'真实保存的评论'}});assert.equal(comment.status,200);
  assert.equal((await request(`/api/comments/${comment.data.id}`,{actor:actors.second,method:'DELETE'})).status,403);
  await request(`/api/comments/${comment.data.id}/report`,{actor:actors.second,body:{}});
  assert.equal((await request('/api/admin/comment-series')).status,401);
  assert.equal((await request(`/api/admin/comments?seriesId=${id}`,{actor:actors.first})).status,401);
  const moderation=(await request(`/api/admin/comments?seriesId=${id}&episodeId=${free}`,{actor:actors.admin})).data;
  assert.equal(moderation.items[0].reports,1);
  assert.equal(moderation.items[0].seriesTitle,'数据库验收短剧');
  assert.equal(moderation.items[0].episodeNumber,1);
  assert.equal(moderation.items[0].account_id,undefined);
  assert.equal(moderation.episodes.length,4);
  assert.equal((await request(`/api/admin/comments?seriesId=${id}&episodeId=${paid}`,{actor:actors.admin})).data.items.length,0);
  assert.equal((await request(`/api/admin/comments?seriesId=${id}&episodeId=123`,{actor:actors.admin})).status,404);
  assert.equal((await request('/api/admin/comments',{actor:actors.admin})).status,400);
  assert.equal((await request(`/api/admin/comments?seriesId=${id}&page=bad`,{actor:actors.admin})).status,400);
  const moderationSeries=(await request('/api/admin/comment-series?q=数据库验收',{actor:actors.admin})).data;
  assert.equal(moderationSeries.items[0].title,'数据库验收短剧');
  assert.equal(moderationSeries.items[0].comments,1);
  assert.equal(moderationSeries.items[0].reports,1);
  await request(`/api/admin/comments/${comment.data.id}`,{actor:actors.admin,body:{status:'hidden'}});
  assert.equal((await request(`${social}/comments${query}`)).data.items.length,0);
  await request(`/api/admin/comments/${comment.data.id}`,{actor:actors.admin,body:{status:'visible'}});
  assert.equal((await request(`${social}/comments${query}`,{actor:actors.first})).data.items[0].own,true);
  await request(`/api/comments/${comment.data.id}`,{actor:actors.first,method:'DELETE'});
  assert.equal((await request(`${social}/interactions${query}`)).data.comments,0);
  const sameTime=Date.now()-1000;
  content.store.transaction(()=>{for(let index=0;index<32;index++)content.store.db.prepare('INSERT INTO episode_comments(id,episode_id,series_id,account_id,body,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),free,id,first.id,`同一时间评论${index}`,sameTime);});
  const firstPage=(await request(`${social}/comments${query}`)).data;
  const secondPage=(await request(`${social}/comments${query}&before=${encodeURIComponent(firstPage.next)}`)).data;
  assert.equal(firstPage.items.length,30);assert.equal(secondPage.items.length,2);
  assert.equal(new Set([...firstPage.items,...secondPage.items].map(row=>row.id)).size,32);
  await request('/api/admin/membership',{actor:actors.admin,body:{accountId:first.id,revoke:true,reason:'测试结束'}});
  assert.equal((await request(`/api/episodes/${paid}/qualities?seriesId=${id}`,{actor:actors.first})).status,403);
  assert.ok((await request('/api/admin/audit?scope=platform',{actor:actors.admin})).data.items.some(row=>row.action==='撤销手动会员'));
  assert.equal((await request('/api/admin/audit-series')).status,401);
  assert.equal((await request(`/api/admin/audit?seriesId=${id}`,{actor:actors.first})).status,401);
  assert.equal((await request('/api/admin/audit',{actor:actors.admin})).status,400);
  assert.equal((await request(`/api/admin/audit?seriesId=${id}&episodeId=123`,{actor:actors.admin})).status,404);
  const audit=(await request(`/api/admin/audit?seriesId=${id}&episodeId=${free}`,{actor:actors.admin})).data;
  assert.ok(audit.items.some(row=>row.action==='处理评论'&&row.targets.some(target=>target.number===1)));
  assert.ok(audit.items.every(row=>row.actorName===teamAdmin.code&&row.actorEmail===null&&row.target_id===undefined&&row.admin_id===undefined&&row.detail===undefined));
  assert.equal((await request('/api/admin/audit-series?q=数据库验收',{actor:actors.admin})).data.items[0].title,'数据库验收短剧');
  assert.equal((await request(`/api/admin/creators?seriesId=${id}`,{actor:actors.admin})).status,404);
  const teamMember=content.team.create(await passwordHash('作品授权回归密码2026'),['analyst'],[]);
  content.team.update({headers:{cookie:actors.admin.cookie}},teamMember.id,{roles:['analyst'],enabled:true,seriesIds:[id]});
  assert.equal(content.team.allowed(content.team.member(teamMember.id),'analyst',id),true);
  await request(`/api/admin/series/${id}/publish`,{actor:actors.admin,body:{status:'draft'}});
  assert.equal((await request(`/api/episodes/${free}/stream?seriesId=${id}`)).status,404);
  const unavailable=(await request('/api/me/likes',{actor:actors.first})).data.items[0];
  assert.equal(unavailable.available,false);assert.equal(unavailable.series,null);
  await request(`/api/me/likes/${free}`,{actor:actors.second,body:{}});
  assert.equal((await request('/api/me/likes?summary=1',{actor:actors.first})).data.count,1);
  await request(`/api/me/likes/${free}`,{actor:actors.first,body:{}});
  assert.equal((await request('/api/me/likes',{actor:actors.first})).data.count,0);
});

test('旧点赞记录迁移不丢失，同毫秒分页不漏集，重启后保留真实内容归属',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-likes-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const legacy=new DatabaseSync(path.join(directory,'content.sqlite'));
  legacy.exec('CREATE TABLE episode_likes(episode_id TEXT NOT NULL,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(episode_id,account_id))');
  for(let index=1;index<=25;index++)legacy.prepare('INSERT INTO episode_likes VALUES(?,?,?)').run(String(1000+index),'first',123456);
  legacy.close();
  let store=new ContentStore(directory);
  store.rememberLikedEpisode({id:'123',title:'真实内容元数据',cover:'/cover.png',tags:'Romance',episodes:[{id:'1025',number:2}]},{id:'1025',number:2});
  store.close();store=new ContentStore(directory);
  try {
    const first=store.likedEpisodes('first'),second=store.likedEpisodes('first',first.next);
    assert.equal(first.count,25);assert.equal(first.items.length,20);assert.equal(second.items.length,5);assert.equal(second.next,null);
    assert.equal(new Set([...first.items,...second.items].map(row=>row.episodeId)).size,25);
    assert.equal(first.items[0].series.title,'真实内容元数据');assert.equal(first.items[0].episodeNumber,2);
    assert.equal(first.items[1].series,null);assert.equal(first.items[1].available,false);
    assert.equal(store.likedEpisodes('second',null,true).count,0);
  } finally { store.close(); }
});
