import crypto from 'node:crypto';
import { AccountError, digest } from './account-store.mjs';

const DAY = 86400000;
const UUID = /^[a-f0-9-]{36}$/;
export function mergeRanges(ranges, duration, maximum = 1000) {
  if (!Array.isArray(ranges) || ranges.length > maximum) throw new AccountError(400, '观看区间无效');
  const sorted = ranges.map(range => {
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] <= range[0] || range[1] > duration) throw new AccountError(400, '观看区间无效');
    return [...range];
  }).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else result.push(range);
  }
  return result;
}
const coverage = ranges => ranges.reduce((total, [start, end]) => total + end - start, 0);
const effective = row => row.watch_ms >= 3000 || row.covered_ms >= row.duration_ms * .9;
const rate = (numerator, denominator) => denominator ? numerator / denominator : null;

export class ContentAnalytics {
  constructor(content, accountStore, accounts, isAdmin, clock = Date.now) {
    this.content = content; this.db = content.db; this.accountStore = accountStore;
    this.accounts = accounts; this.isAdmin = isAdmin; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS analytics_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_sessions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,actor TEXT NOT NULL,actor_kind TEXT NOT NULL,series_id TEXT NOT NULL,episode_id TEXT NOT NULL,asset_id TEXT NOT NULL,episode_number INTEGER NOT NULL,next_episode_id TEXT,duration_ms INTEGER NOT NULL,entry TEXT NOT NULL,member INTEGER NOT NULL,started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,watch_ms INTEGER NOT NULL DEFAULT 0,covered_ms INTEGER NOT NULL DEFAULT 0,ranges TEXT NOT NULL DEFAULT '[]',errors INTEGER NOT NULL DEFAULT 0,gate INTEGER NOT NULL DEFAULT 0,UNIQUE(actor,request_id));
      CREATE INDEX IF NOT EXISTS analytics_series_time ON analytics_sessions(series_id,started_at);
      CREATE INDEX IF NOT EXISTS analytics_time ON analytics_sessions(started_at);
      CREATE INDEX IF NOT EXISTS analytics_actor_episode ON analytics_sessions(actor,series_id,episode_id,started_at);
      CREATE TABLE IF NOT EXISTS analytics_versions(episode_id TEXT NOT NULL,asset_id TEXT NOT NULL,series_id TEXT NOT NULL,episode_number INTEGER NOT NULL,title TEXT NOT NULL,duration_ms INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(episode_id,asset_id));
      CREATE TABLE IF NOT EXISTS analytics_feedback(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,episode_id TEXT NOT NULL,asset_id TEXT,kind TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS analytics_feedback_time ON analytics_feedback(series_id,created_at);`);
    this.db.prepare('INSERT OR IGNORE INTO analytics_meta VALUES(?,?)').run('collectionStartedAt', String(clock()));
    for (const row of this.db.prepare('SELECT id FROM content_episodes').all()) this.rememberVersion(row.id);
    this.rates = new Map();
  }
  rememberVersion(episodeId) {
    const row = this.db.prepare('SELECT e.*,a.metadata FROM content_episodes e JOIN content_assets a ON a.id=e.asset_id WHERE e.id=?').get(episodeId);
    const duration = Math.round(Number(JSON.parse(row?.metadata || '{}').duration) * 1000);
    if (row && Number.isSafeInteger(duration) && duration > 0) this.db.prepare('INSERT OR IGNORE INTO analytics_versions VALUES(?,?,?,?,?,?,?)').run(row.id,row.asset_id,row.series_id,row.number,row.title,duration,this.clock());
  }
  actor(req) {
    const user = this.accounts.audience(req);
    if (!user) throw new AccountError(401, '请刷新页面后重试');
    return { user, id: digest(`${user.guest ? 'guest' : 'account'}:${user.id}`) };
  }
  limit(actor) {
    const now = this.clock();
    for (const [key, value] of this.rates) if (value.until < now) this.rates.delete(key);
    const row = this.rates.get(actor) || { count: 0, until: now + 60000 };
    if (++row.count > 180 || this.rates.size >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试');
    this.rates.set(actor, row);
  }
  start(req, input) {
    const { user, id: actor } = this.actor(req); this.limit(actor);
    if (!input || typeof input!=='object' || !/^\d{1,40}$/.test(input.seriesId || '') || !/^\d{1,40}$/.test(input.episodeId || '') || !UUID.test(input.requestId || '') || !['detail', 'feed'].includes(input.entry)) throw new AccountError(400, '观看会话无效');
    const series = this.content.row(input.seriesId);
    if (!series || series.status !== 'published') return { excluded: true };
    // 管理员和作品所属创作者的预览，不进入观众统计。
    if (this.isAdmin(user) || !user.guest && series.creator_id === user.id) return { excluded: true };
    const previous = this.db.prepare('SELECT * FROM analytics_sessions WHERE actor=? AND request_id=?').get(actor, input.requestId);
    if (previous) {
      if (previous.series_id !== input.seriesId || previous.episode_id !== input.episodeId) throw new AccountError(409, '观看会话无效');
      return { id: previous.id, durationMs: previous.duration_ms, gate: !!previous.gate };
    }
    const detail = this.content.detail(input.seriesId), index = detail.episodes.findIndex(ep => ep.id === input.episodeId);
    if (index < 0) throw new AccountError(404, '分集不属于此短剧');
    const episode = detail.episodes[index], asset = this.content.asset(episode.assetId);
    const durationMs = Math.round(Number(asset?.metadata?.duration) * 1000);
    if (asset?.status !== 'ready' || !Number.isSafeInteger(durationMs) || durationMs <= 0) throw new AccountError(503, '视频尚未处理完成');
    const member = !user.guest && this.accountStore.membership(user.id).active, gate = index >= 3 && !member;
    const id = crypto.randomUUID(), now = this.clock();
    this.db.prepare('INSERT INTO analytics_sessions(id,request_id,actor,actor_kind,series_id,episode_id,asset_id,episode_number,next_episode_id,duration_ms,entry,member,started_at,updated_at,gate) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, input.requestId, actor, user.guest ? 'guest' : 'account', series.id, episode.id, asset.id, episode.number, detail.episodes[index + 1]?.id || null, durationMs, input.entry, member ? 1 : 0, now, now, gate ? 1 : 0);
    return { id, durationMs, gate };
  }
  progress(req, input) {
    const { id: actor } = this.actor(req); this.limit(actor);
    if (!input || typeof input!=='object' || !UUID.test(input.id || '') || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new AccountError(400, '观看会话无效');
    const row = this.db.prepare('SELECT * FROM analytics_sessions WHERE id=? AND actor=?').get(input.id, actor);
    if (!row) throw new AccountError(404, '观看会话不存在');
    if (input.sequence <= row.sequence) return { accepted: false };
    const now = this.clock();
    if (row.gate || now - row.started_at > 6 * 3600000) throw new AccountError(409, '观看会话已结束');
    if (!Number.isSafeInteger(input.watchMs) || input.watchMs < row.watch_ms || input.watchMs > now - row.started_at + 2000 || input.watchMs-row.watch_ms > now-row.updated_at+2000 || !Number.isSafeInteger(input.errors) || input.errors < row.errors || input.errors > 100) throw new AccountError(400, '观看时长无效');
    const old = JSON.parse(row.ranges), ranges = mergeRanges(input.ranges, row.duration_ms), covered = coverage(ranges);
    // 累计区间不能回退；新增覆盖不能超过真实时长与播放器最高倍速允许的范围。
    if (coverage(mergeRanges([...old, ...ranges], row.duration_ms, Infinity)) !== covered || covered - row.covered_ms > (input.watchMs - row.watch_ms) * 3.25 + 1000) throw new AccountError(400, '观看区间无效');
    this.db.prepare('UPDATE analytics_sessions SET sequence=?,watch_ms=?,covered_ms=?,ranges=?,errors=?,updated_at=? WHERE id=?').run(input.sequence, input.watchMs, covered, JSON.stringify(ranges), input.errors, now, row.id);
    return { accepted: true };
  }
  feedback(seriesId, episodeId, kind) {
    const episode = this.db.prepare('SELECT asset_id FROM content_episodes WHERE id=? AND series_id=?').get(episodeId, seriesId);
    if (episode) this.db.prepare('INSERT INTO analytics_feedback VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), seriesId, episodeId, episode.asset_id, kind, this.clock());
  }
  scope(req, seriesId) {
    const user = this.accounts.requireViewer(req), admin = this.isAdmin(user);
    if (!admin && !this.accountStore.isCreator(user.id)) throw new AccountError(403, '需要创作者权限');
    if (seriesId) {
      const series = this.content.row(seriesId);
      if (!series || !admin && series.creator_id !== user.id) throw new AccountError(404, '短剧不存在');
    }
    return { user, admin };
  }
  series(req) {
    const { user, admin } = this.scope(req);
    const rows = this.db.prepare('SELECT id,title,creator_id,status,cover_id,(SELECT COUNT(*) FROM content_episodes e WHERE e.series_id=content_series.id) AS episode_count FROM content_series WHERE ?=1 OR creator_id=? ORDER BY updated_at DESC').all(admin ? 1 : 0, user.id);
    return { items: rows.map(row => ({ id: row.id, title: row.title, creatorId: row.creator_id, status: row.status,cover:row.cover_id?`/api/content/covers/${row.cover_id}`:'',episodeCount:row.episode_count })) };
  }
  report(req, params) {
    const seriesId = params.get('seriesId') || '', { user, admin } = this.scope(req, seriesId);
    const episodeId=params.get('episodeId') || '';
    if(episodeId && (!seriesId || !this.db.prepare('SELECT 1 FROM content_episodes WHERE id=? AND series_id=? UNION SELECT 1 FROM analytics_versions WHERE episode_id=? AND series_id=?').get(episodeId,seriesId,episodeId,seriesId)))throw new AccountError(404,'分集不属于此短剧');
    const now = this.clock(), end = params.get('end') || new Date(now).toISOString().slice(0, 10), start = params.get('start') || new Date(now - 6 * DAY).toISOString().slice(0, 10);
    const parse = value => { const time = Date.parse(`${value}T00:00:00Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new AccountError(400, '统计日期无效'); return time; };
    const from = parse(start), to = parse(end) + DAY;
    if (to <= from || to - from > 90 * DAY || from > now || to > parse(new Date(now).toISOString().slice(0, 10)) + DAY) throw new AccountError(400, '统计日期无效');
    const filters = 's.started_at>=? AND s.started_at<? AND (?=1 OR c.creator_id=?) AND (?=\'\' OR s.series_id=?) AND (?=\'\' OR s.episode_id=?)';
    const bindings = [from, to, admin ? 1 : 0, user.id, seriesId, seriesId];
    // 剧列表在数据库内聚合，不把所有作品的观看区间加载到服务进程。
    const rows = seriesId ? this.db.prepare(`SELECT s.* FROM analytics_sessions s JOIN content_series c ON c.id=s.series_id WHERE ${filters} ORDER BY s.started_at`).all(...bindings,episodeId,episodeId) : [];
    const validSql='(s.watch_ms>=3000 OR s.covered_ms>=s.duration_ms*0.9)';
    const aggregates=`COUNT(DISTINCT CASE WHEN s.watch_ms>0 AND s.covered_ms>0 THEN s.actor END) AS startedViewers,
      COUNT(DISTINCT CASE WHEN ${validSql} THEN s.actor END) AS viewers,
      COALESCE(SUM(CASE WHEN ${validSql} THEN 1 ELSE 0 END),0) AS plays,
      COALESCE(SUM(CASE WHEN ${validSql} THEN s.watch_ms ELSE 0 END),0) AS watchMs,
      SUM(CASE WHEN ${validSql} AND s.covered_ms>=s.duration_ms*0.9 THEN 1.0 ELSE 0 END)/NULLIF(SUM(CASE WHEN ${validSql} THEN 1 ELSE 0 END),0) AS completionRate,
      COUNT(DISTINCT CASE WHEN s.gate=1 THEN s.actor END) AS gates,
      COALESCE(SUM(CASE WHEN s.errors>0 THEN 1 ELSE 0 END),0) AS errorSessions,COUNT(*) AS attempts`;
    const sqlSummary = !seriesId ? this.db.prepare(`SELECT ${aggregates} FROM analytics_sessions s JOIN content_series c ON c.id=s.series_id WHERE ${filters}`).get(...bindings,episodeId,episodeId) : null;
    const sqlSeries = !seriesId ? new Map(this.db.prepare(`SELECT s.series_id AS id,${aggregates} FROM analytics_sessions s JOIN content_series c ON c.id=s.series_id WHERE ${filters} GROUP BY s.series_id`).all(...bindings,episodeId,episodeId).map(row=>[row.id,row])) : null;
    const sqlDays = !seriesId ? new Map(this.db.prepare(`SELECT strftime('%Y-%m-%d',s.started_at/1000,'unixepoch') AS date,${aggregates} FROM analytics_sessions s JOIN content_series c ON c.id=s.series_id WHERE ${filters} GROUP BY date`).all(...bindings,episodeId,episodeId).map(row=>[row.date,row])) : null;
    const summarize = list => {
      const valid = list.filter(effective);
      return { startedViewers:new Set(list.filter(row=>row.watch_ms>0 && row.covered_ms>0).map(row=>row.actor)).size, viewers: new Set(valid.map(row => row.actor)).size, plays: valid.length, watchMs: valid.reduce((total, row) => total + row.watch_ms, 0), completionRate: rate(valid.filter(row => row.covered_ms >= row.duration_ms * .9).length, valid.length), gates: new Set(list.filter(row => row.gate).map(row => row.actor)).size, errorSessions: list.filter(row => row.errors > 0).length, attempts: list.length };
    };
    const continuation = list => {
      const continued=new Set(),eligible=new Set(),pending=new Set();
      for(const row of list.filter(effective)) {
        if(!row.next_episode_id)continue;
        eligible.add(row.actor);
        const next=this.db.prepare('SELECT watch_ms,covered_ms,duration_ms FROM analytics_sessions WHERE actor=? AND series_id=? AND episode_id=? AND started_at>=? AND started_at<=? AND gate=0').all(row.actor,row.series_id,row.next_episode_id,row.started_at,row.started_at+DAY).some(effective);
        if(next)continued.add(row.actor);else if(row.started_at+DAY>now)pending.add(row.actor);
      }
      for(const actor of continued)pending.delete(actor);
      return {continuationRate:rate(continued.size,eligible.size),continuationViewers:continued.size,continuationBase:eligible.size,pendingViewers:pending.size};
    };
    const series = this.series(req).items.filter(item => !seriesId || item.id === seriesId).map(item => ({ ...item, ...(sqlSeries?.get(item.id) || summarize(rows.filter(row => row.series_id === item.id))) }));
    const collectionStartedAt=Number(this.db.prepare('SELECT value FROM analytics_meta WHERE key=?').get('collectionStartedAt').value);
    const timeline = [];
    for (let day = from; day < to; day += DAY) {const date=new Date(day).toISOString().slice(0,10);timeline.push({date,collected:day+DAY>collectionStartedAt,...(sqlDays?.get(date)||summarize(rows.filter(row=>row.started_at>=day&&row.started_at<day+DAY)))});}
    const episodes = [];
    if (seriesId) {
      // 按素材版本分组，同时保留已替换和已删除分集的历史表现。
      const versions = new Map();
      for (const row of this.db.prepare("SELECT e.*,a.metadata FROM content_episodes e JOIN content_assets a ON a.id=e.asset_id WHERE e.series_id=? AND (?='' OR e.id=?) ORDER BY e.number").all(seriesId,episodeId,episodeId)) versions.set(`${row.id}:${row.asset_id}`, { episodeId: row.id, assetId: row.asset_id, number: row.number, title: row.title, current: true, durationMs: Math.round(JSON.parse(row.metadata || '{}').duration * 1000) });
      for (const row of this.db.prepare("SELECT * FROM analytics_versions WHERE series_id=? AND (?='' OR episode_id=?) ORDER BY created_at").all(seriesId,episodeId,episodeId)) if (!versions.has(`${row.episode_id}:${row.asset_id}`)) versions.set(`${row.episode_id}:${row.asset_id}`, { episodeId: row.episode_id, assetId: row.asset_id, number: row.episode_number, title: row.title, current: false, durationMs: row.duration_ms });
      for (const row of rows) if (!versions.has(`${row.episode_id}:${row.asset_id}`)) versions.set(`${row.episode_id}:${row.asset_id}`, { episodeId: row.episode_id, assetId: row.asset_id, number: row.episode_number, title: '', current: false, durationMs: row.duration_ms });
      for (const version of versions.values()) {
        const list = rows.filter(row => row.episode_id === version.episodeId && row.asset_id === version.assetId), valid = list.filter(effective), viewers = new Map();
        // 留存分母包含实际开播后立即离开的观众，避免只看有效观看而遗漏开场流失。
        for (const row of list.filter(row=>row.watch_ms>0 && row.covered_ms>0)) viewers.set(row.actor, mergeRanges([...(viewers.get(row.actor) || []), ...JSON.parse(row.ranges)], row.duration_ms, Infinity));
        const retention = Array.from({ length: 20 }, (_, index) => {
          const lower = version.durationMs * index / 20, upper = version.durationMs * (index + 1) / 20;
          const count = [...viewers.values()].filter(ranges => ranges.reduce((total, [a, b]) => total + Math.max(0, Math.min(b, upper) - Math.max(a, lower)), 0) >= (upper - lower) * .5).length;
          return { progress: index * 5, viewers: count, rate: rate(count, viewers.size) };
        });
        episodes.push({ ...version, ...summarize(list), retention, ...continuation(valid) });
      }
      episodes.sort((a, b) => a.number - b.number || Number(b.current) - Number(a.current));
    }
    const episodeGroups=[...new Set(episodes.map(row=>row.episodeId))].map(id=>{
      const versions=episodes.filter(row=>row.episodeId===id),metadata=versions.find(row=>row.current)||versions.at(-1),list=rows.filter(row=>row.episode_id===id);
      // 历史逻辑集使用最后确认的名称与集数，素材版本及观看事实保持原有统计归属。
      const latest=!metadata.current ? this.db.prepare('SELECT r.episode_number AS number,r.episode_title AS title FROM content_audit_refs r JOIN content_audit a ON a.id=r.audit_id WHERE r.series_id=? AND r.episode_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1').get(seriesId,id) : null;
      return {episodeId:id,number:latest?.number || metadata.number,title:latest?.title || metadata.title,current:metadata.current,...summarize(list),...continuation(list)};
    }).sort((a,b)=>a.number-b.number);
    const feedbackRows = this.db.prepare("SELECT f.kind,f.created_at,f.episode_id,f.asset_id FROM analytics_feedback f JOIN content_series c ON c.id=f.series_id WHERE f.created_at>=? AND f.created_at<? AND (?=1 OR c.creator_id=?) AND (?='' OR f.series_id=?) AND (?='' OR f.episode_id=?)").all(...bindings,episodeId,episodeId);
    const counts = list => ({ likesAdded: list.filter(row => row.kind === 'like').length, likesRemoved: list.filter(row => row.kind === 'unlike').length, commentsAdded: list.filter(row => row.kind === 'comment').length });
    const commentPage = Number(params.get('commentPage') || 1);
    if (!Number.isSafeInteger(commentPage) || commentPage < 1 || commentPage > 10000) throw new AccountError(400, '统计日期无效');
    const comments = this.db.prepare("SELECT m.id,m.episode_id,m.body,m.created_at,c.title FROM episode_comments m JOIN content_series c ON c.id=m.series_id WHERE m.status='visible' AND m.created_at>=? AND m.created_at<? AND (?=1 OR c.creator_id=?) AND (?='' OR m.series_id=?) AND (?='' OR m.episode_id=?) ORDER BY m.created_at DESC,m.id DESC LIMIT 21 OFFSET ?").all(...bindings,episodeId,episodeId, (commentPage - 1) * 20);
    const likes = this.db.prepare("SELECT COUNT(*) AS count FROM episode_likes l JOIN content_episodes e ON e.id=l.episode_id JOIN content_series c ON c.id=e.series_id WHERE (?=1 OR c.creator_id=?) AND (?='' OR e.series_id=?) AND (?='' OR e.id=?)").get(admin ? 1 : 0, user.id, seriesId, seriesId,episodeId,episodeId).count;
    return { start, end, timezone: 'UTC', collected:to>collectionStartedAt, collectionStartedAt, summary: sqlSummary || summarize(rows), timeline, series, episodes, episodeGroups, feedback: { currentLikes: likes, ...counts(feedbackRows), timeline: timeline.map(day => ({ date: day.date, collected:day.collected, ...counts(feedbackRows.filter(row => new Date(row.created_at).toISOString().slice(0, 10) === day.date)) })), episodes: episodes.map(ep => ({ episodeId: ep.episodeId, assetId: ep.assetId, ...counts(feedbackRows.filter(row => row.episode_id === ep.episodeId && row.asset_id === ep.assetId)) })), comments: comments.slice(0, 20), hasMoreComments: comments.length > 20 } };
  }
}
