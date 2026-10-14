import fs from 'node:fs';
import crypto from 'node:crypto';
import { AccountError } from './account-store.mjs';
import { isAdministrator } from './account-role.mjs';
import { ContentStore, textValue } from './content-store.mjs';
import { createUploads } from './content-upload.mjs';
import { readJson } from '../shared/http-json.mjs';
import { ContentAnalytics } from './content-analytics.mjs';
import { CommentModeration } from './comment-moderation.mjs';

const reply = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
export function createContentService(directory, accountStore, accounts, provider, config = process.env) {
  const store = new ContentStore(directory), uploads = createUploads(store, directory, config);
  const isAdmin = user => isAdministrator(user, config);
  const analytics = new ContentAnalytics(store, accountStore, accounts, isAdmin);
  const requireAdmin = req => { const user = accounts.requireViewer(req); if (!isAdmin(user)) throw new AccountError(403, '需要管理员权限'); return user; };
  const metadata = new Map(), rates = new Map();
  const limit = (req, user) => {
    const now = Date.now(); for (const [key, row] of rates) if (row.until < now) rates.delete(key);
    const key = user.id, row = rates.get(key) || { until: now + 60000, count: 0 };
    if (++row.count > 30 || rates.size >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试'); rates.set(key, row);
  };
  const detail = async (id, preview = false) => {
    if (!/^\d{1,40}$/.test(id || '')) throw new AccountError(400, '短剧标识无效');
    if (store.row(id)) { const data = store.detail(id, preview); if (!data) throw new AccountError(404, '短剧未上架'); return data; }
    const cached = metadata.get(id);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = await provider.detail(id);
    if (!value || String(value.id) !== id || !Array.isArray(value.episodes)) throw new AccountError(502, '剧集信息暂不可用');
    if (metadata.size >= 300) metadata.delete(metadata.keys().next().value);
    metadata.set(id, { value, until: Date.now() + 60000 }); return value;
  };
  const resolveEpisode = async (req, seriesId, episodeId, enforce = true) => {
    const viewer = accounts.viewer(req), series = await detail(seriesId, isAdmin(viewer));
    const index = series.episodes.findIndex(ep => String(ep.id) === episodeId);
    if (index < 0) throw new AccountError(404, '分集不属于此短剧');
    const required = index >= 3;
    if (enforce && required && !isAdmin(viewer) && !accountStore.membership(viewer?.id || '').active) throw new AccountError(403, 'VIP_REQUIRED');
    return { series, episode: series.episodes[index], viewer, required };
  };
  const commentModeration = new CommentModeration(store, detail);
  const streamFile = (req, res, asset, quality) => {
    const filename = uploads.filePath(asset.id), stat = fs.statSync(filename);
    let start = 0, end = stat.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || !match[1] && !match[2]) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
      start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2])); end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); } status = 206;
    }
    res.writeHead(status, { 'Content-Type': asset.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...(quality ? {'X-Video-Quality':quality} : {}), ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filename, { start, end }); res.once('close', () => stream.destroy()); stream.once('error', () => res.destroy()); stream.pipe(res);
  };
  return {
    store, detail, resolveEpisode, analytics,
    close: () => { uploads.close(); store.close(); },
    publicDetail: async (req, id) => { const user = accounts.viewer(req), value = await detail(id,isAdmin(user)), vip = isAdmin(user) || accountStore.membership(user?.id || '').active; return { ...value, episodes: value.episodes.map((ep, index) => ({ id: ep.id, number: ep.number, title: ep.title, vipRequired: index >= 3, locked: index >= 3 && !vip })) }; },
    list: options => store.list(options),
    merge: (items, options = {}) => [...store.list(options), ...items].filter((item, index, all) => all.findIndex(row => row.id === item.id) === index),
    async ownPlayback(req, res, kind, resolved) {
      if (!store.row(resolved.series.id)) return false;
      const asset = store.asset(resolved.episode.assetId);
      if (asset?.status !== 'ready') throw new AccountError(503, '视频尚未处理完成');
      const quality = `${Math.min(asset.metadata.width, asset.metadata.height)}P`;
      const requested = new URL(req.url,'http://localhost').searchParams.get('quality');
      if (kind!=='qualities' && requested && requested!=='auto' && requested!==quality) throw new AccountError(400,'当前视频不支持所选画质');
      if (kind === 'qualities') reply(res, { episodeId: resolved.episode.id, defaultQuality: quality, qualities: [{ key: quality, label: quality, qualityNum: Math.min(asset.metadata.width, asset.metadata.height), codec: 'H.264', isDefault: true }] });
      else if (kind === 'play') reply(res, { path: `/api/episodes/${resolved.episode.id}/stream?seriesId=${resolved.series.id}`, contentType: 'video/mp4' });
      else streamFile(req, res, asset, quality);
      return true;
    },
    async handle(req, res, url) {
      const route = url.pathname, adminRoute = route.startsWith('/api/admin/');
      const social = /^\/api\/episodes\/(\d+)\/(interactions|likes|comments)$/.exec(route);
      const comment = /^\/api\/comments\/([a-f0-9-]+)(\/report)?$/.exec(route);
      const cover = /^\/api\/content\/covers\/([a-f0-9-]+)$/.exec(route);
      const myLikes = route === '/api/me/likes', removeLike = /^\/api\/me\/likes\/(\d{1,40})$/.exec(route);
      const analyticsRoute = route.startsWith('/api/analytics/');
      if (!adminRoute && !analyticsRoute && !social && !comment && !cover && !myLikes && !removeLike) return false;
      if (!['GET', 'HEAD'].includes(req.method)) accounts.sameOrigin(req);
      if (myLikes && req.method === 'GET') { const user = accounts.requireViewer(req); reply(res, store.likedEpisodes(user.id,url.searchParams.get('before'),url.searchParams.get('summary') === '1')); return true; }
      if (removeLike && req.method === 'POST') { const user = accounts.requireViewer(req); limit(req,user); const episode = store.db.prepare('SELECT series_id FROM content_episodes WHERE id=?').get(removeLike[1]); store.transaction(()=>{const removed=store.db.prepare('DELETE FROM episode_likes WHERE episode_id=? AND account_id=?').run(removeLike[1],user.id); if(removed.changes && episode)analytics.feedback(episode.series_id,removeLike[1],'unlike');}); reply(res,{count:store.likedEpisodes(user.id,null,true).count}); return true; }
      if (myLikes || removeLike) throw new AccountError(405,'请求方式无效');
      const input = async () => { if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AccountError(415, '请求格式无效'); try { return await readJson(req); } catch { throw new AccountError(400, '请求格式无效'); } };
      if (analyticsRoute) {
        if (route === '/api/analytics/sessions' && req.method === 'POST') reply(res, analytics.start(req, await input()));
        else if (route === '/api/analytics/progress' && req.method === 'POST') reply(res, analytics.progress(req, await input()));
        else if (route === '/api/analytics/series' && req.method === 'GET') reply(res, analytics.series(req));
        else if (route === '/api/analytics/report' && req.method === 'GET') reply(res, analytics.report(req, url.searchParams));
        else throw new AccountError(404, '页面不存在');
        return true;
      }
      if (cover && ['GET', 'HEAD'].includes(req.method)) {
        const asset = store.asset(cover[1]), published = store.db.prepare("SELECT 1 FROM content_series WHERE cover_id=? AND status='published'").get(cover[1]);
        const user=accounts.viewer(req), creatorCover=user&&accountStore.isCreator(user.id)&&store.db.prepare('SELECT 1 FROM content_series WHERE cover_id=? AND creator_id=?').get(cover[1],user.id);
        if (asset?.kind !== 'image' || asset.status !== 'ready' || !published && !isAdmin(user) && !creatorCover) throw new AccountError(404, '封面不存在');
        streamFile(req, res, asset); return true;
      }
      if (adminRoute) {
        const admin = requireAdmin(req);
        if (route === '/api/admin/creators' && req.method === 'GET') { reply(res, {items:accountStore.db.prepare('SELECT a.* FROM accounts a JOIN account_creators c ON c.account_id=a.id ORDER BY a.name').all().map(user=>accountStore.publicAccount(user))}); return true; }
        if (route === '/api/admin/creators' && req.method === 'POST') {
          const data=await input(), user=accountStore.byId(data.accountId);
          if (!user || typeof data.enabled!=='boolean') throw new AccountError(400,'创作者账户无效');
          if (data.enabled) accountStore.db.prepare('INSERT OR IGNORE INTO account_creators VALUES(?,?,?)').run(user.id,admin.id,Date.now());
          else accountStore.db.prepare('DELETE FROM account_creators WHERE account_id=?').run(user.id);
          store.audit(admin,data.enabled?'授予创作者权限':'撤销创作者权限',user.id); reply(res,{ok:true}); return true;
        }
        const assignment=/^\/api\/admin\/series\/(\d+)\/creator$/.exec(route);
        if (assignment && req.method==='POST') {
          const data=await input();
          if (data.creatorId!==null && !accountStore.isCreator(data.creatorId)) throw new AccountError(400,'创作者账户无效');
          reply(res,store.assignCreator(admin,assignment[1],data.creatorId)); return true;
        }
        const offset = (Math.max(1,Math.min(1000,Math.floor(Number(url.searchParams.get('page')))||1))-1)*100;
        const upload = /^\/api\/admin\/uploads\/([a-f0-9-]+)$/.exec(route), series = /^\/api\/admin\/series\/(\d+)(?:\/(episodes|publish|reorder)(?:\/(\d+))?)?$/.exec(route), moderation = /^\/api\/admin\/comments\/([a-f0-9-]+)$/.exec(route);
        if (route === '/api/admin/series' && req.method === 'GET') reply(res, { items: store.list({ preview: true, query: url.searchParams.get('q') || '', page: url.searchParams.get('page') }) });
        else if (route === '/api/admin/series' && req.method === 'POST') reply(res, store.saveSeries(admin, await input()));
        else if (series && req.method === 'GET' && !series[2]) { const data = store.detail(series[1], true); if (!data) throw new AccountError(404, '短剧不存在'); reply(res, {...data,assets:[...new Set([data.coverId,...data.episodes.map(ep=>ep.assetId)])].filter(Boolean).map(id=>store.asset(id)).filter(Boolean)}); }
        else if (series && req.method === 'POST') {
          const data = await input();
          if (series[2] === 'episodes') {
            const previous=store.db.prepare('SELECT id FROM content_episodes WHERE series_id=? AND number=?').get(series[1],data.number);
            if(previous)analytics.rememberVersion(previous.id);
            const result=store.saveEpisode(admin,series[1],data);
            for(const episode of result.episodes)analytics.rememberVersion(episode.id);
            reply(res,result);
          } else reply(res,!series[2] ? store.saveSeries(admin,data,series[1]) : series[2] === 'publish' ? store.publish(admin,series[1],data.status) : store.reorder(admin,series[1],data.ids));
        }
        else if (series?.[2] === 'episodes' && series[3] && req.method === 'DELETE') { analytics.rememberVersion(series[3]); reply(res, store.removeEpisode(admin, series[1], series[3])); }
        else if (route === '/api/admin/uploads' && req.method === 'POST') reply(res, uploads.create(admin, await input()));
        else if (route === '/api/admin/uploads' && req.method === 'GET') reply(res, { items: store.db.prepare('SELECT id FROM content_assets ORDER BY created_at DESC LIMIT 100 OFFSET ?').all(offset).map(row => store.asset(row.id)), maximum: uploads.maximum });
        else if (upload && req.method === 'PUT') reply(res, await uploads.chunk(req, admin, upload[1]));
        else if (upload && req.method === 'DELETE') reply(res, await uploads.cancel(admin, upload[1]));
        else if (upload && req.method === 'GET') { const asset = store.asset(upload[1]); if (!asset) throw new AccountError(404, '上传不存在'); reply(res, asset); }
        else if (route === '/api/admin/accounts' && req.method === 'GET') { const query = String(url.searchParams.get('q') || '').slice(0, 200); reply(res, { items: accountStore.db.prepare('SELECT * FROM accounts WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 100 OFFSET ?').all(`%${query}%`, `%${query}%`,offset).map(user => accountStore.publicAccount(user)) }); }
        else if (route === '/api/admin/membership' && req.method === 'POST') {
          const data = await input(), user = accountStore.byId(data.accountId); if (!user) throw new AccountError(404, '账户不存在');
          const reason = textValue(data.reason, '操作原因', 500), end = data.revoke ? 0 : Number(data.periodEnd);
          if (!data.revoke && (!Number.isSafeInteger(end) || end <= Date.now() || end > Date.now() + 5 * 366 * 86400000)) throw new AccountError(400, '会员有效期无效');
          const previous=accountStore.db.prepare('SELECT period_end FROM account_manual_vip WHERE account_id=?').get(user.id);
          if (!data.revoke && previous?.period_end > end) throw new AccountError(400,'新有效期不能早于当前手动会员有效期');
          accountStore.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET period_end=excluded.period_end,admin_id=excluded.admin_id,reason=excluded.reason,updated_at=excluded.updated_at').run(user.id, end, admin.id, reason, Date.now());
          store.audit(admin, data.revoke ? '撤销手动会员' : '开通手动会员', user.id, { periodEnd: end, reason }); reply(res, { user: accountStore.publicAccount(user) });
        }
        else if (route === '/api/admin/comment-series' && req.method === 'GET') reply(res, await commentModeration.series(url.searchParams));
        else if (route === '/api/admin/comments' && req.method === 'GET') { const data=await commentModeration.comments(url.searchParams); reply(res,{...data,items:data.items.map(({account_id,...row})=>({...row,author:accountStore.byId(account_id)?.name || '—'}))}); }
        else if (moderation && req.method === 'POST') { const data = await input(); if (!['visible', 'hidden', 'deleted'].includes(data.status)) throw new AccountError(400, '评论状态无效'); store.db.prepare('UPDATE episode_comments SET status=? WHERE id=?').run(data.status, moderation[1]); store.audit(admin, '处理评论', moderation[1], { status: data.status }); reply(res, { ok: true }); }
        else if (route === '/api/admin/audit' && req.method === 'GET') reply(res, { items: store.db.prepare('SELECT * FROM content_audit ORDER BY created_at DESC LIMIT 100 OFFSET ?').all(offset) });
        else throw new AccountError(404, '管理接口不存在');
        return true;
      }
      const viewer = accounts.viewer(req);
      if (social) {
        const resolved = await resolveEpisode(req, url.searchParams.get('seriesId'), social[1], false);
        if (store.db.prepare('SELECT 1 FROM episode_likes WHERE episode_id=?').get(social[1])) store.rememberLikedEpisode(resolved.series,resolved.episode);
        if (social[2] === 'interactions' && req.method === 'GET') reply(res, store.interactions(social[1], viewer));
        else if (social[2] === 'likes' && req.method === 'POST') { const user = accounts.requireViewer(req); limit(req, user); const data = await input(); if (typeof data.liked !== 'boolean') throw new AccountError(400, '点赞状态无效'); store.transaction(() => { if (data.liked) store.rememberLikedEpisode(resolved.series,resolved.episode); const changed=data.liked ? store.db.prepare('INSERT OR IGNORE INTO episode_likes VALUES(?,?,?)').run(social[1],user.id,Date.now()) : store.db.prepare('DELETE FROM episode_likes WHERE episode_id=? AND account_id=?').run(social[1],user.id); if(changed.changes)analytics.feedback(resolved.series.id,social[1],data.liked?'like':'unlike'); }); reply(res, store.interactions(social[1], user)); }
        else if (social[2] === 'comments' && req.method === 'GET') {
          const cursor = url.searchParams.get('before');
          const match = cursor ? /^(\d{1,16})(?::([a-f0-9-]{36}))?$/.exec(cursor) : null;
          if (cursor && !match) throw new AccountError(400,'评论分页无效');
          const before = match ? Number(match[1]) : Date.now()+1, beforeId = match?.[2] || '';
          const rows = store.db.prepare("SELECT * FROM episode_comments WHERE episode_id=? AND status='visible' AND (created_at<? OR created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT 31").all(social[1], before, before, beforeId);
          reply(res, { items: rows.slice(0,30).map(row => ({ id: row.id, body: row.body, author: accountStore.byId(row.account_id)?.name || '—', own: viewer?.id === row.account_id, createdAt: row.created_at })), next: rows.length > 30 ? `${rows[29].created_at}:${rows[29].id}` : null });
        } else if (social[2] === 'comments' && req.method === 'POST') { const user = accounts.requireViewer(req); limit(req, user); const data = await input(), body = textValue(data.body, '评论', 1000); const id = crypto.randomUUID(); store.transaction(()=>{commentModeration.remember(resolved.series);store.db.prepare('INSERT INTO episode_comments(id,episode_id,series_id,account_id,body,created_at) VALUES(?,?,?,?,?,?)').run(id, social[1], url.searchParams.get('seriesId'), user.id, body, Date.now());analytics.feedback(resolved.series.id,social[1],'comment');}); reply(res, { id }); }
        else throw new AccountError(405, '请求方式无效');
        return true;
      }
      if (comment) {
        const user = accounts.requireViewer(req); limit(req, user); const row = store.db.prepare("SELECT * FROM episode_comments WHERE id=? AND status='visible'").get(comment[1]); if (!row) throw new AccountError(404, '评论不存在');
        if (comment[2] && req.method === 'POST') { await input(); store.db.prepare('INSERT OR IGNORE INTO comment_reports VALUES(?,?,?)').run(row.id, user.id, Date.now()); }
        else if (!comment[2] && req.method === 'DELETE' && row.account_id === user.id) store.db.prepare("UPDATE episode_comments SET status='deleted' WHERE id=?").run(row.id);
        else throw new AccountError(403, '不能修改他人的评论');
        reply(res, { ok: true }); return true;
      }
      throw new AccountError(405, '请求方式无效');
    },
  };
}
