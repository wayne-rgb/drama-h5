import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { AccountStore, digest } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { createContentService } from '../server/content-service.mjs';
import { createApiPolicy } from '../server/api-policy.mjs';
import { totp } from '../server/account-mfa.mjs';

const origin='http://127.0.0.1:8793',password='团队权限真实回归密码2026',bootstrapToken='team-regression-bootstrap-2026-owner';
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-team-')),users=new AccountStore(':memory:');
  const config={APP_ORIGIN:origin,TEAM_BOOTSTRAP_TOKEN:bootstrapToken},accounts=createAccountService(users,config),content=createContentService(directory,users,accounts,{},config),team=content.team;
  const policy=createApiPolicy(accounts,users,config,team);
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,origin);policy(req,res,url);if(await accounts.handle(req,res,url)||await content.handle(req,res,url))return;throw Error('未处理测试路由');}catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});content.close();users.close();await fs.rm(directory,{recursive:true,force:true});});
  const request=async(route,data,cookie='',requestOrigin=origin)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:data===undefined?'GET':'POST',headers:{Origin:requestOrigin,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  };
  const activate=async(initial)=>{
    const setup=await request('/api/team/mfa/setup',{},initial.cookie);assert.equal(setup.status,200);
    const enabled=await request('/api/team/mfa/enable',{token:setup.data.token,code:totp(setup.data.secret,Math.floor(Date.now()/30000)-1)},initial.cookie);assert.equal(enabled.status,200);
    return {...enabled,member:initial.data.member,secret:setup.data.secret};
  };
  const owner=async()=>activate(await request('/api/team/bootstrap',{token:bootstrapToken,password}));
  const series=actor=>content.store.saveSeries(team.member(actor.member.id),{title:'真实团队作品',description:'',contentType:'real-drama',language:'en'});
  const member=async(actor,roles,seriesIds=[])=>{const invite=await request('/api/team/invites',{roles,seriesIds},actor.cookie);assert.equal(invite.status,200);const joined=await request('/api/team/join',{token:invite.data.token,password});assert.equal(joined.status,200);return activate(joined);};
  return {directory,users,accounts,content,team,config,policy,request,activate,owner,series,member};
}

test('初始化只执行一次，未完成二次验证无后台权限，团队数据与观众账户独立',async t=>{
  const f=await fixture(t),initial=await f.request('/api/team/bootstrap',{token:bootstrapToken,password});
  assert.equal(initial.status,200);assert.match(initial.data.member.code,/^M-[A-F0-9]{12}$/);
  assert.equal((await f.request('/api/admin/accounts',undefined,initial.cookie)).status,401);
  const owner=await f.activate(initial);
  assert.equal((await f.request('/api/team/session',undefined,owner.cookie)).data.verified,true);
  assert.equal((await f.request('/api/team/bootstrap',{token:bootstrapToken,password})).status,403);
  assert.equal(f.users.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,0);
  for(const table of ['team_members','team_sessions','team_invites','team_events'])assert.equal(f.team.db.prepare(`PRAGMA table_info(${table})`).all().some(row=>/email|phone|name|device|account_id/.test(row.name)),false);
  const stored=f.team.member(owner.member.id);assert.equal(stored.password_hash.includes(password),false);
  const credentials=f.team.db.prepare('SELECT * FROM team_mfa').get();assert.equal(credentials.secret.includes(owner.secret),false);assert.equal(credentials.recovery.includes(owner.data.recoveryCodes[0]),false);
  assert.equal(f.team.db.prepare('SELECT * FROM team_sessions WHERE token_hash=?').get(digest(owner.cookie.split('=')[1])).verified,1);
  assert.equal((await f.request('/api/team/members',undefined,owner.cookie,'https://external.example')).status,403);
});

test('邀请单次消费、并发加入不重复，撤销与过期后不能加入',async t=>{
  const f=await fixture(t),owner=await f.owner(),series=f.series(owner);
  const invite=await f.request('/api/team/invites',{roles:['editor'],seriesIds:[series.id]},owner.cookie);
  assert.equal(f.team.db.prepare('SELECT token_hash FROM team_invites WHERE id=?').get(invite.data.id).token_hash,digest(invite.data.token));
  const joined=await Promise.all([f.request('/api/team/join',{token:invite.data.token,password}),f.request('/api/team/join',{token:invite.data.token,password})]);assert.deepEqual(joined.map(row=>row.status).sort(),[200,400]);
  const revoked=await f.request('/api/team/invites',{roles:['analyst'],seriesIds:[]},owner.cookie);
  assert.equal((await f.request(`/api/team/invites/${revoked.data.id}/revoke`,{},owner.cookie)).status,200);assert.equal((await f.request('/api/team/join',{token:revoked.data.token,password})).status,400);
  const expired=await f.request('/api/team/invites',{roles:['analyst']},owner.cookie);f.team.db.prepare('UPDATE team_invites SET expires_at=0 WHERE id=?').run(expired.data.id);assert.equal((await f.request('/api/team/join',{token:expired.data.token,password})).status,400);
  assert.equal(f.team.db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n,2);
});

test('作品列表在分页前隔离，运营不能查看账号、成员、审计、统计或越权创建作品',async t=>{
  const f=await fixture(t),owner=await f.owner(),first=f.series(owner),second=f.series(owner),editor=await f.member(owner,['editor'],[first.id]);
  const list=await f.request('/api/admin/series',undefined,editor.cookie);assert.deepEqual(list.data.items.map(row=>row.id),[first.id]);
  for(const route of ['/api/admin/accounts','/api/team/members','/api/admin/audit-series','/api/analytics/report',`/api/admin/series/${second.id}`])assert.equal((await f.request(route,undefined,editor.cookie)).status,403,route);
  assert.equal((await f.request('/api/admin/series',{title:'越权新增'},editor.cookie)).status,403);
  assert.equal((await f.request('/api/admin/uploads',{name:'素材',size:1,kind:'video',mime:'video/mp4',seriesId:second.id,number:1},editor.cookie)).status,403);
  assert.equal((await f.request('/api/admin/creators',undefined,owner.cookie)).status,404);
  const outsider=f.users.create({email:'separate@example.test',name:'独立观众'}),cookie=`hg_account_session=${f.users.session(outsider.id)}`;
  f.config.ADMIN_ACCOUNT_IDS=outsider.id;
  assert.equal((await f.request('/api/admin/accounts',undefined,cookie)).status,401);
});

test('授权更新撤销既有会话，角色组合生效，停用成员后密码和恢复码都不能进入',async t=>{
  const f=await fixture(t),owner=await f.owner(),first=f.series(owner),second=f.series(owner),editor=await f.member(owner,['editor'],[first.id]);
  const roles=['moderator','analyst'];
  assert.equal((await f.request(`/api/team/members/${editor.member.id}`,{roles,seriesIds:[second.id],enabled:true},owner.cookie)).status,200);
  assert.equal((await f.request('/api/admin/series',undefined,editor.cookie)).status,401);
  const initial=await f.request('/api/team/login',{code:editor.member.code,password}),signed=await f.request('/api/team/mfa/verify',{code:editor.data.recoveryCodes[0]},initial.cookie);
  assert.equal(signed.status,200);
  assert.equal((await f.request('/api/admin/series',undefined,signed.cookie)).status,403);
  assert.equal((await f.request(`/api/analytics/report?seriesId=${first.id}`,undefined,signed.cookie)).status,403);
  assert.equal((await f.request(`/api/analytics/report?seriesId=${second.id}`,undefined,signed.cookie)).status,200);
  assert.deepEqual((await f.request('/api/admin/comment-series',undefined,signed.cookie)).data.items.map(row=>row.id),[second.id]);
  assert.equal((await f.request(`/api/team/members/${editor.member.id}`,{roles,seriesIds:[second.id],enabled:false},owner.cookie)).status,200);
  assert.equal((await f.request('/api/team/login',{code:editor.member.code,password})).status,401);
  assert.equal((await f.request('/api/team/recover',{code:editor.member.code,recoveryCode:editor.data.recoveryCodes[1],password})).status,400);
  assert.equal((await f.request(`/api/team/members/${owner.member.id}`,{roles:['editor'],seriesIds:[],enabled:true},owner.cookie)).status,400);
});

test('恢复码重设密码会撤销所有旧会话，动态码和恢复码均不可重用',async t=>{
  const f=await fixture(t),owner=await f.owner(),initial=await f.request('/api/team/login',{code:owner.member.code,password});
  const code=totp(owner.secret),verified=await f.request('/api/team/mfa/verify',{code},initial.cookie);assert.equal(verified.status,200);
  const another=await f.request('/api/team/login',{code:owner.member.code,password});assert.equal((await f.request('/api/team/mfa/verify',{code},another.cookie)).status,400);
  const recovered=await f.request('/api/team/recover',{code:owner.member.code,recoveryCode:owner.data.recoveryCodes[0],password:'新的团队回归密码2026'});assert.equal(recovered.status,200);assert.equal(recovered.data.member.id,owner.member.id);
  assert.equal((await f.request('/api/team/members',undefined,verified.cookie)).status,401);
  assert.equal((await f.request('/api/team/mfa/verify',{code:owner.data.recoveryCodes[0]},recovered.cookie)).status,400);
  assert.equal((await f.request('/api/team/mfa/verify',{code:owner.data.recoveryCodes[1]},recovered.cookie)).status,200);
  assert.equal((await f.request('/api/team/login',{code:owner.member.code,password})).status,401);
});

test('正文读取期间被撤权，不得使用旧权限完成内容写入',async t=>{
  const f=await fixture(t),owner=await f.owner(),series=f.series(owner),editor=await f.member(owner,['editor'],[series.id]);
  const req=new PassThrough(),route=`/api/admin/series/${series.id}`;Object.assign(req,{method:'POST',url:route,headers:{origin,cookie:editor.cookie,'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});
  const res={setHeader(){},writeHead(){assert.fail('撤权后的写入不能成功');},end(){}};f.policy(req,res,new URL(route,origin));
  let arrived;const started=new Promise(resolve=>{arrived=resolve;}),iterator=req.iterator.bind(req);req.iterator=options=>{arrived();return iterator(options);};
  const handling=f.content.handle(req,res,new URL(route,origin)),rejected=assert.rejects(handling,error=>error.status===401);
  await started;await f.request(`/api/team/members/${editor.member.id}`,{roles:['editor'],enabled:false,seriesIds:[]},owner.cookie);
  req.end(JSON.stringify({title:'不应保存',description:'',contentType:'real-drama',language:'en'}));await rejected;
  assert.equal(f.content.store.row(series.id).title,'真实团队作品');
});

test('真实服务入口接受团队视频预览，免费和VIP集保留范围请求且不写入观众统计',async t=>{
  const f=await fixture(t),owner=await f.owner(),series=f.series(owner),asset=crypto.randomUUID(),videoPath=path.join(f.directory,'media',asset);
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=180x320:r=24:d=1','-c:v','libx264','-pix_fmt','yuv420p','-f','mp4',videoPath]);
  const size=(await fs.stat(videoPath)).size;
  f.team.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(asset,owner.member.id,'团队预览验收素材','video','video/mp4',size,'ready',JSON.stringify({duration:1,width:180,height:320}),Date.now());
  let detail;for(let number=1;number<=4;number++)detail=f.content.store.saveEpisode(f.team.member(owner.member.id),series.id,{number,assetId:asset});
  f.team.db.prepare("UPDATE content_series SET status='published' WHERE id=?").run(series.id);
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_ENV_FILE:path.join(f.directory,'absent.env'),HG_DATA_DIR:f.directory,HG_HOST:'127.0.0.1',PORT:'0',APP_ORIGIN:origin,HG_MANAGED:'',ADMIN_ACCOUNT_IDS:'',ADMIN_EMAILS:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none'},stdio:['ignore','ignore','ignore','ipc']});
  const stop=async()=>{if(child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await ended;}};
  try {
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('团队预览服务启动超时')),10000);child.once('error',reject);child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});});
    const headers={Origin:origin,Cookie:owner.cookie},base=`http://127.0.0.1:${port}`;
    for(const episode of [detail.episodes[0],detail.episodes[3]]) {
      const source=await fetch(`${base}/api/episodes/${episode.id}/play?seriesId=${series.id}`,{headers});assert.equal(source.status,200);
      const value=await source.json(),stream=await fetch(base+value.path,{headers:{...headers,Range:'bytes=0-15'}});assert.equal(stream.status,206);assert.equal((await stream.arrayBuffer()).byteLength,16);
      const tracking=await fetch(base+'/api/analytics/sessions',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({seriesId:series.id,episodeId:episode.id,entry:'detail',requestId:crypto.randomUUID()})});assert.equal(tracking.status,200);assert.deepEqual(await tracking.json(),{excluded:true});
    }
    assert.equal(f.team.db.prepare('SELECT COUNT(*) AS n FROM analytics_sessions').get().n,0);
    f.team.db.prepare('UPDATE team_members SET enabled=0 WHERE id=?').run(owner.member.id);
    assert.equal((await fetch(`${base}/api/episodes/${detail.episodes[3].id}/stream?seriesId=${series.id}`,{headers})).status,401);
  } finally { await stop(); }
});
