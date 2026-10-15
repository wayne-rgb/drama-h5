import crypto from 'node:crypto';
import { AccountError } from './account-store.mjs';
import { TeamStore } from './team-store.mjs';
import { createTeamService } from './team-routes.mjs';
import { TeamBusiness } from './team-business.mjs';
import { ContentStore, textValue } from './content-store.mjs';
import { createUploads } from './content-upload.mjs';
import { LocalMediaStorage } from './media-storage.mjs';
import { mp4PlaybackSource, hlsPlaybackSource, sendMedia } from './media-delivery.mjs';
import { Readable } from 'node:stream';
import { readJson } from '../shared/http-json.mjs';
import { ContentAnalytics } from './content-analytics.mjs';
import { CommentModeration } from './comment-moderation.mjs';
import { ContentAudit } from './content-audit.mjs';
import { CatalogCache } from './catalog-cache.mjs';
import { withContentSignal } from '../shared/content-request.mjs';
import {AnalyticsResource} from './analytics-resource.mjs';

const reply = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
export function createContentService(directory, accountStore, accounts, provider, config = process.env) {
  const store = new ContentStore(directory), storage = new LocalMediaStorage(directory, config), uploads = createUploads(store, directory, config, storage);
  const team = new TeamStore(store, directory, config), handleTeam = createTeamService(team, accounts, config);
  const business = new TeamBusiness(team, accountStore, uploads, directory, config);
  const isAdmin = user => !!user?.roles && team.owner(user);
  const contentViewer = req => team.viewer(req) || accounts.viewer(req);
  const preview = (user, id) => !!user?.roles && (team.owner(user) || !!team.db.prepare('SELECT 1 FROM team_series_members WHERE member_id=? AND series_id=?').get(user.id,id));
  const analytics = new ContentAnalytics(store, accountStore, accounts, isAdmin);
  analytics.team = team;
  const analyticsResource=new AnalyticsResource(store,directory,config);
  const requireAdmin = req => team.authorize(req, new URL(req.url, 'http://localhost'));
  const guardAsset = (req,id) => {
    if (!id) return;
    const member=team.require(req),asset=store.asset(id);
    if (!team.owner(member) && (!asset || !team.allowed(member,'editor',asset.series_id))) throw new AccountError(403,'没有此作品的操作权限');
  };
  const metadata = new CatalogCache(), rates = new Map();
  const limit = (req, user) => {
    const now = Date.now(); for (const [key, row] of rates) if (row.until < now) rates.delete(key);
    const key = user.id, row = rates.get(key) || { until: now + 60000, count: 0 };
    if (++row.count > 30 || rates.size >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试'); rates.set(key, row);
  };
  const detail = async (id, preview = false, actor = '') => {
    if (!/^\d{1,40}$/.test(id || '')) throw new AccountError(400, '短剧标识无效');
    if (store.row(id)) { const data = store.detail(id, preview); if (!data) throw new AccountError(404, '短剧未上架'); return data; }
    // 同一剧的目录请求由多位观众复用，取消某个播放不能取消共享详情。
    return metadata.read(id, () => withContentSignal(undefined, async () => {
    const value = await provider.detail(id);
    if (!value || String(value.id) !== id || !Array.isArray(value.episodes)) throw new AccountError(502, '剧集信息暂不可用');
    return value;
    }), false, actor);
  };
  const resolveEpisode = async (req, seriesId, episodeId, enforce = true) => {
    const initial = contentViewer(req), series = await detail(seriesId, preview(initial,seriesId), accounts.address(req));
    // 外部目录可能等待网络，权限必须以等待结束后的会话和会员状态为准。
    const viewer = contentViewer(req);
    if (initial && initial.id !== viewer?.id) throw new AccountError(409, '登录状态已变化，请刷新页面');
    if (series.owned && series.status !== 'published' && !preview(viewer,seriesId)) throw new AccountError(404, '短剧未上架');
    const index = series.episodes.findIndex(ep => String(ep.id) === episodeId);
    if (index < 0) throw new AccountError(404, '分集不属于此短剧');
    const required = index >= 3;
    if (enforce && required && !preview(viewer,seriesId) && !accountStore.membership(viewer?.id || '').active) throw new AccountError(403, 'VIP_REQUIRED');
    const audience=accounts.audience(req);
    let checkedAt = 0;
    const revalidate = (force = false) => {
      const now = Date.now();
      if (!force && now - checkedAt < 1000) return;
      const current = contentViewer(req),currentAudience=accounts.audience(req);
      if(audience&&(!currentAudience||currentAudience.id!==audience.id||!!currentAudience.guest!==!!audience.guest))throw new AccountError(401,'请刷新页面后重试');
      const administrator=preview(current,seriesId),member=!!current&&accountStore.membership(current.id).active;
      req.playbackPrivileged=administrator||member;
      let currentRequired=required;
      if(series.owned){
        const row=store.row(series.id),episode=store.db.prepare('SELECT number,asset_id FROM content_episodes WHERE id=? AND series_id=?').get(episodeId,series.id);
        if(!row || row.status!=='published'&&!administrator)throw new AccountError(404,'短剧未上架');
        if(!episode)throw new AccountError(404,'分集不属于此短剧');
        // 重新发布后使用当前集序复核免费资格，替换素材也不能继续发送旧视频。
        if(enforce&&episode.asset_id!==series.episodes[index].assetId)throw new AccountError(409,'视频源暂不可用，请重试');
        currentRequired=episode.number>3;
      }
      if (enforce && currentRequired && !administrator && (!current || current.id !== viewer?.id || !member)) throw new AccountError(403, 'VIP_REQUIRED');
      checkedAt = now;
    };
    revalidate(true);
    if(enforce)req.revalidatePlayback=revalidate;
    return { series, episode: series.episodes[index], viewer, required, revalidate };
  };
  const commentModeration = new CommentModeration(store, detail);
  const contentAudit = new ContentAudit(store,accountStore);
  const streamFile = (req, res, asset, quality, cover = false, publicCover = false, revalidateCover) => {
    sendMedia(req, res, storage.locate(store, asset), asset, { quality, cover, publicCover, revalidateCover });
  };
  return {
    store, team, detail, resolveEpisode, analytics,
    close: () => { const pending = uploads.close(); store.close(); return pending; },
    publicDetail: async (req, id) => {
      const initial=contentViewer(req),value=await detail(id,preview(initial,id),accounts.address(req)),user=contentViewer(req);
      if(value.owned){
        const privatePreview=value.status!=='published',previous=req.revalidateAccess;
        req.revalidateAccess=()=>{
          previous?.();
          const current=contentViewer(req),row=store.row(id);
          if(privatePreview){accounts.sameOrigin(req);if(!initial||current?.id!==initial.id||!preview(current,id))throw new AccountError(404,'短剧未上架');}
          if(!row||row.status!=='published'&&!preview(current,id))throw new AccountError(404,'短剧未上架');
        };
        req.revalidateAccess();
      }
      const vip=preview(user,id)||accountStore.membership(user?.id||'').active;
      const {creatorId,...publicValue}=value;
      return {...publicValue,episodes:value.episodes.map((ep,index)=>({id:ep.id,number:ep.number,title:ep.title,vipRequired:index>=3,locked:index>=3&&!vip}))};
    },
    list: options => store.list(options),
    merge: (items, options = {}) => [...store.list(options), ...items].filter((item, index, all) => all.findIndex(row => row.id === item.id) === index),
    async ownPlayback(req, res, kind, resolved) {
      if (!store.row(resolved.series.id)) return false;
      const asset = store.asset(resolved.episode.assetId);
      if (asset?.status !== 'ready') throw new AccountError(503, '视频尚未处理完成');
      const quality = `${Math.min(asset.metadata.width, asset.metadata.height)}P`;
      const requested = new URL(req.url,'http://localhost').searchParams.get('quality');
      const job = store.hlsJob(asset.id);
      if (kind === 'hls') {
        const match = /^\/api\/episodes\/\d+\/hls\/([a-f0-9-]{36})\/([^/]+)$/.exec(new URL(req.url, 'http://localhost').pathname);
        if (!match || job?.status !== 'ready' || match[1] !== job.version) throw new AccountError(404, '视频源暂不可用，请重试');
        const previous = req.revalidatePlayback;
        req.revalidatePlayback = force => { previous?.(force); const current = store.hlsJob(asset.id); if (current?.status !== 'ready' || current.version !== job.version) throw new AccountError(409, '视频源暂不可用，请重试'); };
        const name = match[2], resource = storage.locateRendition(job, name);
        if (name.endsWith('.m3u8')) {
          const chunks = []; for await (const chunk of resource.open()) chunks.push(chunk);
          const text = Buffer.concat(chunks).toString('utf8').split('\n').map(line => line && !line.startsWith('#') ? `${line}?${new URLSearchParams({ seriesId: resolved.series.id })}` : line).join('\n');
          const bytes = Buffer.from(text);
          sendMedia(req, res, { ...resource, stat: { ...resource.stat, size: bytes.length }, open: ({ start, end }) => Readable.from([bytes.subarray(start, end + 1)]) }, { ...asset, mime: 'application/vnd.apple.mpegurl' });
        } else sendMedia(req, res, resource, { ...asset, mime: 'video/mp2t', metadata: { duration: 4 } });
        return true;
      }
      if (job?.status === 'ready' && kind !== 'stream') {
        const levels = job.manifest.levels;
        // MP4校验与HLS完成可能跨过两次请求，按当前成品选择实际可用档位。
        const selected = requested && levels.some(level => level.key === requested) ? requested : 'auto';
        resolved.revalidate(true);
        if (kind === 'qualities') reply(res, { episodeId: resolved.episode.id, defaultQuality: 'auto', qualities: [{ key: 'auto', label: 'auto', qualityNum: 0, isDefault: true }, ...levels.map(level => ({ key: level.key, label: level.key, qualityNum: level.size, codec: 'H.264', isDefault: false }))] });
        else reply(res, hlsPlaybackSource(resolved.episode.id, resolved.series.id, selected, job));
        return true;
      }
      if (kind!=='qualities' && requested && requested!=='auto' && requested!==quality) throw new AccountError(400,'当前视频不支持所选画质');
      if (kind === 'qualities') reply(res, { episodeId: resolved.episode.id, defaultQuality: quality, qualities: [{ key: quality, label: quality, qualityNum: Math.min(asset.metadata.width, asset.metadata.height), codec: 'H.264', isDefault: true }] });
      else if (kind === 'play') {
        const resource = storage.locate(store, asset);
        resolved.revalidate(true);
        reply(res, mp4PlaybackSource(resolved.episode.id, resolved.series.id, quality, resource.location.version));
      }
      else streamFile(req, res, asset, quality);
      return true;
    },
    async handle(req, res, url) {
      if (await handleTeam(req,res,url)) return true;
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
      const input = async () => { if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AccountError(415, '请求格式无效'); try { const data=await readJson(req);req.revalidateAccess?.();if(adminRoute)requireAdmin(req);return data; } catch (error) { if (error instanceof AccountError) throw error; throw new AccountError(error.status || 400, error.status === 408 ? '请求读取超时，请稍后重试' : '请求格式无效'); } };
      if (analyticsRoute) {
        if (['/api/analytics/sessions','/api/analytics/progress'].includes(route) && req.method==='POST' && team.viewer(req)) { await input();reply(res,{excluded:true});return true; }
        if (route === '/api/analytics/sessions' && req.method === 'POST') reply(res, analyticsResource.start(analytics,req, await input()));
        else if (route === '/api/analytics/progress' && req.method === 'POST') reply(res, analytics.progress(req, await input()));
        else if (route === '/api/analytics/series' && req.method === 'GET') reply(res, analytics.series(req));
        else if (route === '/api/analytics/report' && req.method === 'GET') reply(res, analytics.report(req, url.searchParams));
        else throw new AccountError(404, '页面不存在');
        return true;
      }
      if (cover && ['GET', 'HEAD'].includes(req.method)) {
        accounts.sameOrigin(req);
        const asset = store.asset(cover[1]);
        let checkedAt=0;
        const revalidateCover=(force=false)=>{
          if(!force&&Date.now()-checkedAt<1000)return;
          const published=store.db.prepare("SELECT 1 FROM content_series WHERE cover_id=? AND status='published'").get(cover[1]);
          const user=team.viewer(req),creatorCover=user&&store.db.prepare('SELECT id FROM content_series WHERE cover_id=?').all(cover[1]).some(row=>preview(user,row.id));
          if(asset?.kind!=='image'||asset.status!=='ready'||!published&&!isAdmin(user)&&!creatorCover)throw new AccountError(404,'封面不存在');
          checkedAt=Date.now();return !!published;
        };
        const published=revalidateCover(true);
        streamFile(req, res, asset, undefined, true, published, revalidateCover); return true;
      }
      if (adminRoute) {
        const admin = requireAdmin(req);
        business.flush();
        const offset = (Math.max(1,Math.min(1000,Math.floor(Number(url.searchParams.get('page')))||1))-1)*100;
        const retryHls = /^\/api\/admin\/uploads\/([a-f0-9-]{36})\/hls\/retry$/.exec(route);
        if (retryHls && req.method === 'POST') { await input(); const data=store.transaction(()=>{const result=uploads.retryHls(retryHls[1]);store.audit(admin,'重试HLS转码',retryHls[1]);return result;});reply(res,data);return true; }
        const verifyUpload=/^\/api\/admin\/uploads\/([a-f0-9-]{36})\/verify$/.exec(route);
        if(verifyUpload&&req.method==='POST'){await uploads.verifySource(req,admin,verifyUpload[1],await input());reply(res,business.asset(verifyUpload[1]));return true;}
        const upload = /^\/api\/admin\/uploads\/([a-f0-9-]+)$/.exec(route), series = /^\/api\/admin\/series\/(\d+)(?:\/(episodes|publish|reorder)(?:\/(\d+))?)?$/.exec(route), moderation = /^\/api\/admin\/comments\/([a-f0-9-]+)$/.exec(route);
        if (route === '/api/admin/series' && req.method === 'GET') reply(res, { items: store.list({ preview: true, query: url.searchParams.get('q') || '', page: url.searchParams.get('page'), memberId: team.owner(admin) ? '' : admin.id }) });
        else if (route === '/api/admin/series' && req.method === 'POST') { const data=await input();guardAsset(req,data.coverId);reply(res, store.saveSeries(admin, data)); }
        else if (series && req.method === 'GET' && !series[2]) {
          const data = store.detail(series[1], true); if (!data) throw new AccountError(404, '短剧不存在');
          const ids=[data.coverId,...data.episodes.map(ep=>ep.assetId),...store.db.prepare('SELECT id FROM content_assets WHERE series_id=? ORDER BY created_at DESC LIMIT 100').all(series[1]).map(row=>row.id)];
          reply(res,{...data,assets:[...new Set(ids.filter(Boolean))].map(id=>business.asset(id)).filter(Boolean)});
        }
        else if (series && req.method === 'POST') {
          const data = await input();
          if (series[2] === 'episodes') {
            guardAsset(req,data.assetId);
            const previous=store.db.prepare('SELECT id FROM content_episodes WHERE series_id=? AND number=?').get(series[1],data.number);
            if(previous)analytics.rememberVersion(previous.id);
            const result=store.saveEpisode(admin,series[1],data);
            for(const episode of result.episodes)analytics.rememberVersion(episode.id);
            reply(res,result);
          } else { if (!series[2]) guardAsset(req,data.coverId); reply(res,!series[2] ? store.saveSeries(admin,data,series[1]) : series[2] === 'publish' ? store.publish(admin,series[1],data.status) : store.reorder(admin,series[1],data.ids)); }
        }
        else if (series?.[2] === 'episodes' && series[3] && req.method === 'DELETE') { analytics.rememberVersion(series[3]); reply(res, store.removeEpisode(admin, series[1], series[3])); }
        else if (route === '/api/admin/uploads' && req.method === 'POST') { const data = await input(); team.requireSeries(req,'editor',data.seriesId); reply(res, uploads.create(admin, data)); }
        else if (route === '/api/admin/uploads' && req.method === 'GET') {
          const seriesId=url.searchParams.get('seriesId')||'';
          if(seriesId)team.requireSeries(req,'editor',seriesId);
          const pending=url.searchParams.get('pending')==='1';
          const rows=store.db.prepare("SELECT a.id FROM content_assets a WHERE (?=1 OR EXISTS(SELECT 1 FROM team_series_members t WHERE t.series_id=a.series_id AND t.member_id=?)) AND (?='' OR a.series_id=?) AND (?=0 OR a.status IN ('uploading','processing')) ORDER BY a.created_at DESC,a.id LIMIT 101 OFFSET ?").all(team.owner(admin)?1:0,admin.id,seriesId,seriesId,pending?1:0,offset);
          reply(res,{items:rows.slice(0,100).map(row=>business.asset(row.id)),hasMore:rows.length>100,maximum:uploads.maximum});
        }
        else if (upload && req.method === 'PUT') {await uploads.chunk(req, admin, upload[1]);reply(res,business.asset(upload[1]));}
        else if (upload && req.method === 'DELETE') {await uploads.cancel(admin, upload[1],req.headers['x-upload-revision']);reply(res,business.asset(upload[1]));}
        else if (upload && req.method === 'GET') { const asset = store.asset(upload[1]); if (!asset || !team.owner(admin) && !team.allowed(admin,'editor',asset.series_id)) throw new AccountError(404, '上传不存在'); reply(res, business.asset(asset.id)); }
        else if (route === '/api/admin/accounts' && req.method === 'GET') { const query = String(url.searchParams.get('q') || '').slice(0, 200); reply(res, { items: accountStore.db.prepare('SELECT * FROM accounts WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 100 OFFSET ?').all(`%${query}%`, `%${query}%`,offset).map(user => accountStore.publicAccount(user)) }); }
        else if (route === '/api/admin/membership' && req.method === 'POST') {
          const data = await input(), user = accountStore.byId(data.accountId); if (!user) throw new AccountError(404, '账户不存在');
          const reason = textValue(data.reason, '操作原因', 500), end = data.revoke ? 0 : Number(data.periodEnd);
          if (!data.revoke && (!Number.isSafeInteger(end) || end <= Date.now() || end > Date.now() + 5 * 366 * 86400000)) throw new AccountError(400, '会员有效期无效');
          const previous=accountStore.db.prepare('SELECT period_end FROM account_manual_vip WHERE account_id=?').get(user.id);
          if (!data.revoke && previous?.period_end > end) throw new AccountError(400,'新有效期不能早于当前手动会员有效期');
          business.recordMembership(admin,user,end,reason,!!data.revoke); reply(res, { user: accountStore.publicAccount(user) });
        }
        else if (route === '/api/admin/comment-series' && req.method === 'GET') { const data=await commentModeration.series(url.searchParams,team.owner(admin)?'':admin.id);req.revalidateAccess?.();requireAdmin(req);reply(res,data); }
        else if (route === '/api/admin/comments' && req.method === 'GET') { const data=await commentModeration.comments(url.searchParams);req.revalidateAccess?.();requireAdmin(req);reply(res,{...data,items:data.items.map(({account_id,...row})=>({...row,author:accountStore.byId(account_id)?.name || '—'}))}); }
        else if (moderation && req.method === 'POST') { const data = await input(); if (!['visible', 'hidden', 'deleted'].includes(data.status)) throw new AccountError(400, '评论状态无效'); store.transaction(()=>{const changed=store.db.prepare('UPDATE episode_comments SET status=? WHERE id=?').run(data.status, moderation[1]);if(!changed.changes)throw new AccountError(404,'评论不存在');store.audit(admin, '处理评论', moderation[1], { status: data.status });}); reply(res, { ok: true }); }
        else if (route === '/api/admin/audit-series' && req.method === 'GET') reply(res,contentAudit.series(url.searchParams));
        else if (route === '/api/admin/audit' && req.method === 'GET') reply(res,contentAudit.logs(url.searchParams));
        else throw new AccountError(404, '管理接口不存在');
        return true;
      }
      const viewer = accounts.viewer(req);
      if (social) {
        const resolved = await resolveEpisode(req, url.searchParams.get('seriesId'), social[1], false);
        // 正文等待期间可能下架或移除分集，互动写入和延迟响应也要复核当前内容资格。
        const previous=req.revalidateAccess;
        req.revalidateAccess=()=>{previous?.();resolved.revalidate(true);};
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
