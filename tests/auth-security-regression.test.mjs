import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {AccountStore,passwordHash} from '../server/account-store.mjs';

const origin='http://127.0.0.1:8793';
async function serverFixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-auth-security-'));
  const users=new AccountStore(path.join(directory,'accounts.sqlite'));
  users.create({email:'security-viewer@example.invalid',name:'安全回归观众',hash:await passwordHash('安全回归观众密码2026')});users.close();
  const web=path.join(directory,'web');await fs.mkdir(web);
  await fs.writeFile(path.join(web,'index.html'),'<!doctype html><title>真实安全回归页面</title>');
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_ENV_FILE:path.join(directory,'absent.env'),HG_DATA_DIR:directory,HG_WEB_DIR:web,HG_HOST:'127.0.0.1',PORT:'0',APP_ORIGIN:origin,HG_MANAGED:'',TRUSTED_PROXY_IPS:'',ADMIN_ACCOUNT_IDS:'',ADMIN_EMAILS:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none'},stdio:['ignore','ignore','pipe','ipc']});
  let diagnostics='';child.stderr.on('data',chunk=>{diagnostics+=chunk;});
  t.after(async()=>{
    if(child.exitCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await stopped;}
    await fs.rm(directory,{recursive:true,force:true});
  });
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('安全回归服务启动超时')),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error(diagnostics));});
    child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});
  });
  return `http://127.0.0.1:${port}`;
}

test('四个慢速正文不能阻断观众登录、注册和团队密码入口',async t=>{
  const base=await serverFixture(t),pending=[];
  try {
    for(const route of ['/api/auth/login','/api/auth/register','/api/auth/reset','/api/team/login']) {
      const req=http.request(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Content-Length':'100'}},res=>res.resume());
      req.on('error',()=>{});req.write('{');pending.push(req);
    }
    await new Promise(resolve=>setTimeout(resolve,100));
    const post=(route,input)=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
    const login=await post('/api/auth/login',{email:'security-viewer@example.invalid',password:'安全回归观众密码2026'});
    assert.equal(login.status,200);assert.equal((await login.json()).user.email,'security-viewer@example.invalid');
    const registration=await post('/api/auth/register',{email:'new-security-viewer@example.invalid',name:'新观众',password:'安全回归注册密码2026'});
    assert.equal(registration.status,200);await registration.json();
    const team=await post('/api/team/login',{code:'M-000000000000',password:'安全回归团队密码2026'});
    assert.equal(team.status,401);await team.json();
  } finally {for(const req of pending)req.destroy();}
});

test('恢复和验证页面在脚本加载前禁止来源及缓存，普通页面继续正常缓存',async t=>{
  const base=await serverFixture(t);
  for(const account of ['reset','verify'])for(const method of ['GET','HEAD']) {
    const response=await fetch(`${base}/?account=${account}&token=仅用于回归的旧邮件令牌`,{method});
    assert.equal(response.status,200);assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.equal(response.headers.get('cache-control'),'no-store');await response.text();
  }
  const normal=await fetch(base+'/');assert.equal(normal.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  assert.equal(normal.headers.get('cache-control'),'no-cache');await normal.text();
});

test('真实前端模块清除新旧邮件令牌，保留面板和播放参数且令牌限目的使用',async()=>{
  const require=createRequire(new URL('../apps/web-pc/package.json',import.meta.url)),ts=require('typescript');
  const source=await fs.readFile(new URL('../apps/web-pc/src/account-link.ts',import.meta.url),'utf8');
  const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  for(const purpose of ['reset','verify'])for(const fragment of [false,true]) {
    let href=`https://drama.example/?account=${purpose}&series=91&episode=101${fragment?'#token=':'&token='}独立回归令牌`;
    const exports={},environment={URL,URLSearchParams,exports,window:{location:{href},history:{replaceState(_state,_title,url){href=String(url);}}}};
    vm.runInNewContext(javascript,environment);
    const cleaned=new URL(href);assert.equal(cleaned.searchParams.has('token'),false);assert.equal(cleaned.hash,'');
    assert.equal(cleaned.searchParams.get('account'),purpose);assert.equal(cleaned.searchParams.get('series'),'91');assert.equal(cleaned.searchParams.get('episode'),'101');
    assert.equal(exports.accountLinkToken(purpose),'独立回归令牌');assert.equal(exports.accountLinkToken(purpose==='reset'?'verify':'reset'),null);
    exports.clearAccountLinkToken();assert.equal(exports.accountLinkToken(purpose),null);
  }
});
