import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccountStore } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { ContentStore } from '../server/content-store.mjs';
import { ContentAnalytics, mergeRanges } from '../server/content-analytics.mjs';
import { PlaybackAnalytics } from '../apps/web-pc/src/content-analytics.mjs';

function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'drama-analytics-'));
  const users=new AccountStore(path.join(directory,'accounts.sqlite')), content=new ContentStore(directory);
  const admin=users.create({email:'admin@example.test',name:'管理员',verified:true});
  const creator=users.create({email:'creator@example.test',name:'创作者',verified:true});
  const other=users.create({email:'other@example.test',name:'其他创作者',verified:true});
  const viewer=users.create({email:'viewer@example.test',name:'观众',verified:true});
  const config={APP_ORIGIN:'http://127.0.0.1:8791',ADMIN_ACCOUNT_IDS:admin.id};
  const accounts=createAccountService(users,config);
  const request=user=>({headers:{cookie:`hg_account_session=${users.session(user.id)}`},socket:{remoteAddress:'127.0.0.1'}});
  const requests={admin:request(admin),creator:request(creator),other:request(other),viewer:request(viewer)};
  for(const user of [creator,other])users.db.prepare('INSERT INTO account_creators VALUES(?,?,?)').run(user.id,admin.id,Date.now());
  let now=Date.parse('2026-10-14T12:00:00Z');
  for(const [id,owner] of [['91',creator.id],['92',other.id]])content.db.prepare("INSERT INTO content_series(id,title,description,tags,content_type,language,status,updated_at,creator_id) VALUES(?,?,'','','real-drama','en','published',?,?)").run(id,`短剧${id}`,now,owner);
  for(const asset of ['original','replacement'])content.db.prepare("INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at) VALUES(?,?,?,'video','video/mp4',100,'ready',?,?)").run(asset,admin.id,asset,JSON.stringify({duration:10,width:240,height:426}),now);
  for(let number=1;number<=4;number++)content.db.prepare('INSERT INTO content_episodes VALUES(?,?,?,?,?)').run(String(100+number),'91',number,`第${number}集`,'original');
  content.db.prepare('INSERT INTO content_episodes VALUES(?,?,?,?,?)').run('201','92',1,'其他作品第1集','original');
  const analytics=new ContentAnalytics(content,users,accounts,user=>user?.id===admin.id,()=>now);
  const start=(req=requests.viewer,episodeId='101',seriesId='91',requestId=crypto.randomUUID())=>analytics.start(req,{requestId,seriesId,episodeId,entry:'detail'});
  const progress=(session,watchMs,ranges,sequence=1,errors=0,req=requests.viewer)=>analytics.progress(req,{id:session.id,watchMs,ranges,sequence,errors});
  const report=(req=requests.admin,params={seriesId:'91'})=>analytics.report(req,new URLSearchParams(params));
  const advance=value=>{now+=value;};
  t.after(()=>{content.close();users.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {users,content,analytics,requests,creator,other,admin,viewer,start,progress,report,advance};
}

test('分析权限：管理员看全部，创作者归属隔离且撤销权限立即生效',t=>{
  const f=fixture(t);
  assert.equal(f.analytics.series(f.requests.admin).items.length,2);
  assert.deepEqual(f.analytics.series(f.requests.creator).items.map(row=>row.id),['91']);
  assert.throws(()=>f.report(f.requests.creator,{seriesId:'92'}),error=>error.status===404);
  assert.throws(()=>f.report(f.requests.viewer),error=>error.status===403);
  f.content.db.prepare('UPDATE content_series SET creator_id=? WHERE id=?').run(f.other.id,'91');
  assert.equal(f.analytics.series(f.requests.creator).items.length,0);
  assert.throws(()=>f.report(f.requests.creator),error=>error.status===404);
  f.users.db.prepare('DELETE FROM account_creators WHERE account_id=?').run(f.other.id);
  assert.throws(()=>f.analytics.series(f.requests.other),error=>error.status===403);
});

test('重复上报不重复计数，会话不可冒领，区间和时长不能回退或伪造',t=>{
  const f=fixture(t), requestId=crypto.randomUUID();
  const session=f.start(f.requests.viewer,'101','91',requestId);
  assert.equal(f.start(f.requests.viewer,'101','91',requestId).id,session.id);
  assert.throws(()=>f.start(f.requests.viewer,'102','91',requestId),error=>error.status===409);
  f.advance(5000);f.progress(session,5000,[[0,5000]]);
  assert.equal(f.progress(session,5000,[[0,5000]]).accepted,false);
  assert.throws(()=>f.progress(session,5000,[[0,5000]],2,0,f.requests.other),error=>error.status===404);
  assert.throws(()=>f.progress(session,4000,[[0,5000]],2),error=>error.status===400);
  assert.throws(()=>f.progress(session,5000,[[5000,10000]],2),error=>error.status===400);
  assert.throws(()=>f.progress(session,5000,[[0,10000]],2),error=>error.status===400);
  f.advance(5000);f.progress(session,10000,[[0,10000]],2);
  const result=f.report();assert.equal(result.summary.plays,1);assert.equal(result.summary.viewers,1);assert.equal(result.summary.completionRate,1);
});

test('拖动到结尾不算完播，重看不重复覆盖，真实续看按观众去重',t=>{
  const f=fixture(t), session=f.start();
  f.advance(4000);f.progress(session,4000,[[0,3000],[9000,10000]]);
  let result=f.report();assert.equal(result.episodes[0].completionRate,0);
  assert.equal(result.episodes[0].retention[10].viewers,0);
  f.advance(3000);f.progress(session,7000,[[0,3000],[9000,10000]],2);
  result=f.report();assert.equal(result.summary.watchMs,7000);assert.equal(result.episodes[0].retention[0].viewers,1);assert.equal(result.episodes[0].pendingViewers,1);
  const next=f.start(f.requests.viewer,'102');f.advance(3000);f.progress(next,3000,[[0,3000]]);
  result=f.report();assert.equal(result.episodes[0].continuationRate,1);assert.equal(result.episodes[0].continuationBase,1);assert.equal(result.episodes[0].pendingViewers,0);assert.equal(result.summary.viewers,1);assert.equal(result.summary.plays,2);
});

test('会员门槛、播放错误和内部预览分别处理',t=>{
  const f=fixture(t);
  assert.equal(f.start(f.requests.admin).excluded,true);assert.equal(f.start(f.requests.creator).excluded,true);
  const gate=f.start(f.requests.viewer,'104');assert.equal(gate.gate,true);
  assert.throws(()=>f.progress(gate,0,[]),error=>error.status===409);
  const session=f.start();f.advance(3000);f.progress(session,3000,[[0,3000]],1,1);
  const result=f.report();assert.equal(result.summary.gates,1);assert.equal(result.summary.errorSessions,1);assert.equal(result.summary.plays,1);assert.equal(result.episodes[3].continuationRate,null);
  assert.equal(JSON.stringify(result).includes(f.viewer.email),false);
});

test('开场立即离开的观众进入留存分母，但不伪增有效观看',t=>{
  const f=fixture(t), brief=f.start();f.advance(1000);f.progress(brief,1000,[[0,1000]]);
  const full=f.start(f.requests.other);f.advance(10000);f.progress(full,10000,[[0,10000]],1,0,f.requests.other);
  const result=f.report(), episode=result.episodes[0];
  assert.equal(result.summary.startedViewers,2);assert.equal(result.summary.viewers,1);
  assert.equal(episode.retention[0].viewers,2);assert.equal(episode.retention[10].viewers,1);assert.equal(episode.retention[10].rate,.5);
});

test('替换视频保留旧素材版本，反馈按实际操作和素材版本记录',t=>{
  const f=fixture(t), session=f.start();f.advance(10000);f.progress(session,10000,[[0,10000]]);
  f.analytics.feedback('91','101','like');f.analytics.feedback('91','101','comment');
  f.content.db.prepare("UPDATE content_episodes SET asset_id='replacement',title='修改后的第1集' WHERE id='101'").run();f.analytics.rememberVersion('101');
  const newer=f.start();f.advance(3000);f.progress(newer,3000,[[0,3000]]);f.analytics.feedback('91','101','unlike');
  const result=f.report(), first=result.episodes.filter(row=>row.episodeId==='101');
  assert.equal(first.length,2);assert.equal(first.find(row=>row.current).completionRate,0);assert.equal(first.find(row=>!row.current).completionRate,1);
  assert.equal(result.feedback.likesAdded,1);assert.equal(result.feedback.likesRemoved,1);assert.equal(result.feedback.commentsAdded,1);
  assert.equal(result.feedback.episodes.find(row=>row.assetId==='original'&&row.episodeId==='101').likesAdded,1);
});

test('采集之前的日期标记未采集，非法日期被拒绝，续看观察窗口限定24小时',t=>{
  const f=fixture(t);
  const old=f.report(f.requests.admin,{seriesId:'91',start:'2026-10-01',end:'2026-10-02'});
  assert.equal(old.collected,false);assert.ok(old.timeline.every(day=>!day.collected));
  assert.throws(()=>f.report(f.requests.admin,{start:'2026-02-30',end:'2026-10-14'}),error=>error.status===400);
  assert.throws(()=>f.report(f.requests.admin,{start:'2026-01-01',end:'2026-10-14'}),error=>error.status===400);
  const session=f.start();f.advance(3000);f.progress(session,3000,[[0,3000]]);
  f.advance(86400001);const next=f.start(f.requests.viewer,'102');f.advance(3000);f.progress(next,3000,[[0,3000]]);
  const result=f.report();assert.equal(result.episodes[0].continuationRate,0);assert.equal(result.episodes[0].pendingViewers,0);
  assert.throws(()=>f.progress(session,3000,[[0,3000]],2),error=>error.status===409);
});

test('剧下每集只占一行，跨版本观众去重，集详情只读取该集的数据和反馈',t=>{
  const f=fixture(t), first=f.start();f.advance(4000);f.progress(first,4000,[[0,4000]]);
  f.analytics.feedback('91','101','like');
  f.content.db.prepare("UPDATE content_episodes SET asset_id='replacement' WHERE id='101'").run();f.analytics.rememberVersion('101');
  const replaced=f.start();f.advance(3000);f.progress(replaced,3000,[[0,3000]]);
  const second=f.start(f.requests.viewer,'102');f.advance(3000);f.progress(second,3000,[[0,3000]]);f.analytics.feedback('91','102','comment');
  for(const id of ['101','102'])f.content.db.prepare('INSERT INTO episode_comments VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),id,'91',f.viewer.id,`第${id}集评论`,'visible',f.analytics.clock());
  const all=f.report();assert.equal(all.episodeGroups.length,4);assert.equal(all.episodeGroups[0].viewers,1);assert.equal(all.episodeGroups[0].plays,2);
  const scoped=f.report(f.requests.creator,{seriesId:'91',episodeId:'101'});
  assert.equal(scoped.episodeGroups.length,1);assert.equal(scoped.episodes.length,2);assert.equal(scoped.summary.plays,2);assert.equal(scoped.feedback.likesAdded,1);assert.equal(scoped.feedback.commentsAdded,0);
  assert.equal(scoped.feedback.comments.length,1);
  assert.ok(scoped.feedback.comments.every(row=>row.episode_id==='101'));
  assert.throws(()=>f.report(f.requests.creator,{seriesId:'91',episodeId:'201'}),error=>error.status===404);
});

test('剧列表数据库聚合与剧详情口径一致，多剧观众不重复累加',t=>{
  const f=fixture(t), first=f.start();f.advance(10000);f.progress(first,10000,[[0,10000]]);
  const next=f.start(f.requests.viewer,'201','92');f.advance(3000);f.progress(next,3000,[[0,3000]]);
  const all=f.report(f.requests.admin,{}),own=f.report(f.requests.creator,{});
  assert.equal(all.summary.viewers,1);assert.equal(all.summary.plays,2);assert.equal(all.summary.completionRate,.5);
  assert.equal(all.summary.watchMs,13000);assert.equal(all.timeline.at(-1).viewers,1);
  assert.equal(own.series.length,1);assert.equal(own.summary.plays,1);assert.equal(own.summary.completionRate,1);
  assert.equal(own.series[0].plays,f.report().summary.plays);
});

test('播放采样排除暂停、隐藏、跳转和缓冲，并按实际倍速计算真实时长',()=>{
  let now=0;const snapshots=[], tracker=new PlaybackAnalytics(value=>snapshots.push(value),10000,()=>now);
  const video={currentTime:0,playbackRate:1,paused:false,ended:false,seeking:false,readyState:4};
  tracker.sample(video);now=250;video.currentTime=.25;tracker.sample(video);
  assert.equal(tracker.watchMs,250);
  video.paused=true;now=500;tracker.sample(video);now=1000;tracker.sample(video);assert.equal(tracker.watchMs,250);
  video.paused=false;tracker.sample(video);now=1250;video.currentTime=9;video.seeking=true;tracker.sample(video);
  video.seeking=false;now=1500;tracker.sample(video);now=1750;video.currentTime=9.25;tracker.sample(video);
  assert.equal(tracker.watchMs,500);assert.deepEqual(tracker.ranges,[[0,250],[9000,9250]]);
  now=2000;video.currentTime=9.5;tracker.sample(video,false);assert.equal(tracker.watchMs,500);
  tracker.blocked=true;now=2250;tracker.sample(video);assert.equal(tracker.watchMs,500);
  tracker.blocked=false;video.playbackRate=2;video.currentTime=5;now=2500;tracker.sample(video);now=2750;video.currentTime=5.5;tracker.sample(video);
  assert.equal(tracker.watchMs,750);tracker.flush();assert.equal(snapshots[0].watchMs,750);
});

test('观看区间属性：合并保留真实覆盖，排序和重试不影响结果',()=>{
  let seed=17;const random=()=>{seed=(seed*48271)%2147483647;return seed;};
  for(let run=0;run<200;run++){
    const ranges=Array.from({length:30},()=>{const a=random()%999,b=a+1+random()%(1000-a);return[a,b];});
    const result=mergeRanges(ranges,1000), covered=new Set();
    for(const[a,b]of ranges)for(let value=a;value<b;value++)covered.add(value);
    assert.equal(result.reduce((total,[a,b])=>total+b-a,0),covered.size);
    assert.deepEqual(mergeRanges([...ranges,...ranges].reverse(),1000),result);
    assert.deepEqual(mergeRanges(result,1000),result);
  }
});
