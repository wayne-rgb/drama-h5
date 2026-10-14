import fs from 'node:fs';
import path from 'node:path';
import {positiveLimit} from './request-guard.mjs';

// 只约束公开采集的空会话和新增空间，不删除真实观看、错误或VIP拦截事实，也不更改报表计算。
export class AnalyticsResource {
  constructor(content,directory,config={},clock=Date.now){
    this.content=content;this.db=content.db;this.directory=directory;this.clock=clock;this.checkedAt=-Infinity;this.bytes=0;this.warned=false;
    this.maximum=positiveLimit(config,'ANALYTICS_MAX_EMPTY_SESSIONS',10000);
    this.perActor=positiveLimit(config,'ANALYTICS_MAX_ACTOR_EMPTY_SESSIONS',64);
    this.byteMaximum=positiveLimit(config,'ANALYTICS_DATABASE_BYTES',1024**3);
    this.db.exec("CREATE INDEX IF NOT EXISTS analytics_empty_sessions ON analytics_sessions(updated_at,actor) WHERE watch_ms=0 AND covered_ms=0 AND errors=0 AND gate=0; CREATE INDEX IF NOT EXISTS analytics_actor_empty ON analytics_sessions(actor,started_at) WHERE watch_ms=0 AND covered_ms=0 AND errors=0;");
  }
  start(analytics,req,input){
    if(!input||!/^\d{1,40}$/.test(input.seriesId||'')||!/^\d{1,40}$/.test(input.episodeId||'')||!/^[a-f0-9-]{36}$/.test(input.requestId||'')||!['detail','feed'].includes(input.entry))return analytics.start(req,input);
    const {id:actor,user}=analytics.actor(req),now=this.clock(),series=this.content.row(input.seriesId);
    if(!series||series.status!=='published'||analytics.isAdmin(user)||!user.guest&&series.creator_id===user.id||!this.db.prepare('SELECT 1 FROM content_episodes WHERE id=? AND series_id=?').get(input.episodeId,input.seriesId))return analytics.start(req,input);
    const known=this.db.prepare('SELECT 1 FROM analytics_sessions WHERE actor=? AND request_id=?').get(actor,input.requestId);
    if(known)return analytics.start(req,input);
    // 与客户端六小时重试窗口一致，只清理没有观看、没有报错且未触发VIP的过期空记录，每次最多256条。
    this.db.prepare('DELETE FROM analytics_sessions WHERE id IN (SELECT id FROM analytics_sessions WHERE watch_ms=0 AND covered_ms=0 AND errors=0 AND gate=0 AND updated_at<? ORDER BY updated_at LIMIT 256)').run(now-6*3600000);
    const count=this.db.prepare('SELECT COUNT(*) AS count FROM analytics_sessions WHERE actor=? AND watch_ms=0 AND covered_ms=0 AND errors=0 AND started_at>?').get(actor,now-86400000).count;
    if(count>=this.perActor){
      const reusable=this.db.prepare('SELECT id FROM analytics_sessions WHERE actor=? AND watch_ms=0 AND covered_ms=0 AND errors=0 AND gate=0 ORDER BY updated_at LIMIT 1').get(actor);
      if(reusable)this.db.prepare('DELETE FROM analytics_sessions WHERE id=?').run(reusable.id);
      else return {deferred:true};
    }
    const empty=this.db.prepare('SELECT COUNT(*) AS count FROM analytics_sessions WHERE watch_ms=0 AND covered_ms=0 AND errors=0 AND gate=0').get().count;
    if(empty>=this.maximum){
      const old=this.db.prepare('SELECT id FROM analytics_sessions WHERE watch_ms=0 AND covered_ms=0 AND errors=0 AND gate=0 AND updated_at<? ORDER BY updated_at LIMIT 1').get(now-60000);
      if(old)this.db.prepare('DELETE FROM analytics_sessions WHERE id=?').run(old.id);else return {deferred:true};
    }
    if(now-this.checkedAt>=5000){this.bytes=['content.sqlite','content.sqlite-wal','content.sqlite-shm'].reduce((total,name)=>{try{return total+fs.statSync(path.join(this.directory,name)).size;}catch(error){if(error.code==='ENOENT')return total;throw error;}},0);this.checkedAt=now;}
    if(this.bytes>=this.byteMaximum){if(!this.warned){console.warn('公开采集空间达到保护范围，保留已有事实与正常播放');this.warned=true;}return {deferred:true};}
    this.warned=false;return analytics.start(req,input);
  }
}
