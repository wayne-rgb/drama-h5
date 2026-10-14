import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { AccountStore, passwordHash } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { createApiPolicy } from '../server/api-policy.mjs';
import { createLocalAccess } from '../server/local-access.mjs';
import { createContentService } from '../server/content-service.mjs';
import { readJson } from '../shared/http-json.mjs';
import { PlaybackGuard } from '../server/playback-guard.mjs';
import { TrafficBudget } from '../server/traffic-budget.mjs';
import desktopProxy from '../apps/web-pc/electron/desktop-proxy.cjs';
import { LibraryStore } from '../shared/library-store.mjs';
import { LibrarySync } from '../server/library-sync.mjs';

const origin = 'http://127.0.0.1:8793';
const uploadId = '00000000-0000-4000-8000-000000000001';
function fixture(t) {
  const users = new AccountStore(':memory:');
  const admin = users.create({ email:'admin@example.test',name:'管理员',verified:true });
  const member = users.create({ email:'member@example.test',name:'会员',verified:true });
  const viewer = users.create({ email:'viewer@example.test',name:'普通观众',verified:true });
  const creator = users.create({ email:'creator@example.test',name:'创作者',verified:true });
  users.db.prepare('INSERT INTO account_creators VALUES(?,?,?)').run(creator.id,admin.id,Date.now());
  users.saveSubscription('授权验收会员', { id:'sub_authorization',accountId:member.id,planId:'monthly',status:'active',periodEnd:Date.now()+86400000,cancelAtPeriodEnd:false },Date.now());
  const config = {APP_ORIGIN:origin,ADMIN_ACCOUNT_IDS:admin.id};
  const accounts = createAccountService(users,config), policy = createApiPolicy(accounts,users,config);
  const actors = Object.fromEntries(Object.entries({admin,member,viewer,creator}).map(([key,user])=>[key,{user,token:users.session(user.id)}]));
  const guest = users.guestSession(); actors.guest = { user:{id:guest.id,guest:true},cookie:`hg_guest_session=${guest.token}` };
  const request = (route, method='GET',actor) => ({url:route,method,headers:{host:'127.0.0.1:8793',origin,'content-type':'application/json',...(actor?.token?{cookie:`hg_account_session=${actor.token}`} : actor?.cookie?{cookie:actor.cookie}:{})},socket:{remoteAddress:'127.0.0.1',localPort:8793}});
  const authorize = (route,method,actor) => {const req=request(route,method,actor),headers={};policy(req,{setHeader:(key,value)=>{headers[key]=value}},new URL(route,origin));return {req,headers};};
  t.after(()=>users.close());
  return {users,accounts,policy,actors,request,authorize};
}

test('公开目录、播放入口和账户流程只允许声明的方法，未知路由默认拒绝', t => {
  const f=fixture(t);
  for(const route of ['/api/banners','/api/sections','/api/home','/api/search','/api/ranks','/api/rank/types','/api/rank/list','/api/rank/page','/api/category/tags','/api/category/list','/api/series/91','/api/series/91/related','/api/series/91/recommend','/api/episodes/101/qualities','/api/episodes/101/play','/api/episodes/101/stream',`/api/content/covers/${uploadId}`]) {
    assert.doesNotThrow(()=>f.authorize(route,'GET'));
    assert.throws(()=>f.authorize(route,'POST'),error=>error.status===405,route);
  }
  for(const route of ['/api/auth/register','/api/auth/login','/api/auth/recover','/api/auth/reset','/api/auth/verify','/api/auth/logout'])assert.doesNotThrow(()=>f.authorize(route,'POST'));
  for(const route of ['/api/account/session','/api/auth/google/start','/api/auth/google/callback','/api/episodes/101/interactions','/api/episodes/101/comments'])assert.doesNotThrow(()=>f.authorize(route,'GET'));
  for(const route of ['/api','/api/admin/unknown','/api/account/export','/api/episodes/101/source','/api/series/91/internal'])assert.throws(()=>f.authorize(route,'GET',f.actors.admin),error=>error.status===404);
});

test('账户、会员、互动和后台接口拒绝游客及普通用户提权，创作者权限限于报告入口', t => {
  const f=fixture(t);
  const privateRoutes=[['/api/account/profile','POST'],['/api/account/avatar','GET'],['/api/auth/verification','POST'],['/api/me/likes','GET'],['/api/me/likes/101','POST'],['/api/episodes/101/likes','POST'],['/api/episodes/101/comments','POST'],[`/api/comments/${uploadId}`,'DELETE'],[`/api/comments/${uploadId}/report`,'POST'],['/api/billing/checkout','POST'],['/api/billing/portal','POST'],['/api/billing/confirm','POST']];
  for(const [route,method] of privateRoutes){assert.throws(()=>f.authorize(route,method,f.actors.guest),error=>error.status===401,route);assert.doesNotThrow(()=>f.authorize(route,method,f.actors.viewer));}
  const adminRoutes=[['/api/admin/series','GET'],['/api/admin/series','POST'],['/api/admin/creators','GET'],['/api/admin/creators','POST'],['/api/admin/uploads','GET'],['/api/admin/uploads','POST'],['/api/admin/accounts','GET'],['/api/admin/membership','POST'],['/api/admin/comment-series','GET'],['/api/admin/comments','GET'],['/api/admin/audit-series','GET'],['/api/admin/audit','GET'],['/api/admin/series/91','GET'],['/api/admin/series/91','POST'],['/api/admin/series/91/episodes','POST'],['/api/admin/series/91/publish','POST'],['/api/admin/series/91/reorder','POST'],['/api/admin/series/91/creator','POST'],['/api/admin/series/91/episodes/101','DELETE'],[`/api/admin/uploads/${uploadId}`,'GET'],[`/api/admin/uploads/${uploadId}`,'PUT'],[`/api/admin/uploads/${uploadId}`,'DELETE'],[`/api/admin/comments/${uploadId}`,'POST']];
  for(const [route,method] of adminRoutes){for(const actor of [f.actors.viewer,f.actors.member,f.actors.creator])assert.throws(()=>f.authorize(route,method,actor),error=>error.status===403,route);assert.doesNotThrow(()=>f.authorize(route,method,f.actors.admin));}
  for(const route of ['/api/analytics/series','/api/analytics/report']){assert.throws(()=>f.authorize(route,'GET',f.actors.member),error=>error.status===403);assert.doesNotThrow(()=>f.authorize(route,'GET',f.actors.creator));}
  for(const route of ['/api/analytics/sessions','/api/analytics/progress']){assert.throws(()=>f.authorize(route,'POST'),error=>error.status===401);assert.doesNotThrow(()=>f.authorize(route,'POST',f.actors.guest));}
});

test('私有读取与写入拒绝外站来源，预检不能增加方法或绕过后台权限', t => {
  const f=fixture(t), res={setHeader(){}};
  const foreign=f.request('/api/account/avatar','GET',f.actors.admin);foreign.headers.origin='https://other.example';
  assert.throws(()=>f.policy(foreign,res,new URL(foreign.url,origin)),error=>error.status===403);
  const preflight=f.request('/api/admin/accounts','OPTIONS');preflight.headers.origin='https://other.example';preflight.headers['access-control-request-method']='GET';
  assert.throws(()=>f.policy(preflight,res,new URL(preflight.url,origin)),error=>error.status===403);
  preflight.headers.origin=origin;preflight.headers['access-control-request-method']='POST';
  assert.throws(()=>f.policy(preflight,res,new URL(preflight.url,origin)),error=>error.status===405);
  preflight.headers['access-control-request-method']='GET';assert.doesNotThrow(()=>f.policy(preflight,res,new URL(preflight.url,origin)));
  assert.throws(()=>f.authorize('/api/admin/accounts','GET'),error=>error.status===401);
});

test('个人库和历史每条接口绑定会话归属，猜测账户编号或缺少归属声明不能读取', t => {
  const f=fixture(t), routes=[['/api/library','GET'],['/api/library/sync','GET'],['/api/library/operations','POST'],['/api/library/import','POST'],['/api/history','GET'],['/api/history','DELETE'],['/api/history/sessions','POST'],['/api/history/progress','POST'],['/api/history/import','POST'],['/api/history/91','GET'],['/api/history/91','DELETE'],['/api/recommend','GET']];
  for(const [route,method] of routes){const req=f.request(route,method,f.actors.viewer),res={setHeader(){}};assert.throws(()=>f.policy(req,res,new URL(route,origin)),error=>error.status===409);req.headers['x-library-owner']=f.actors.admin.user.id;assert.throws(()=>f.policy(req,res,new URL(route,origin)),error=>error.status===409);req.headers['x-library-owner']=f.actors.viewer.user.id;assert.doesNotThrow(()=>f.policy(req,res,new URL(route,origin)));}
  const sync=f.request('/api/library/sync','POST',f.actors.viewer);sync.headers['x-library-owner']=f.actors.viewer.user.id;
  assert.throws(()=>f.policy(sync,{setHeader(){}},new URL(sync.url,origin)),error=>error.status===403);
});

test('读取正文期间退出会话，完成读取后拒绝提交而不继续使用旧身份', async t => {
  const f=fixture(t);let arrived, finish;
  const reading=new Promise(resolve=>{arrived=resolve;}), completed=new Promise(resolve=>{finish=resolve;});
  const input=Readable.from((async function*(){yield Buffer.from('{"name":');arrived();await completed;yield Buffer.from('"待保存资料"}');})());
  const initial=f.request('/api/account/profile','POST',f.actors.viewer);Object.assign(input,initial);
  f.policy(input,{setHeader(){}},new URL(initial.url,origin));
  const result=readJson(input), rejected=assert.rejects(result,error=>error.status===401);
  await reading;f.users.logout(f.actors.viewer.token);finish();await rejected;
  assert.equal(f.users.byId(f.actors.viewer.user.id).name,'普通观众');
});

test('远程同步握手等待期间管理员退出，配置不能继续保存或开始同步', async t => {
  const f=fixture(t),library=new LibraryStore(':memory:'),sync=new LibrarySync(library);
  t.after(()=>{sync.stop();library.close();});
  const req=f.request('/api/library/sync','POST',f.actors.admin);req.headers['x-library-owner']=f.actors.admin.user.id;
  f.policy(req,{setHeader(){}},new URL(req.url,origin));
  let complete;sync.request=()=>new Promise(resolve=>{complete=resolve;});
  const configured=sync.configure({url:'https://sync.example',key:'isolated-test-key-123456'},req.revalidateAccess);
  const rejected=assert.rejects(configured,error=>error.status===409);
  f.users.logout(f.actors.admin.token);complete({protocolVersion:1,instanceId:'qa-instance',serverTime:Date.now()});
  await rejected;assert.equal(library.getMeta('syncConfig'),null);assert.equal(sync.view().enabled,false);
});

test('桌面豁免要求真实本机与可信来源，null来源、伪造Host和转发头均不能取得本地权限', () => {
  const token='a'.repeat(64), access=createLocalAccess({HG_MANAGED:'1',HG_DESKTOP_TOKEN:token},origin);
  const req={headers:{host:'127.0.0.1:8793'},socket:{remoteAddress:'127.0.0.1',localPort:8793}};
  assert.equal(access.local(req),true);
  req.headers.origin='null';assert.equal(access.local(req),false);assert.throws(()=>access.sameOrigin(req),error=>error.status===403);
  req.headers['x-desktop-token']=token;assert.equal(access.local(req),true);assert.doesNotThrow(()=>access.sameOrigin(req));
  req.socket.remoteAddress='192.0.2.1';req.headers['x-forwarded-for']='127.0.0.1';assert.equal(access.local(req),false);
  req.socket.remoteAddress='127.0.0.1';req.headers.host='external.example:8793';assert.equal(access.local(req),false);
  req.headers.host='127.0.0.1:8793';delete req.headers['x-desktop-token'];req.headers.origin='https://other.example';assert.equal(access.local(req),false);
  delete req.headers.origin;assert.equal(access.local(req),false);
  delete req.headers['x-forwarded-for'];assert.equal(access.local(req),true);
  const publicSite=createLocalAccess({HG_MANAGED:'1',HG_DESKTOP_TOKEN:token},'https://drama.example');
  assert.equal(publicSite.local(req),false);req.headers['x-desktop-token']=token;assert.equal(publicSite.local(req),true);
});

test('桌面代理只向固定本机后端附加证明，保留会话、请求正文与视频Range', async t => {
  const token='b'.repeat(64),access=createLocalAccess({HG_MANAGED:'1',HG_DESKTOP_TOKEN:token},origin);
  let requests=0;
  const server=http.createServer(async(req,res)=>{
    requests++;access.sameOrigin(req);assert.equal(access.local(req),true);
    const body=await readJson(req);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({url:req.url,cookie:req.headers.cookie,range:req.headers.range,body}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const proxy=desktopProxy(`http://127.0.0.1:${server.address().port}`,token,fetch);
  const denied=[
    new Request('hongguotv://other/api/library'),
    new Request('hongguotv://app:9999/api/library'),
    new Request('https://app/api/library'),
    new Request('hongguotv://app/api/library',{headers:{Origin:'null'}}),
    new Request('hongguotv://app/api/library',{headers:{Origin:'https://other.example'}}),
    new Request('hongguotv://app/api/library',{headers:{'Sec-Fetch-Site':'cross-site'}}),
  ];
  for(const request of denied)assert.equal((await proxy(request)).status,403);
  assert.equal(requests,0);
  const response=await proxy(new Request('hongguotv://app/api/library/import?from=desktop',{method:'POST',headers:{Origin:'hongguotv://app',Host:'app','Content-Type':'application/json',Cookie:'hg_account_session=qa-session',Range:'bytes=0-15','X-Desktop-Token':'untrusted-renderer-value'},body:JSON.stringify({migrationId:'授权代理验收'})}));
  assert.deepEqual(await response.json(),{url:'/api/library/import?from=desktop',cookie:'hg_account_session=qa-session',range:'bytes=0-15',body:{migrationId:'授权代理验收'}});
  assert.equal(requests,1);
});

test('外部详情等待结束后重新读取登录和VIP，旧身份与草稿不能漏出', async t => {
  const f=fixture(t), directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-vip-current-'));let done;
  const provider={detail:()=>new Promise(resolve=>{done=resolve;})};
  const content=createContentService(directory,f.users,f.accounts,provider,{});
  t.after(async()=>{content.close();await fs.rm(directory,{recursive:true,force:true});});
  const series={id:'91',title:'授权回归真实接口记录',episodes:[1,2,3,4].map(number=>({id:String(100+number),number,title:`第${number}集`}))};
  const pending=content.resolveEpisode(f.request('/api/episodes/104/stream','GET',f.actors.member),'91','104');
  const denied=assert.rejects(pending,error=>error.status===403);await new Promise(resolve=>setImmediate(resolve));
  f.users.db.prepare('UPDATE account_subscriptions SET period_end=0 WHERE account_id=?').run(f.actors.member.user.id);done(series);await denied;
  const relogged=content.resolveEpisode(f.request('/api/episodes/104/stream','GET',f.actors.member),'91','104');f.users.logout(f.actors.member.token);await assert.rejects(relogged,error=>error.status===409);
  const draft=content.store.saveSeries(f.actors.admin.user,{title:'尚未上架资料',description:'',contentType:'real-drama',language:'en',categoryIds:['not-yet-public']});
  assert.deepEqual(content.store.categoryTags('real-drama',[]),[]);
  await assert.rejects(content.publicDetail(f.request(`/api/series/${draft.id}`,'GET',f.actors.viewer),draft.id),error=>error.status===404);
});

test('已经解析的VIP视频在发送前及传输期间复核，会员撤销后不能继续写出', async t => {
  const f=fixture(t),directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-stream-access-'));
  const provider={detail:async()=>({id:'91',title:'播放权限复核',episodes:[1,2,3,4].map(number=>({id:String(100+number),number,title:`第${number}集`}))})};
  const content=createContentService(directory,f.users,f.accounts,provider,{});
  t.after(async()=>{content.close();await fs.rm(directory,{recursive:true,force:true});});
  const req=f.request('/api/episodes/104/stream','GET',f.actors.member);
  await content.resolveEpisode(req,'91','104');assert.doesNotThrow(()=>req.revalidatePlayback(true));
  f.users.db.prepare('UPDATE account_subscriptions SET period_end=0 WHERE account_id=?').run(f.actors.member.user.id);
  assert.throws(()=>req.revalidatePlayback(true),error=>error.status===403 && error.message==='VIP_REQUIRED');
});

test('独立小尺寸HTTP流在会员失效后停止后续字节，同时释放源请求和流量预留', async t => {
  const f=fixture(t),directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-live-access-'));
  const provider={detail:async()=>({id:'91',title:'流权限回归',episodes:[1,2,3,4].map(number=>({id:String(100+number),number,title:`第${number}集`}))})};
  const content=createContentService(directory,f.users,f.accounts,provider,{}),budget=new TrafficBudget(':memory:',{CONTENT_DAILY_BYTES:64,CONTENT_VIEWER_DAILY_BYTES:64,CONTENT_IP_DAILY_BYTES:64}),guard=new PlaybackGuard({},budget);
  let continueStream,signal,response;
  const server=http.createServer(async(req,res)=>{
    await content.resolveEpisode(req,'91','104');signal=guard.acquire(req,res,'会员','地址');response=res;
    req.revalidatePlayback(true);res.setHeader('Content-Type','video/mp4');res.write(Buffer.from('1234'));
    continueStream=()=>{res.write(Buffer.from('5678'));if(!res.destroyed)res.end();};
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});content.close();budget.close();await fs.rm(directory,{recursive:true,force:true});});
  const received=await fetch(`http://127.0.0.1:${server.address().port}/video`,{headers:{Cookie:`hg_account_session=${f.actors.member.token}`}}),reader=received.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(),'1234');
  f.users.db.prepare('UPDATE account_subscriptions SET period_end=0 WHERE account_id=?').run(f.actors.member.user.id);
  // 只等正常的一秒复核周期，不向实际产品服务发送异常流量。
  await new Promise(resolve=>setTimeout(resolve,1100));
  const closed=once(response,'close');continueStream();await closed;
  await assert.rejects(reader.read());assert.equal(signal.aborted,true);assert.equal(guard.active,0);
  assert.equal(budget.db.prepare('SELECT bytes FROM traffic_budget WHERE identity=?').get('global').bytes,4);
});

test('真正HTTP入口拒绝未声明接口与后台读取，资料请求中的其他账户和角色字段不能提权', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-policy-http-'));
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_HOST:'127.0.0.1',PORT:'0',HG_DATA_DIR:directory,HG_ENV_FILE:path.join(directory,'absent.env'),APP_ORIGIN:origin,HG_MANAGED:'',HG_DESKTOP_TOKEN:'',ADMIN_ACCOUNT_IDS:'',ADMIN_EMAILS:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none'},stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await exit;}await fs.rm(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('权限回归服务启动超时')),10000);child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('权限回归服务提前退出'));});child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});});
  const base=`http://127.0.0.1:${port}`;
  const send=(route,body,cookie)=>fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(body!==undefined?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await send('/api/admin/accounts')).status,401);assert.equal((await send('/api/account/export')).status,404);assert.equal((await send('/api/rank/types',{})).status,405);
  const registered=await send('/api/auth/register',{email:'ordinary@example.invalid',name:'普通用户',password:'授权回归独立密码-2026',id:'任意管理员编号',role:'admin',emailVerified:true,membership:{active:true}}),cookie=registered.headers.get('set-cookie').split(';')[0],account=(await registered.json()).user;
  assert.equal(account.emailVerified,false);assert.equal(account.membership.active,false);
  assert.equal((await send('/api/admin/accounts',undefined,cookie)).status,403);
  const changed=await send('/api/account/profile',{accountId:'其他账户编号',name:'当前用户资料',role:'admin',membership:{active:true}},cookie);assert.equal(changed.status,200);
  const session=await(await send('/api/account/session',undefined,cookie)).json();assert.equal(session.user.id,account.id);assert.equal(session.user.name,'当前用户资料');assert.equal(session.capabilities.admin,false);assert.equal(session.user.membership.active,false);
});

test('密码校验期间密码版本改变，旧密码不能签发新登录会话', async t => {
  const users=new AccountStore(':memory:');t.after(()=>users.close());
  const oldPassword='密码版本回归旧密码-2026', hash=await passwordHash(oldPassword), replacement=await passwordHash('密码版本回归新密码-2026');
  const user=users.create({email:'password-race@example.test',name:'密码版本回归',hash}),previousSession=users.session(user.id);
  const original=users.byEmail.bind(users);
  users.byEmail=email=>{const found=original(email);if(found)users.resetPassword(found.id,replacement);return found;};
  const accounts=createAccountService(users,{APP_ORIGIN:origin});
  const input=Readable.from([Buffer.from(JSON.stringify({email:user.email,password:oldPassword}))]);input.headers={origin,'content-type':'application/json'};input.method='POST';input.url='/api/auth/login';input.socket={remoteAddress:'127.0.0.1'};
  let status,data;const res={writeHead(value){status=value;},setHeader(){},end(value){data=JSON.parse(value);}};
  assert.equal(await accounts.handle(input,res,new URL(input.url,origin)),true);
  assert.equal(status,401);assert.equal(data.error,'邮箱或密码不正确');assert.equal(users.viewer(previousSession),null);assert.equal(users.db.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count,0);
});
