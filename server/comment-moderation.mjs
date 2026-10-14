import { AccountError } from './account-store.mjs';

// 保存服务端确认过的剧集信息，内容下架或移除后仍能识别历史评论。
export class CommentModeration {
  constructor(store, resolve) {
    this.store = store; this.db = store.db; this.resolve = resolve;
    this.db.exec(`CREATE TABLE IF NOT EXISTS comment_content(series_id TEXT NOT NULL,episode_id TEXT NOT NULL,series_title TEXT NOT NULL,episode_number INTEGER NOT NULL,episode_title TEXT NOT NULL,PRIMARY KEY(series_id,episode_id));
      CREATE INDEX IF NOT EXISTS comments_series ON episode_comments(series_id,episode_id);
      INSERT OR IGNORE INTO comment_content SELECT e.series_id,e.id,s.title,e.number,e.title FROM content_episodes e JOIN content_series s ON s.id=e.series_id;
      INSERT OR IGNORE INTO comment_content SELECT series_id,episode_id,json_extract(metadata,'$.title'),json_extract(metadata,'$.episodeNumber'),'' FROM liked_episode_content WHERE json_extract(metadata,'$.title') IS NOT NULL AND json_extract(metadata,'$.episodeNumber')>0;`);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='analytics_versions'").get()) this.db.exec('INSERT OR IGNORE INTO comment_content SELECT v.series_id,v.episode_id,s.title,v.episode_number,v.title FROM analytics_versions v JOIN content_series s ON s.id=v.series_id ORDER BY v.created_at DESC');
  }
  remember(series) {
    const save = this.db.prepare('INSERT INTO comment_content VALUES(?,?,?,?,?) ON CONFLICT(series_id,episode_id) DO UPDATE SET series_title=excluded.series_title,episode_number=excluded.episode_number,episode_title=excluded.episode_title');
    series.episodes.forEach((episode, index) => save.run(String(series.id),String(episode.id),series.title,episode.number || index+1,episode.title || ''));
    this.db.prepare('UPDATE comment_content SET series_title=? WHERE series_id=?').run(series.title,String(series.id));
  }
  async recover(seriesId) {
    try { const series=await this.resolve(seriesId,true); this.remember(series); return series; } catch {
      // 内容源暂不可用时保留评论和审核能力，不猜测名称或集数。
    }
  }
  async series(params) {
    const missing = this.db.prepare('SELECT DISTINCT c.series_id FROM episode_comments c LEFT JOIN content_series s ON s.id=c.series_id WHERE s.id IS NULL AND NOT EXISTS(SELECT 1 FROM comment_content m WHERE m.series_id=c.series_id) LIMIT 24').all();
    await Promise.allSettled(missing.map(row => this.recover(row.series_id)));
    const page = this.page(params), query = (params.get('q') || '').trim().slice(0,200);
    const rows = this.db.prepare(`WITH ids AS (SELECT id FROM content_series UNION SELECT series_id FROM episode_comments),
      names AS (SELECT series_id,MAX(series_title) AS title FROM comment_content GROUP BY series_id),
      counts AS (SELECT series_id,COUNT(*) AS comments FROM episode_comments GROUP BY series_id),
      reports AS (SELECT c.series_id,COUNT(*) AS reports FROM comment_reports r JOIN episode_comments c ON c.id=r.comment_id GROUP BY c.series_id)
      SELECT ids.id,COALESCE(s.title,n.title) AS title,COALESCE(c.comments,0) AS comments,COALESCE(r.reports,0) AS reports
      FROM ids LEFT JOIN content_series s ON s.id=ids.id LEFT JOIN names n ON n.series_id=ids.id LEFT JOIN counts c ON c.series_id=ids.id LEFT JOIN reports r ON r.series_id=ids.id
      WHERE (?='' OR COALESCE(s.title,n.title,'') LIKE ?) ORDER BY reports DESC,comments DESC,ids.id DESC LIMIT 25 OFFSET ?`).all(query,`%${query}%`,(page-1)*24);
    return { items:rows.slice(0,24),hasMore:rows.length>24 };
  }
  page(params) {
    const value = params.get('page') || '1';
    if (!/^\d{1,4}$/.test(value) || Number(value)<1 || Number(value)>1000) throw new AccountError(400,'评论分页无效');
    return Number(value);
  }
  async comments(params) {
    const seriesId=params.get('seriesId'), episodeId=params.get('episodeId') || '', page=this.page(params);
    if (!/^\d{1,40}$/.test(seriesId || '') || episodeId && !/^\d{1,40}$/.test(episodeId)) throw new AccountError(400,'评论筛选无效');
    if (!this.store.row(seriesId) && !this.db.prepare('SELECT 1 FROM episode_comments WHERE series_id=?').get(seriesId)) throw new AccountError(404,'短剧不存在');
    const current=await this.recover(seriesId);
    const episodes=this.db.prepare(`SELECT ids.id,COALESCE(e.number,m.episode_number) AS number,COALESCE(e.title,m.episode_title,'') AS title,e.id IS NULL AS removed
      FROM (SELECT id FROM content_episodes WHERE series_id=? UNION SELECT episode_id FROM episode_comments WHERE series_id=?) ids
      LEFT JOIN content_episodes e ON e.id=ids.id AND e.series_id=? LEFT JOIN comment_content m ON m.episode_id=ids.id AND m.series_id=? ORDER BY number IS NULL,number,ids.id`).all(seriesId,seriesId,seriesId,seriesId);
    if (!this.store.row(seriesId)) episodes.forEach(row=>{row.removed=!!current && !current.episodes.some(episode=>String(episode.id)===row.id);});
    for (const [index,episode] of (current?.episodes || []).entries()) {
      const row=episodes.find(row=>row.id===String(episode.id));
      if (row) { row.removed=0; row.number=episode.number || index+1; row.title=episode.title || ''; }
      else episodes.push({id:String(episode.id),number:episode.number || index+1,title:episode.title || '',removed:0});
    }
    episodes.sort((a,b)=>(a.number ?? Infinity)-(b.number ?? Infinity)||a.id.localeCompare(b.id));
    if (episodeId && !episodes.some(row=>row.id===episodeId)) throw new AccountError(404,'分集不属于此短剧');
    const seriesTitle=this.store.row(seriesId)?.title || this.db.prepare('SELECT series_title FROM comment_content WHERE series_id=? LIMIT 1').get(seriesId)?.series_title || null;
    const rows=this.db.prepare(`SELECT c.id,c.account_id,c.body,c.status,c.created_at,c.episode_id,COALESCE(e.number,m.episode_number) AS episodeNumber,
      (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id=c.id) AS reports
      FROM episode_comments c LEFT JOIN content_episodes e ON e.id=c.episode_id AND e.series_id=c.series_id LEFT JOIN comment_content m ON m.episode_id=c.episode_id AND m.series_id=c.series_id
      WHERE c.series_id=? AND (?='' OR c.episode_id=?) ORDER BY reports DESC,c.created_at DESC,c.id DESC LIMIT 101 OFFSET ?`).all(seriesId,episodeId,episodeId,(page-1)*100);
    return { series:{id:seriesId,title:seriesTitle},episodes,items:rows.slice(0,100).map(row=>({...row,seriesTitle})),hasMore:rows.length>100 };
  }
}
