import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ContentStore } from '../server/content-store.mjs';
import { CommentModeration } from '../server/comment-moderation.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-moderation-'));
  const store=new ContentStore(directory);
  t.after(async()=>{store.close();await fs.rm(directory,{recursive:true,force:true});});
  const save=title=>store.saveSeries({id:'测试管理员'},{title,contentType:'real-drama',language:'zh-CN'});
  const comment=(seriesId,episodeId,index)=>{const id=crypto.randomUUID();store.db.prepare('INSERT INTO episode_comments VALUES(?,?,?,?,?,?,?)').run(id,episodeId,seriesId,'测试观众',`评论${index}`,'visible',1000);return id;};
  return {store,save,comment};
}

test('评论分页稳定、举报优先、同剧同集筛选不泄漏其他内容',async t=>{
  const {store,save,comment}=await fixture(t),first=save('第一部真实存储剧'),second=save('第二部真实存储剧');
  const moderation=new CommentModeration(store,async id=>store.detail(id,true));
  moderation.remember({...first,episodes:[{id:'101',number:1,title:'开场'},{id:'102',number:2,title:'后续'}]});
  for(let index=0;index<101;index++)comment(first.id,'101',index);
  const reported=comment(first.id,'102','被举报');
  store.db.prepare('INSERT INTO comment_reports VALUES(?,?,?)').run(reported,'举报观众',1001);
  comment(second.id,'201','另一部剧');
  const all=await moderation.comments(new URLSearchParams({seriesId:first.id}));
  assert.equal(all.items.length,100);assert.equal(all.hasMore,true);assert.equal(all.items[0].id,reported);assert.equal(all.items[0].episodeNumber,2);
  const page1=await moderation.comments(new URLSearchParams({seriesId:first.id,episodeId:'101'}));
  const page2=await moderation.comments(new URLSearchParams({seriesId:first.id,episodeId:'101',page:'2'}));
  assert.equal(page1.items.length,100);assert.equal(page2.items.length,1);assert.equal(page2.hasMore,false);
  assert.equal(new Set([...page1.items,...page2.items].map(row=>row.id)).size,101);
  assert.ok(page1.items.every(row=>row.episodeNumber===1&&row.seriesTitle===first.title));
  await assert.rejects(moderation.comments(new URLSearchParams({seriesId:first.id,episodeId:'201'})),error=>error.status===404);
  const roots=await moderation.series(new URLSearchParams());assert.equal(roots.items[0].id,first.id);assert.equal(roots.items[0].comments,102);assert.equal(roots.items[0].reports,1);
  const search=await moderation.series(new URLSearchParams({q:'第二部'}));assert.equal(search.items.length,1);assert.equal(search.items[0].id,second.id);
  for(const page of ['0','-1','1.5','bad','1001'])await assert.rejects(moderation.comments(new URLSearchParams({seriesId:first.id,page})),error=>error.status===400);
});

test('外部真实元数据保存后，内容源故障仍能审核历史评论并保留名称集数',async t=>{
  const {store,comment}=await fixture(t);
  const source={id:'301',title:'来源返回的剧名',episodes:[{id:'302',number:1,title:'第一集'},{id:'303',number:2,title:'第二集'}]};
  let available=true;
  const moderation=new CommentModeration(store,async()=>{if(!available)throw Error('内容源不可用');return source;});
  comment('301','302',1);
  const roots=await moderation.series(new URLSearchParams());assert.equal(roots.items[0].title,source.title);
  const report=await moderation.comments(new URLSearchParams({seriesId:'301'}));assert.equal(report.episodes.length,2);assert.ok(report.episodes.every(row=>!row.removed));
  available=false;
  const history=await moderation.comments(new URLSearchParams({seriesId:'301'}));assert.equal(history.items[0].seriesTitle,source.title);assert.equal(history.items[0].episodeNumber,1);assert.equal(history.episodes[0].removed,false);
  comment('401','402',2);
  const unknown=await moderation.comments(new URLSearchParams({seriesId:'401'}));assert.equal(unknown.series.title,null);assert.equal(unknown.items[0].episodeNumber,null);assert.equal(unknown.items.length,1);
});

test('旧点赞元数据恢复历史评论，剧名搜索和剧列表超过一页可继续查看',async t=>{
  const {store,save,comment}=await fixture(t);
  store.db.prepare('INSERT INTO liked_episode_content VALUES(?,?,?)').run('502','501',JSON.stringify({title:'旧记录中的真实剧名',episodeNumber:6}));
  comment('501','502',1);
  const moderation=new CommentModeration(store,async id=>{const row=store.detail(id,true);if(!row)throw Error('来源已不可用');return row;});
  const history=await moderation.comments(new URLSearchParams({seriesId:'501'}));assert.equal(history.items[0].seriesTitle,'旧记录中的真实剧名');assert.equal(history.items[0].episodeNumber,6);
  for(let index=0;index<25;index++)save(`分页短剧${index}`);
  const first=await moderation.series(new URLSearchParams({q:'分页短剧'})),second=await moderation.series(new URLSearchParams({q:'分页短剧',page:'2'}));
  assert.equal(first.items.length,24);assert.equal(first.hasMore,true);assert.equal(second.items.length,1);assert.equal(second.hasMore,false);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,25);
});
