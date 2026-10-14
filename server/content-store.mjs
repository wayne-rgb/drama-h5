import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccountError } from './account-store.mjs';

// 自有内容使用数字标识，兼容现有跨端播放链接和收藏记录。
export const contentId = () => `9${Date.now()}${crypto.randomInt(100000, 1000000)}`;
export function textValue(value, label, max = 200, optional = false) {
  if (typeof value !== 'string' || value.trim().length > max || (!optional && !value.trim())) throw new AccountError(400, `${label}无效`);
  return value.trim();
}
export class ContentStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'content.sqlite'));
    chmodSync(path.join(directory, 'content.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS content_series(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,tags TEXT NOT NULL,content_type TEXT NOT NULL,language TEXT NOT NULL,cover_id TEXT,status TEXT NOT NULL DEFAULT 'draft',updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS content_episodes(id TEXT PRIMARY KEY,series_id TEXT NOT NULL,number INTEGER NOT NULL,title TEXT NOT NULL,asset_id TEXT NOT NULL,UNIQUE(series_id,number));
      CREATE TABLE IF NOT EXISTS content_assets(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,offset INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'uploading',metadata TEXT,error TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS episode_likes(episode_id TEXT NOT NULL,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(episode_id,account_id));
      CREATE TABLE IF NOT EXISTS liked_episode_content(episode_id TEXT PRIMARY KEY,series_id TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS likes_account ON episode_likes(account_id,created_at,episode_id);
      CREATE TABLE IF NOT EXISTS episode_comments(id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,series_id TEXT NOT NULL,account_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'visible',created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS comments_episode ON episode_comments(episode_id,created_at);
      CREATE TABLE IF NOT EXISTS comment_reports(comment_id TEXT NOT NULL,account_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(comment_id,account_id));
      CREATE TABLE IF NOT EXISTS content_audit(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(content_series)').all().some(column=>column.name==='category_ids')) this.db.exec("ALTER TABLE content_series ADD COLUMN category_ids TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare('PRAGMA table_info(content_series)').all().some(column=>column.name==='creator_id')) {
      this.db.exec('ALTER TABLE content_series ADD COLUMN creator_id TEXT');
      // 旧内容只依据真实的首次保存记录恢复归属，缺少记录时保持未分配。
      this.db.exec("UPDATE content_series SET creator_id=(SELECT admin_id FROM content_audit WHERE target_id=content_series.id AND action='保存短剧' ORDER BY created_at,id LIMIT 1)");
    }
    this.db.prepare("UPDATE content_assets SET status='failed',error='处理被服务重启中断，请重新上传' WHERE status='processing'").run();
  }
  close() { this.db.close(); }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(admin, action, target, detail = {}) { this.db.prepare('INSERT INTO content_audit VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), admin.id, action, target, JSON.stringify(detail), Date.now()); }
  asset(id) { const row = this.db.prepare('SELECT * FROM content_assets WHERE id=?').get(id); return row ? { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null } : null; }
  row(id) { return this.db.prepare('SELECT * FROM content_series WHERE id=?').get(id) || null; }
  detail(id, preview = false) {
    const row = this.row(id);
    if (!row || (!preview && row.status !== 'published')) return null;
    const episodes = this.db.prepare('SELECT * FROM content_episodes WHERE series_id=? ORDER BY number').all(id).map(ep => ({ id: ep.id, number: ep.number, title: ep.title, assetId: ep.asset_id, vipRequired: ep.number > 3 }));
    return { id: row.id, title: row.title, cover: row.cover_id ? `/api/content/covers/${row.cover_id}` : '', description: row.description, tags: row.tags, categoryIds:row.category_ids.split(',').filter(Boolean), badge: `全${episodes.length}集`, contentType: row.content_type, language: row.language, status: row.status, coverId: row.cover_id, creatorId: preview ? row.creator_id : undefined, owned: true, episodes };
  }
  list({ preview = false, query = '', type = '', tag = '', tagLabel = tag, page = 1 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM content_series WHERE (?=1 OR status='published') AND (?='' OR title LIKE ? OR description LIKE ?) AND (?='' OR content_type=?) AND (?='' OR INSTR(','||category_ids||',',','||?||',')>0 OR tags LIKE ?) ORDER BY updated_at DESC LIMIT 24 OFFSET ?`).all(preview ? 1 : 0, query, `%${query}%`, `%${query}%`, type, type, tag, tag, `%${tagLabel}%`, (Math.max(1, Math.min(1000, Math.floor(Number(page)) || 1)) - 1) * 24);
    return rows.map(row => preview ? this.detail(row.id,true) : {
      id:row.id,title:row.title,cover:row.cover_id?`/api/content/covers/${row.cover_id}`:'',description:row.description,tags:row.tags,contentType:row.content_type,language:row.language,owned:true,
      badge:`全${this.db.prepare('SELECT COUNT(*) AS count FROM content_episodes WHERE series_id=?').get(row.id).count}集`,
    });
  }
  saveSeries(admin, input, id) {
    if (id && !this.row(id)) throw new AccountError(404, '短剧不存在');
    id ||= contentId();
    const title = textValue(input.title, '剧名'), description = textValue(input.description || '', '简介', 5000, true), tags = textValue(input.tags || '', '分类标签', 500, true);
    const categoryIds=input.categoryIds===undefined ? (this.row(id)?.category_ids || '').split(',').filter(Boolean) : input.categoryIds;
    if(!Array.isArray(categoryIds) || categoryIds.length>50 || categoryIds.some(id=>typeof id!=='string' || !/^[a-z0-9-]{1,80}$/.test(id)))throw new AccountError(400,'分类无效');
    if (!['real-drama', 'comic-drama', 'ai-drama'].includes(input.contentType)) throw new AccountError(400, '内容类型无效');
    if (!['en', 'es', 'pt-BR', 'ar', 'fr-CA', 'zh-CN'].includes(input.language)) throw new AccountError(400, '内容语言无效');
    const cover = input.coverId ? this.asset(input.coverId) : null;
    if (this.row(id)?.status === 'published' && !cover) throw new AccountError(400, '已上架短剧必须保留有效封面');
    if (input.coverId && (cover?.kind !== 'image' || cover.status !== 'ready')) throw new AccountError(400, '封面尚未上传完成');
    this.db.prepare(`INSERT INTO content_series(id,title,description,tags,content_type,language,cover_id,status,updated_at,category_ids) VALUES(?,?,?,?,?,?,?,'draft',?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,tags=excluded.tags,content_type=excluded.content_type,language=excluded.language,cover_id=excluded.cover_id,category_ids=excluded.category_ids,updated_at=excluded.updated_at`).run(id, title, description, tags, input.contentType, input.language, cover?.id || null, Date.now(), [...new Set(categoryIds)].join(','));
    this.audit(admin, '保存短剧', id, { title }); return this.detail(id, true);
  }
  assignCreator(admin, id, creatorId) {
    if (!this.row(id)) throw new AccountError(404, '短剧不存在');
    this.db.prepare('UPDATE content_series SET creator_id=? WHERE id=?').run(creatorId, id);
    this.audit(admin, '设置短剧创作者', id, { creatorId });
    return this.detail(id, true);
  }
  saveEpisode(admin, seriesId, input) {
    const series = this.row(seriesId), asset = this.asset(input.assetId);
    if (!series) throw new AccountError(404, '短剧不存在');
    if (series.status === 'published') throw new AccountError(409, '请先下架再调整分集');
    if (asset?.kind !== 'video' || asset.status !== 'ready') throw new AccountError(400, '视频尚未处理完成');
    if (!Number.isInteger(input.number) || input.number < 1 || input.number > 10000) throw new AccountError(400, '集数无效');
    const existing = this.db.prepare('SELECT id,asset_id FROM content_episodes WHERE series_id=? AND number=?').get(seriesId, input.number);
    // 批量导入只能新增；替换必须匹配管理员选中的原分集，重试同一素材保持幂等。
    if (input.mode !== 'replace' && existing && existing.asset_id !== asset.id) throw new AccountError(409, '该集已存在，请选择明确替换');
    if (input.mode === 'replace' && (!existing || (existing.asset_id !== asset.id && (existing.id !== input.expectedEpisodeId || existing.asset_id !== input.expectedAssetId)))) throw new AccountError(409, '原分集已变化，请重新选择替换');
    const id = existing?.id || contentId();
    this.db.prepare('INSERT INTO content_episodes VALUES(?,?,?,?,?) ON CONFLICT(series_id,number) DO UPDATE SET title=excluded.title,asset_id=excluded.asset_id').run(id, seriesId, input.number, textValue(input.title || `第${input.number}集`, '分集标题'), asset.id);
    this.audit(admin, '保存分集', id, { seriesId, number: input.number, assetId: asset.id }); return this.detail(seriesId, true);
  }
  publish(admin, id, status) {
    if (!['draft', 'published'].includes(status)) throw new AccountError(400, '发布状态无效');
    const detail = this.detail(id, true);
    if (!detail) throw new AccountError(404, '短剧不存在');
    if (status === 'published' && (!detail.coverId || !detail.episodes.length || detail.episodes.some((ep, index) => ep.number !== index + 1 || this.asset(ep.assetId)?.status !== 'ready'))) throw new AccountError(400, '发布前请上传封面，并补齐从第1集开始的连续分集');
    this.db.prepare('UPDATE content_series SET status=?,updated_at=? WHERE id=?').run(status, Date.now(), id);
    this.audit(admin, status === 'published' ? '发布短剧' : '下架短剧', id); return this.detail(id, true);
  }
  removeEpisode(admin, seriesId, episodeId) {
    if (this.row(seriesId)?.status !== 'draft') throw new AccountError(409, '请先下架再调整分集');
    this.db.prepare('DELETE FROM content_episodes WHERE id=? AND series_id=?').run(episodeId, seriesId);
    this.audit(admin, '移除分集', episodeId, { seriesId }); return this.detail(seriesId, true);
  }
  reorder(admin, seriesId, ids) {
    const detail = this.detail(seriesId, true);
    if (!detail || detail.status !== 'draft') throw new AccountError(409, '请先下架再调整分集');
    if (!Array.isArray(ids) || ids.length !== detail.episodes.length || new Set(ids).size !== ids.length || ids.some(id => !detail.episodes.some(ep => ep.id === id))) throw new AccountError(400, '分集排序无效');
    this.transaction(() => { this.db.prepare('UPDATE content_episodes SET number=-number WHERE series_id=?').run(seriesId); ids.forEach((id, index) => this.db.prepare('UPDATE content_episodes SET number=? WHERE id=?').run(index + 1, id)); this.audit(admin, '调整分集顺序', seriesId, { ids }); });
    return this.detail(seriesId, true);
  }
  interactions(episodeId, viewer) {
    return { likes: this.db.prepare('SELECT COUNT(*) AS count FROM episode_likes WHERE episode_id=?').get(episodeId).count, liked: !!viewer && !!this.db.prepare('SELECT 1 FROM episode_likes WHERE episode_id=? AND account_id=?').get(episodeId, viewer.id), comments: this.db.prepare("SELECT COUNT(*) AS count FROM episode_comments WHERE episode_id=? AND status='visible'").get(episodeId).count };
  }
  rememberLikedEpisode(series, episode) {
    const metadata = { id: String(series.id), title: series.title, cover: series.cover || '', badge: series.badge || '', tags: series.tags || '', description: series.description || '', contentType: series.contentType, episodeNumber: episode.number || series.episodes.findIndex(item => String(item.id) === String(episode.id)) + 1 };
    this.db.prepare('INSERT INTO liked_episode_content VALUES(?,?,?) ON CONFLICT(episode_id) DO UPDATE SET series_id=excluded.series_id,metadata=excluded.metadata').run(String(episode.id), String(series.id), JSON.stringify(metadata));
  }
  likedEpisodes(accountId, cursor = null, summary = false) {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM episode_likes WHERE account_id=?').get(accountId).count;
    if (summary) return { count };
    const match = cursor ? /^(\d{1,16}):(\d{1,40})$/.exec(cursor) : null;
    if (cursor && !match) throw new AccountError(400, '点赞分页无效');
    const before = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER, beforeId = match?.[2] || '';
    const rows = this.db.prepare(`SELECT l.*,m.series_id,m.metadata,e.series_id AS own_series_id FROM episode_likes l LEFT JOIN liked_episode_content m ON m.episode_id=l.episode_id LEFT JOIN content_episodes e ON e.id=l.episode_id WHERE l.account_id=? AND (l.created_at<? OR l.created_at=? AND l.episode_id<?) ORDER BY l.created_at DESC,l.episode_id DESC LIMIT 21`).all(accountId, before, before, beforeId);
    return { count, items: rows.slice(0,20).map(row => {
      let series = row.metadata ? JSON.parse(row.metadata) : null;
      const seriesId = row.series_id || row.own_series_id;
      const own = seriesId && this.row(seriesId);
      let available = !!series;
      if (own) {
        const current = this.detail(seriesId,true), episode = current.episodes.find(item => item.id === row.episode_id);
        series = { ...current, episodeNumber: episode?.number || series?.episodeNumber };
        available = own.status === 'published' && !!episode;
      }
      // 旧记录缺少内容归属时保留点赞，等待再次访问原分集补全，不能猜测剧名或播放地址。
      return { episodeId: row.episode_id, series: series ? { id:series.id,title:series.title,cover:available ? series.cover : '',badge:series.badge,tags:series.tags,description:series.description,contentType:series.contentType } : null, episodeNumber: series?.episodeNumber || null, available, createdAt: row.created_at };
    }), next: rows.length > 20 ? `${rows[19].created_at}:${rows[19].episode_id}` : null };
  }
}
