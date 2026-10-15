import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fork} from 'node:child_process';
import {LibraryStore} from '../shared/library-store.mjs';
import {HistoryStore} from '../server/history-store.mjs';
import {AccountStore} from '../server/account-store.mjs';
import {AccountMfa,totp} from '../server/account-mfa.mjs';
import {ContentStore} from '../server/content-store.mjs';

const favorite = id => ({kind:'favorite',key:id,op:'set',at:1,value:{id,title:`迁移收藏${id}`}});

test('迁移按批次原子提交，失败不留下部分资料，重复及乱序请求不改变已保存结果',t=>{
  const store=new LibraryStore(':memory:');t.after(()=>store.close());
  assert.throws(()=>store.importOperations({migrationId:'回归',total:3,operations:[favorite('1'),{kind:'invalid'}]}),error=>error.status===400);
  assert.equal(store.snapshot().favorites.length,0);assert.equal(store.getMeta('sequence'),null);assert.equal(store.getMeta('migration-progress:回归'),null);
  const first={migrationId:'回归',total:3,operations:[favorite('1'),favorite('2')]};
  assert.deepEqual(store.importOperations(first),{ok:true,next:2,complete:false});
  assert.deepEqual(store.importOperations(first),{ok:true,next:2,complete:false});
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM library_events').get().count,2);
  assert.throws(()=>store.importOperations({...first,operations:[{...favorite('1'),value:{id:'1',title:'改变原始批次'}},favorite('2')]}),error=>error.status===409);
  assert.throws(()=>store.importOperations({...first,total:4,offset:3,operations:[favorite('4')]}),error=>error.status===409);
  assert.deepEqual(store.importOperations({migrationId:'回归',total:3,offset:2,operations:[favorite('3')]}),{ok:true,next:3,complete:true});
  assert.equal(store.snapshot().favorites.length,3);assert.equal(store.getMeta('migration:回归'),true);
  assert.equal(store.importOperations(first).complete,true);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM library_events').get().count,3);
});

test('单批导入有上限，大资料可以连续迁移，空迁移和旧操作编号重试保持兼容',t=>{
  const store=new LibraryStore(':memory:');t.after(()=>store.close());
  const operations=Array.from({length:257},(_,index)=>favorite(String(index)));
  assert.throws(()=>store.importOperations({migrationId:'有界',operations}),error=>error.status===400);
  assert.equal(store.snapshot().favorites.length,0);
  store.importOperations({migrationId:'有界',total:257,operations:operations.slice(0,256)});
  store.importOperations({migrationId:'有界',total:257,offset:256,operations:operations.slice(256)});
  assert.equal(store.snapshot().favorites.length,257);
  store.write({...favorite('旧记录'),id:'migration:旧版:0'});
  store.importOperations({migrationId:'旧版',operations:[favorite('旧记录')]});
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM library_events WHERE item_key=?').get('旧记录').count,1);
  assert.deepEqual(store.importOperations({migrationId:'空迁移',operations:[]}),{ok:true,next:0,complete:true});
});

test('观看历史导入拒绝超大批次，已保存的记录仍能读取',t=>{
  const store=new HistoryStore(':memory:');t.after(()=>store.close());
  const item={seriesId:'91',title:'观看记录回归',episodeId:'101',episodeNumber:1,positionMs:1000,durationMs:2000,updatedAt:1};
  store.importLegacy({clientId:'设备',source:'web',items:[item]});
  assert.throws(()=>store.importLegacy({clientId:'设备',source:'web',items:Array(257).fill(item)}),error=>error.status===400);
  assert.equal(store.list().length,1);assert.equal(store.list()[0].positionMs,1000);
});

test('MFA密钥丢失或不匹配时恢复码仍独立可用，不能复用，也不能静默生成新密钥',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-mfa-recovery-')),store=new AccountStore(path.join(directory,'accounts.sqlite'));
  t.after(async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});});
  const user=store.create({email:'recovery@example.test',name:'恢复码回归'}),actor=store.viewer(store.session(user.id)),mfa=new AccountMfa(store);
  const setup=await mfa.setup(actor),recovery=mfa.enable(actor,setup.token,totp(setup.secret,Math.floor(Date.now()/30000)-1));
  const file=path.join(directory,'.mfa-key'),key=await fs.readFile(file);await fs.unlink(file);
  assert.doesNotThrow(()=>mfa.verify(actor,recovery[0]));assert.throws(()=>mfa.verify(actor,recovery[0]),error=>error.status===400);
  assert.throws(()=>mfa.verify(actor,totp(setup.secret)),error=>error.status===503);
  await assert.rejects(fs.stat(file),error=>error.code==='ENOENT');
  const wrongKey=new AccountMfa(store,{ACCOUNT_MFA_KEY:crypto.randomBytes(32).toString('hex')});
  assert.doesNotThrow(()=>wrongKey.verify(actor,recovery[1]));assert.throws(()=>wrongKey.verify(actor,totp(setup.secret)),error=>error.status===503);
  await fs.writeFile(file,key,{mode:0o600});assert.doesNotThrow(()=>mfa.verify(actor,totp(setup.secret)));
});

test('点赞保留但下架后的草稿与管理员预览元数据都不对观众返回，重新发布后可用',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-draft-likes-')),store=new ContentStore(directory);
  t.after(async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});});
  store.db.prepare('INSERT INTO content_series(id,title,description,tags,content_type,language,status,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('91','已公开剧名','已公开简介','','real-drama','en','published',1);
  store.db.prepare('INSERT INTO content_episodes VALUES(?,?,?,?,?)').run('101','91',1,'第一集','测试素材');
  store.rememberLikedEpisode(store.detail('91'),{id:'101',number:1});store.db.prepare('INSERT INTO episode_likes VALUES(?,?,?)').run('101','观众',1);
  assert.equal(store.likedEpisodes('观众').items[0].available,true);
  store.db.prepare("UPDATE content_series SET status='draft',title=?,description=? WHERE id='91'").run('尚未公开的新剧名','尚未公开的新简介');
  store.rememberLikedEpisode(store.detail('91',true),{id:'101',number:1});
  const unavailable=store.likedEpisodes('观众');assert.equal(unavailable.count,1);assert.equal(unavailable.items[0].series,null);assert.equal(unavailable.items[0].available,false);assert.equal(JSON.stringify(unavailable).includes('尚未公开'),false);
  store.db.prepare("UPDATE content_series SET status='published' WHERE id='91'").run();assert.equal(store.likedEpisodes('观众').items[0].series.title,'尚未公开的新剧名');
});

test('真实公开封面响应与视频共用流量预算，HEAD和缓存验证不扣字节，下架后缓存也不能绕过权限',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-cover-budget-')),store=new ContentStore(directory),id=crypto.randomUUID();
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg==','base64');
  await fs.mkdir(path.join(directory,'media'),{recursive:true});await fs.writeFile(path.join(directory,'media',id),image);
  store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,offset,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'管理员','封面.png','image','image/png',image.length,image.length,'ready',1);
  store.db.prepare('INSERT INTO content_series(id,title,description,tags,content_type,language,cover_id,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('91','封面回归','','','real-drama','en',id,'published',1);
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{env:{...process.env,HG_ENV_FILE:path.join(directory,'absent.env'),HG_DATA_DIR:directory,HG_HOST:'127.0.0.1',PORT:'0',APP_ORIGIN:'http://127.0.0.1:8793',HG_MANAGED:'',ADMIN_ACCOUNT_IDS:'',ADMIN_EMAILS:'',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',SMTP_HOST:'',BILLING_PROVIDER:'none',CONTENT_ENFORCE_DAILY_LIMITS:'1',CONTENT_DAILY_BYTES:String(image.length),CONTENT_VIEWER_DAILY_BYTES:String(image.length),CONTENT_IP_DAILY_BYTES:String(image.length),CONTENT_VIP_RESERVED_BYTES:'0'},stdio:['ignore','ignore','ignore','ipc']});
  t.after(async()=>{if(child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.send({type:'shutdown'});await done;}store.close();await fs.rm(directory,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('封面隔离服务启动超时')),10000);child.once('error',reject);child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.port);}});});
  const base=`http://127.0.0.1:${port}`,url=`${base}/api/content/covers/${id}`;
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),image.length);
  const first=await fetch(url);assert.equal(first.status,200);assert.deepEqual(Buffer.from(await first.arrayBuffer()),image);assert.ok(first.headers.get('cache-control').includes('max-age=300'));
  const etag=first.headers.get('etag'),cached=await fetch(url,{headers:{'If-None-Match':etag}});assert.equal(cached.status,304);assert.equal((await cached.arrayBuffer()).byteLength,0);
  assert.equal((await fetch(url)).status,429);assert.equal((await fetch(url,{method:'HEAD'})).status,200);
  assert.equal((await fetch(`${base}/api/episodes/101/stream?seriesId=91`)).status,429);
  store.db.prepare("UPDATE content_series SET status='draft' WHERE id='91'").run();assert.equal((await fetch(url,{headers:{'If-None-Match':etag}})).status,404);
});
