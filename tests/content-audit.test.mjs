import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ContentStore } from '../server/content-store.mjs';
import { AccountStore } from '../server/account-store.mjs';
import { ContentAudit, initializeAuditContext } from '../server/content-audit.mjs';
import { ContentAnalytics } from '../server/content-analytics.mjs';
import { CommentModeration } from '../server/comment-moderation.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-content-audit-')),store=new ContentStore(directory),accounts=new AccountStore(':memory:');
  const admin=accounts.create({email:'audit-admin@example.invalid',name:'审计管理员'});
  const audit=new ContentAudit(store,accounts);
  t.after(async()=>{store.close();accounts.close();await fs.rm(directory,{recursive:true,force:true});});
  const series=title=>store.saveSeries(admin,{title,contentType:'real-drama',language:'zh-CN'});
  const asset=(seriesId=null,number=null)=>{
    const id=crypto.randomUUID();store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at,series_id,episode_number) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,admin.id,'真实存储的文件名.mp4','video','video/mp4',100,'ready',JSON.stringify({duration:12}),Date.now(),seriesId,number);return id;
  };
  return {store,accounts,admin,audit,series,asset};
}

test('内容记录按剧集隔离，同一视频关联多集时保留真实关联且不重复计数',async t=>{
  const f=await fixture(t),first=f.series('第一部剧'),second=f.series('第二部剧'),asset=f.asset(first.id,1);
  f.store.audit(f.admin,'完成文件上传',asset,{name:'真实存储的文件名.mp4',kind:'video'});
  let detail=f.store.saveEpisode(f.admin,first.id,{number:1,title:'初见',assetId:asset});
  detail=f.store.saveEpisode(f.admin,first.id,{number:2,title:'离别',assetId:asset});
  const other=f.store.saveEpisode(f.admin,second.id,{number:1,title:'另一部剧的开场',assetId:f.asset()});
  const logs=f.audit.logs(new URLSearchParams({seriesId:first.id,episodeId:detail.episodes[1].id}));
  assert.equal(logs.items.length,2);assert.ok(logs.items.every(row=>row.targets.every(target=>target.seriesTitle===first.title&&target.number===2)));
  assert.equal(logs.items.find(row=>row.action==='完成文件上传').filename,asset);
  const roots=f.audit.series(new URLSearchParams());assert.equal(roots.items.find(row=>row.id===first.id).count,4);
  assert.throws(()=>f.audit.logs(new URLSearchParams({seriesId:first.id,episodeId:other.episodes[0].id})),error=>error.status===404);
  for(const row of logs.items){assert.equal(row.actorName,null);assert.equal(row.actorEmail,null);assert.equal(row.target_id,undefined);assert.equal(row.admin_id,undefined);assert.equal(row.detail,undefined);}
});

test('移除后的历史集在审计、评论和分析中使用最后确认的集数，旧操作保留当时编号',async t=>{
  const f=await fixture(t),first=f.series('分集历史剧'),asset=f.asset();
  const analytics=new ContentAnalytics(f.store,f.accounts,{requireViewer:()=>f.admin},()=>true);
  const comments=new CommentModeration(f.store,async id=>f.store.detail(id,true));
  let detail=f.store.saveEpisode(f.admin,first.id,{number:1,title:'初见',assetId:asset});analytics.rememberVersion(detail.episodes[0].id);
  detail=f.store.saveEpisode(f.admin,first.id,{number:2,title:'离别',assetId:asset});analytics.rememberVersion(detail.episodes[1].id);
  const removed=detail.episodes[0],commentId=crypto.randomUUID();comments.remember(detail);
  f.store.db.prepare('INSERT INTO episode_comments VALUES(?,?,?,?,?,?,?)').run(commentId,removed.id,first.id,f.admin.id,'保存的评论','hidden',Date.now());
  f.store.reorder(f.admin,first.id,detail.episodes.map(row=>row.id).reverse());
  f.store.audit(f.admin,'处理评论',commentId,{status:'hidden'});
  f.store.removeEpisode(f.admin,first.id,removed.id);
  const report=f.audit.logs(new URLSearchParams({seriesId:first.id,episodeId:removed.id}));
  assert.equal(report.episodes.find(row=>row.id===removed.id).number,2);assert.equal(report.episodes.find(row=>row.id===removed.id).removed,true);
  assert.equal(report.items.find(row=>row.action==='处理评论').targets[0].number,2);
  assert.equal(report.items.find(row=>row.action==='移除分集').targets[0].number,2);
  assert.equal(report.items.find(row=>row.action==='保存分集').targets[0].number,1);
  assert.deepEqual(report.items.find(row=>row.action==='调整分集顺序').order.map(row=>row.title),['离别','初见']);
  const commentReport=await comments.comments(new URLSearchParams({seriesId:first.id}));assert.equal(commentReport.items[0].episodeNumber,2);
  const analysis=analytics.report({},new URLSearchParams({seriesId:first.id}));assert.equal(analysis.episodeGroups.find(row=>row.episodeId===removed.id).number,2);
  assert.equal(analysis.episodeGroups.find(row=>row.episodeId===removed.id).title,'初见');assert.equal(analysis.summary.plays,0);
});

test('迁移旧日志时同毫秒排序不引用后续操作，已移除内容仍保留真实名称',async t=>{
  const f=await fixture(t),first=f.series('操作时的剧名'),asset=f.asset();
  let detail=f.store.saveEpisode(f.admin,first.id,{number:1,title:'最初开场',assetId:asset});
  detail=f.store.saveEpisode(f.admin,first.id,{number:2,title:'第二集',assetId:asset});
  const removed=detail.episodes[0],commentId=crypto.randomUUID();
  f.store.db.prepare('INSERT INTO episode_comments VALUES(?,?,?,?,?,?,?)').run(commentId,removed.id,first.id,f.admin.id,'历史评论','visible',1000);
  f.store.audit(f.admin,'处理评论',commentId,{status:'visible'});
  f.store.reorder(f.admin,first.id,detail.episodes.map(row=>row.id).reverse());
  f.store.audit(f.admin,'处理评论',commentId,{status:'hidden'});
  f.store.removeEpisode(f.admin,first.id,removed.id);
  f.store.saveSeries(f.admin,{title:'后来编辑的剧名',contentType:'real-drama',language:'zh-CN'},first.id);
  for(const row of f.store.db.prepare('SELECT * FROM content_audit').all()) {
    const raw=JSON.parse(row.detail);delete raw.adminName;delete raw.adminEmail;delete raw.seriesTitle;delete raw.episodeTitle;delete raw.order;
    if(row.action==='移除分集')delete raw.number;
    f.store.db.prepare('UPDATE content_audit SET detail=?,created_at=1000 WHERE id=?').run(JSON.stringify(raw),row.id);
  }
  f.store.db.exec('DROP TABLE content_audit_refs');initializeAuditContext(f.store);
  const history=f.audit.logs(new URLSearchParams({seriesId:first.id,episodeId:removed.id})),moderation=history.items.filter(row=>row.action==='处理评论');
  assert.equal(moderation.find(row=>row.status==='visible').targets[0].number,1);
  assert.equal(moderation.find(row=>row.status==='hidden').targets[0].number,2);
  assert.ok(moderation.every(row=>row.targets[0].seriesTitle==='操作时的剧名'));
  assert.equal(history.episodes.find(row=>row.id===removed.id).number,2);
  assert.equal(history.series.title,'后来编辑的剧名');
});

test('未关联记录与观众操作分别保留，操作者不回查观众姓名与邮箱',async t=>{
  const f=await fixture(t),account=f.accounts.create({email:'viewer@example.invalid',name:'操作时的观众'}),asset=f.asset();
  f.store.audit(f.admin,'完成文件上传',asset,{name:'未关联上传.mp4',kind:'video'});
  f.store.audit(f.admin,'开通手动会员',account.id,{accountName:account.name,accountEmail:account.email,periodEnd:Date.now()+86400000,reason:'真实填写的操作原因',privateValue:'禁止展示的内部字段'});
  f.accounts.db.prepare('UPDATE accounts SET name=? WHERE id=?').run('后来改名的管理员',f.admin.id);
  const platform=f.audit.logs(new URLSearchParams({scope:'platform'}));assert.equal(platform.items.length,1);assert.equal(platform.items[0].actorName,null);assert.equal(platform.items[0].actorEmail,null);assert.equal(platform.items[0].accountName,'操作时的观众');assert.equal(platform.items[0].reason,'真实填写的操作原因');assert.equal(JSON.stringify(platform).includes('禁止展示的内部字段'),false);
  const unassigned=f.audit.logs(new URLSearchParams({unassigned:'1'}));assert.equal(unassigned.items.length,1);assert.equal(unassigned.items[0].targets.length,0);assert.equal(unassigned.items[0].filename,asset);assert.equal(f.audit.series(new URLSearchParams()).unassigned,1);
  for(const params of [{},{scope:'platform',seriesId:'1'},{seriesId:'bad'},{seriesId:'1',page:'bad'}])assert.throws(()=>f.audit.logs(new URLSearchParams(params)),error=>error.status===400);
});

test('审计分页超过一页可继续查看，同时间记录不重复也不遗漏',async t=>{
  const f=await fixture(t),series=f.series('分页短剧');
  for(let index=0;index<101;index++)f.store.audit(f.admin,'发布短剧',series.id);
  f.store.db.prepare('UPDATE content_audit SET created_at=1000').run();
  const first=f.audit.logs(new URLSearchParams({seriesId:series.id})),second=f.audit.logs(new URLSearchParams({seriesId:series.id,page:'2'}));
  assert.equal(first.items.length,100);assert.equal(second.items.length,2);assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,102);
  for(let index=0;index<25;index++)f.series(`新剧${index}`);
  const roots=f.audit.series(new URLSearchParams({q:'新剧'})),more=f.audit.series(new URLSearchParams({q:'新剧',page:'2'}));assert.equal(roots.items.length,24);assert.equal(roots.hasMore,true);assert.equal(more.items.length,1);assert.equal(more.hasMore,false);
});
