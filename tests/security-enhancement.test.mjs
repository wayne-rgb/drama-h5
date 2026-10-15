import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {AccountStore,AccountError,passwordHash} from '../server/account-store.mjs';
import {AccountMfa,totp} from '../server/account-mfa.mjs';
import {createAccountService} from '../server/account-routes.mjs';
import {createApiPolicy} from '../server/api-policy.mjs';
import {PersonalStorage} from '../server/personal-storage.mjs';
import {TrafficBudget} from '../server/traffic-budget.mjs';
import {LibraryStore} from '../shared/library-store.mjs';
import {fork} from 'node:child_process';

test('个人资料新游客数量有界，旧数据超额仍可读取且不会删除记录',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-personal-bound-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const first=path.join(directory,'guests','00000000-0000-4000-8000-000000000001'),second=path.join(directory,'guests','00000000-0000-4000-8000-000000000002');
  const guard=new PersonalStorage(directory,{PERSONAL_MAX_GUESTS:1,PERSONAL_GUEST_PROFILE_BYTES:512*1024});guard.open(first,true);
  await fs.mkdir(first,{recursive:true});await fs.writeFile(path.join(first,'library.sqlite'),Buffer.alloc(600*1024));guard.refresh(first);
  assert.throws(()=>guard.open(second,true),error=>error.status===507);assert.doesNotThrow(()=>guard.open(first,true));assert.equal((await fs.stat(path.join(first,'library.sqlite'))).size,600*1024);
  assert.throws(()=>guard.attach({method:'POST',headers:{'content-length':'10'}},new EventEmitter(),first,true,[]),error=>error.status===507);
});

test('个人库写入预留只释放一次，SQLite页数硬上限阻止连续增长并保留原记录',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-personal-pages-')),location=path.join(directory,'guests','00000000-0000-4000-8000-000000000001');
  const guard=new PersonalStorage(directory,{PERSONAL_GUEST_PROFILE_BYTES:512*1024}),store=new LibraryStore(path.join(location,'library.sqlite'));
  t.after(async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});});
  guard.open(location,true);guard.refresh(location);const res=new EventEmitter();guard.attach({method:'POST',headers:{'content-length':'10'}},res,location,true,[store.db]);
  store.write({kind:'favorite',key:'1',op:'set',value:{id:'1',title:'保留的原始收藏'}});
  res.emit('finish');res.emit('close');assert.equal(guard.reserved,0);assert.equal(guard.guestReserved,0);
  let full=false;for(let index=2;index<12;index++){try{store.write({kind:'favorite',key:String(index),op:'set',value:{id:String(index),title:'容量回归',description:'实际描述'.repeat(4000),cover:'x'.repeat(8192),tags:'x'.repeat(8192)}});}catch(error){assert.equal(error.errcode,13);full=true;break;}}
  assert.equal(full,true);assert.equal(store.snapshot().favorites.some(row=>row.id==='1'),true);
  assert.ok(store.db.prepare('PRAGMA page_count').get().page_count<=store.db.prepare('PRAGMA max_page_count').get().max_page_count);
});

test('视频公共额度不能消耗会员保留额度，会员仍遵守同一总额且撤销后不能继续占用保留',()=>{
  const budget=new TrafficBudget(':memory:',{CONTENT_ENFORCE_DAILY_LIMITS:'1',CONTENT_DAILY_BYTES:100,CONTENT_VIEWER_DAILY_BYTES:100,CONTENT_IP_DAILY_BYTES:100,CONTENT_VIP_RESERVED_BYTES:20});
  try{const publicMeter=budget.meter('游客','甲');publicMeter.consume(80);publicMeter.close();assert.throws(()=>budget.check('其他游客','乙'),error=>error.status===429);
    const member=budget.meter('会员','会员地址',true);member.consume(10);member.close();assert.equal(budget.db.prepare('SELECT bytes FROM traffic_budget WHERE identity=?').get('global').bytes,90);
    const revoked=budget.meter('撤销会员','丙',true);revoked.setPrivileged(false);assert.throws(()=>revoked.consume(1),error=>error.status===429);revoked.close();
    const last=budget.meter('会员','会员地址',true);last.consume(10);last.close();assert.throws(()=>budget.check('会员','会员地址',true),error=>error.status===429);
  }finally{budget.close();}
});

test('旧流量账本已消耗的字节同样计入会员保留边界',()=>{
  const budget=new TrafficBudget(':memory:',{CONTENT_ENFORCE_DAILY_LIMITS:'1',CONTENT_DAILY_BYTES:100,CONTENT_VIEWER_DAILY_BYTES:100,CONTENT_IP_DAILY_BYTES:100,CONTENT_VIP_RESERVED_BYTES:20});
  try{budget.db.prepare('INSERT INTO traffic_budget VALUES(?,?,?)').run(budget.currentDay(),'global',80);assert.throws(()=>budget.check('游客','地址'),error=>error.status===429);assert.doesNotThrow(()=>budget.check('会员','地址',true));}finally{budget.close();}
});

test('TOTP按RFC6238标准向量生成六位动态码',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret,1),'287082');assert.equal(totp(secret,Math.floor(1111111109/30)),'081804');assert.equal(totp(secret,Math.floor(2000000000/30)),'279037');
});

test('管理员启用验证器撤销旧会话，未完成验证不能调用后台，动态码和恢复码均不可重复使用',async t=>{
  const store=new AccountStore(':memory:');t.after(()=>store.close());const password='管理员独立回归密码-2026',user=store.create({email:'mfa@example.test',name:'验证器回归',hash:await passwordHash(password)});
  const old=store.session(user.id),actor=store.viewer(old),mfa=new AccountMfa(store),setup=await mfa.setup(actor,password),counter=Math.floor(Date.now()/30000);
  const recovery=mfa.enable(actor,setup.token,totp(setup.secret,counter-1));assert.equal(store.viewer(old),null);assert.equal(recovery.length,10);
  assert.equal(store.db.prepare('SELECT secret FROM account_mfa').get().secret.includes(setup.secret),false);assert.equal(store.db.prepare('SELECT recovery FROM account_mfa').get().recovery.includes(recovery[0]),false);
  const token=store.session(user.id),config={APP_ORIGIN:'http://127.0.0.1:8793',ADMIN_ACCOUNT_IDS:user.id},accounts=createAccountService(store,config),policy=createApiPolicy(accounts,store,config);
  const req={method:'GET',url:'/api/admin/accounts',headers:{origin:config.APP_ORIGIN,cookie:`hg_account_session=${token}`},socket:{remoteAddress:'127.0.0.1'}};
  assert.throws(()=>policy(req,{setHeader(){}},new URL(req.url,config.APP_ORIGIN)),error=>error.status===403);
  assert.throws(()=>accounts.requireSecurityViewer(req),error=>error.status===403);
  for(const route of ['/api/account/sessions/revoke','/api/billing/checkout','/api/billing/portal','/api/billing/confirm']){req.method='POST';assert.throws(()=>policy(req,{setHeader(){}},new URL(route,config.APP_ORIGIN)),error=>error.status===403);}
  req.method='GET';
  mfa.verify(store.viewer(token),totp(setup.secret,counter));assert.throws(()=>mfa.verify(store.viewer(token),totp(setup.secret,counter)),error=>error.status===400);
  mfa.verify(store.viewer(token),recovery[0]);assert.throws(()=>mfa.verify(store.viewer(token),recovery[0]),error=>error.status===400);
  const verified=store.session(user.id,{mfa:true});req.headers.cookie=`hg_account_session=${verified}`;assert.doesNotThrow(()=>policy(req,{setHeader(){}},new URL(req.url,config.APP_ORIGIN)));
  await assert.rejects(mfa.setup(store.viewer(token),password),error=>error.status===403);
});

test('真实HTTP首次只读个人资料不创建游客文件，首次收藏写入后持久化且响应带脚本保护',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-lazy-library-'));
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_DATA_DIR:directory,HG_ENV_FILE:path.join(directory,'absent.env'),HG_HOST:'127.0.0.1',PORT:'0',APP_ORIGIN:'http://127.0.0.1:8793',HG_MANAGED:'',ADMIN_ACCOUNT_IDS:'',ADMIN_EMAILS:'',ADMIN_REQUIRE_MFA:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none'},stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null){const finished=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await finished;}await fs.rm(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离资料服务启动超时')),10000);child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});child.once('error',error=>{clearTimeout(timer);reject(error);});});
  const base=`http://127.0.0.1:${port}`,initial=await fetch(base+'/api/account/session'),session=await initial.json(),cookie=initial.headers.get('set-cookie').split(';')[0];
  const headers={Origin:'http://127.0.0.1:8793',Cookie:cookie,'X-Library-Owner':session.libraryOwner,'Content-Type':'application/json'};
  const first=await fetch(base+'/api/library',{headers});assert.equal(first.status,200);assert.equal((await first.json()).favorites.length,0);
  assert.ok(first.headers.get('content-security-policy').includes("script-src 'self'"));await assert.rejects(fs.stat(path.join(directory,'guests')),error=>error.code==='ENOENT');
  const saved=await fetch(base+'/api/library/operations',{method:'POST',headers,body:JSON.stringify({kind:'favorite',key:'91',op:'set',value:{id:'91',title:'真实个人库回归收藏'}})});assert.equal(saved.status,200);await saved.json();
  assert.equal((await fs.readdir(path.join(directory,'guests'))).length,1);
  const read=await(await fetch(base+'/api/library',{headers})).json();assert.equal(read.favorites[0].title,'真实个人库回归收藏');
});

test('登录设备接口仅返回并撤销当前账户的会话，不能撤销别人的会话',async t=>{
  const store=new AccountStore(':memory:');t.after(()=>store.close());const owner=store.create({email:'device@example.test',name:'设备回归'}),other=store.create({email:'other@example.test',name:'其他账户'}),current=store.session(owner.id,{device:'当前回归设备'}),second=store.session(owner.id,{device:'第二回归设备'}),foreign=store.session(other.id);
  const config={APP_ORIGIN:'http://127.0.0.1:8793'},accounts=createAccountService(store,config),policy=createApiPolicy(accounts,store,config);
  const server=http.createServer(async(req,res)=>{const url=new URL(req.url,config.APP_ORIGIN);try{policy(req,res,url);await accounts.handle(req,res,url);}catch(error){res.writeHead(error.status);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const headers={Cookie:`hg_account_session=${current}`,Origin:config.APP_ORIGIN,'Content-Type':'application/json'},base=`http://127.0.0.1:${server.address().port}`;
  const list=await(await fetch(base+'/api/account/sessions',{headers})).json();assert.equal(list.items.length,2);assert.equal(list.items.some(row=>row.device==='第二回归设备'),true);
  const foreignId=store.db.prepare('SELECT token_hash FROM account_sessions WHERE account_id=?').get(other.id).token_hash;
  assert.equal((await fetch(base+'/api/account/sessions/revoke',{method:'POST',headers,body:JSON.stringify({id:foreignId})})).status,200);assert.ok(store.viewer(foreign));
  assert.equal((await fetch(base+'/api/account/sessions/revoke',{method:'POST',headers,body:JSON.stringify({others:true})})).status,200);assert.equal(store.viewer(second),null);assert.ok(store.viewer(current));
});

test('密码重置撤销未完成的验证器绑定候选及旧会话',async t=>{
  const store=new AccountStore(':memory:');t.after(()=>store.close());const password='未完成绑定回归密码-2026',user=store.create({email:'pending-mfa@example.test',name:'未完成绑定回归',hash:await passwordHash(password)}),token=store.session(user.id),actor=store.viewer(token),mfa=new AccountMfa(store),setup=await mfa.setup(actor,password);
  store.resetPassword(user.id,await passwordHash('更新后的绑定回归密码-2026'));assert.equal(store.viewer(token),null);assert.throws(()=>mfa.enable(actor,setup.token,totp(setup.secret)),error=>error.status===400);
});
