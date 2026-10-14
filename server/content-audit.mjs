import { AccountError } from './account-store.mjs';

const contentActions = ['保存短剧','发布短剧','下架短剧','设置短剧创作者','保存分集','移除分集','调整分集顺序','完成文件上传','处理评论'];
const seriesActions = new Set(['保存短剧','发布短剧','下架短剧','设置短剧创作者','调整分集顺序']);
const actionSlots = contentActions.map(()=>'?').join(',');
const readDetail = row => { try { return JSON.parse(row.detail); } catch { return {}; } };
const hasTable = (db,name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function seriesTitleAt(store,seriesId,at,sequence) {
  const saved=store.db.prepare("SELECT detail FROM content_audit WHERE action='保存短剧' AND target_id=? AND (created_at<? OR created_at=? AND rowid<=?) ORDER BY created_at DESC,rowid DESC LIMIT 1").get(seriesId,at,at,sequence);
  return saved ? readDetail(saved).title || store.row(seriesId)?.title : store.row(seriesId)?.title;
}
function episodeContext(store,seriesId,episodeId,detail={},at=Date.now(),sequence=Number.MAX_SAFE_INTEGER) {
  const db=store.db, episode=db.prepare('SELECT * FROM content_episodes WHERE id=? AND series_id=?').get(episodeId,seriesId);
  const saved=db.prepare("SELECT action,detail FROM content_audit WHERE (created_at<? OR created_at=? AND rowid<=?) AND ((action='保存分集' AND target_id=?) OR (action='调整分集顺序' AND target_id=? AND EXISTS(SELECT 1 FROM json_each(detail,'$.ids') WHERE value=?))) ORDER BY created_at DESC,rowid DESC LIMIT 1").get(at,at,sequence,episodeId,seriesId,episodeId);
  const previous=saved ? readDetail(saved) : {},position=saved?.action==='调整分集顺序' ? previous.ids.indexOf(episodeId) : -1;
  const previousNumber=position>=0 ? position+1 : previous.number,previousTitle=position>=0 ? previous.order?.[position]?.title : previous.episodeTitle;
  const comment=hasTable(db,'comment_content') ? db.prepare('SELECT * FROM comment_content WHERE series_id=? AND episode_id=?').get(seriesId,episodeId) : null;
  return {seriesId,episodeId,seriesTitle:detail.seriesTitle || seriesTitleAt(store,seriesId,at,sequence) || comment?.series_title || null,
    number:detail.number ?? previousNumber ?? episode?.number ?? comment?.episode_number ?? null,
    title:detail.episodeTitle || previousTitle || episode?.title || comment?.episode_title || ''};
}

// 关联只来自真实分集、评论和保存记录；历史记录不靠编号猜测作品。
export function captureAuditContext(store,row) {
  const db=store.db, detail=readDetail(row), refs=[],sequence=db.prepare('SELECT rowid AS sequence FROM content_audit WHERE id=?').get(row.id).sequence;
  if (seriesActions.has(row.action)) refs.push({seriesId:row.target_id,episodeId:'',seriesTitle:detail.seriesTitle || detail.title || seriesTitleAt(store,row.target_id,row.created_at,sequence) || null,number:null,title:''});
  if (row.action==='调整分集顺序'&&Array.isArray(detail.ids)) detail.ids.forEach((id,index)=>refs.push(episodeContext(store,row.target_id,id,{number:index+1,episodeTitle:detail.order?.[index]?.title},row.created_at,sequence)));
  if (['保存分集','移除分集'].includes(row.action)) {
    const episode=db.prepare('SELECT series_id FROM content_episodes WHERE id=?').get(row.target_id);
    const seriesId=detail.seriesId || episode?.series_id;
    if (seriesId) refs.push(episodeContext(store,seriesId,row.target_id,detail,row.created_at,sequence));
  }
  if (row.action==='处理评论') {
    const comment=db.prepare('SELECT series_id,episode_id FROM episode_comments WHERE id=?').get(row.target_id);
    if (comment) refs.push(episodeContext(store,comment.series_id,comment.episode_id,detail,row.created_at,sequence));
  }
  if (row.action==='完成文件上传') {
    const asset=store.asset(row.target_id);
    for (const episode of db.prepare('SELECT * FROM content_episodes WHERE asset_id=?').all(row.target_id)) refs.push(episodeContext(store,episode.series_id,episode.id));
    for (const saved of db.prepare("SELECT rowid AS sequence,target_id,detail,created_at FROM content_audit WHERE action='保存分集' AND json_extract(detail,'$.assetId')=?").all(row.target_id)) {
      const savedDetail=readDetail(saved);
      if (savedDetail.seriesId) refs.push(episodeContext(store,savedDetail.seriesId,saved.target_id,savedDetail,saved.created_at,saved.sequence));
    }
    for (const series of db.prepare('SELECT id,title FROM content_series WHERE cover_id=?').all(row.target_id)) refs.push({seriesId:series.id,episodeId:'',seriesTitle:series.title,number:null,title:''});
    if (asset?.series_id && !refs.some(ref=>ref.seriesId===asset.series_id)) refs.push({seriesId:asset.series_id,episodeId:'',seriesTitle:store.row(asset.series_id)?.title || null,number:asset.episode_number,title:''});
  }
  const insert=db.prepare('INSERT OR IGNORE INTO content_audit_refs VALUES(?,?,?,?,?,?)');
  for (const ref of refs) insert.run(row.id,ref.seriesId,ref.episodeId,ref.seriesTitle,ref.number,ref.title);
}

export function linkUploadAudit(store,assetId) {
  const rows=store.db.prepare("SELECT * FROM content_audit WHERE action='完成文件上传' AND target_id=?").all(assetId);
  for (const row of rows) {
    store.db.prepare("DELETE FROM content_audit_refs WHERE audit_id=? AND episode_id='' AND episode_number IS NOT NULL").run(row.id);
    captureAuditContext(store,row);
  }
}

export function initializeAuditContext(store) {
  const fresh=!hasTable(store.db,'content_audit_refs');
  store.db.exec(`CREATE TABLE IF NOT EXISTS content_audit_refs(audit_id TEXT NOT NULL,series_id TEXT NOT NULL,episode_id TEXT NOT NULL,series_title TEXT,episode_number INTEGER,episode_title TEXT NOT NULL,PRIMARY KEY(audit_id,series_id,episode_id));
    CREATE INDEX IF NOT EXISTS audit_refs_series ON content_audit_refs(series_id,episode_id,audit_id);
    CREATE INDEX IF NOT EXISTS audit_target_time ON content_audit(action,target_id,created_at);`);
  if (fresh) store.transaction(()=>{for(const row of store.db.prepare('SELECT * FROM content_audit ORDER BY created_at,id').all())captureAuditContext(store,row);});
}

export class ContentAudit {
  constructor(store,accounts) { this.store=store;this.db=store.db;this.accounts=accounts; }
  page(params) {
    const value=params.get('page') || '1';
    if (!/^\d{1,4}$/.test(value) || Number(value)<1 || Number(value)>1000) throw new AccountError(400,'操作记录分页无效');
    return Number(value);
  }
  series(params) {
    const page=this.page(params),query=(params.get('q') || '').trim().slice(0,200);
    const rows=this.db.prepare(`WITH ids AS (SELECT id FROM content_series UNION SELECT series_id FROM content_audit_refs)
      SELECT ids.id,COALESCE(s.title,(SELECT series_title FROM content_audit_refs WHERE series_id=ids.id AND series_title IS NOT NULL LIMIT 1)) AS title,
      (SELECT COUNT(DISTINCT audit_id) FROM content_audit_refs WHERE series_id=ids.id) AS count
      FROM ids LEFT JOIN content_series s ON s.id=ids.id WHERE (?='' OR s.title LIKE ? OR EXISTS(SELECT 1 FROM content_audit_refs WHERE series_id=ids.id AND series_title LIKE ?))
      ORDER BY count DESC,ids.id DESC LIMIT 25 OFFSET ?`).all(query,`%${query}%`,`%${query}%`,(page-1)*24);
    const unassigned=this.db.prepare(`SELECT COUNT(*) AS count FROM content_audit a WHERE action IN (${actionSlots}) AND NOT EXISTS(SELECT 1 FROM content_audit_refs WHERE audit_id=a.id)`).get(...contentActions).count;
    return {items:rows.slice(0,24),hasMore:rows.length>24,unassigned};
  }
  logs(params) {
    const page=this.page(params),seriesId=params.get('seriesId') || '',episodeId=params.get('episodeId') || '';
    const scope=params.get('scope') || 'content',unassigned=params.get('unassigned')==='1';
    if (!['content','platform'].includes(scope) || seriesId && !/^\d{1,40}$/.test(seriesId) || episodeId && !/^\d{1,40}$/.test(episodeId) || episodeId&&!seriesId || scope==='platform'&&(seriesId||episodeId||unassigned) || unassigned&&seriesId) throw new AccountError(400,'操作记录筛选无效');
    if (scope==='content'&&!seriesId&&!unassigned) throw new AccountError(400,'请先选择短剧');
    const refs=seriesId ? this.db.prepare("SELECT id,number,title FROM (SELECT r.episode_id AS id,r.episode_number AS number,r.episode_title AS title,ROW_NUMBER() OVER(PARTITION BY r.episode_id ORDER BY a.created_at DESC,a.rowid DESC) AS position FROM content_audit_refs r JOIN content_audit a ON a.id=r.audit_id WHERE r.series_id=? AND r.episode_id<>'') WHERE position=1").all(seriesId) : [];
    const current=seriesId ? this.store.detail(seriesId,true) : null;
    const episodes=new Map((current?.episodes || []).map(row=>[row.id,{id:row.id,number:row.number,title:row.title,removed:false}]));
    for (const ref of refs) if(!episodes.has(ref.id))episodes.set(ref.id,{...ref,removed:true});
    if (seriesId&&!current&&!this.db.prepare('SELECT 1 FROM content_audit_refs WHERE series_id=?').get(seriesId)) throw new AccountError(404,'短剧不存在');
    if (episodeId&&!episodes.has(episodeId)) throw new AccountError(404,'分集不属于此短剧');
    const where=scope==='platform' ? `a.action NOT IN (${actionSlots})` : unassigned ? `a.action IN (${actionSlots}) AND NOT EXISTS(SELECT 1 FROM content_audit_refs WHERE audit_id=a.id)` : "EXISTS(SELECT 1 FROM content_audit_refs WHERE audit_id=a.id AND series_id=? AND (?='' OR episode_id=?))";
    const values=scope==='platform'||unassigned ? contentActions : [seriesId,episodeId,episodeId];
    const rows=this.db.prepare(`SELECT a.* FROM content_audit a WHERE ${where} ORDER BY a.created_at DESC,a.rowid DESC LIMIT 101 OFFSET ?`).all(...values,(page-1)*100);
    const seriesTitle=current?.title || this.db.prepare('SELECT series_title FROM content_audit_refs WHERE series_id=? AND series_title IS NOT NULL LIMIT 1').get(seriesId)?.series_title || null;
    return {series:seriesId ? {id:seriesId,title:seriesTitle} : null,episodes:[...episodes.values()].sort((a,b)=>(a.number??Infinity)-(b.number??Infinity)||a.id.localeCompare(b.id)),hasMore:rows.length>100,items:rows.slice(0,100).map(row=>{
      const detail=readDetail(row),actor=this.accounts.byId(row.admin_id),account=scope==='platform' ? this.accounts.byId(row.target_id) : null,creator=detail.creatorId ? this.accounts.byId(detail.creatorId) : null;
      const targets=this.db.prepare('SELECT series_title AS seriesTitle,episode_number AS number,episode_title AS title FROM content_audit_refs WHERE audit_id=? AND (?=\'\' OR series_id=?) AND (?=\'\' OR episode_id=?) ORDER BY episode_number').all(row.id,seriesId,seriesId,episodeId,episodeId);
      return {id:row.id,action:row.action,createdAt:row.created_at,actorName:detail.adminName || actor?.name || null,actorEmail:detail.adminEmail || actor?.email || null,targets,
        filename:detail.fileName || (row.action==='完成文件上传' ? detail.name : detail.assetId ? this.store.asset(detail.assetId)?.name : null) || null,
        kind:row.action==='完成文件上传' ? detail.kind || null : row.action==='保存分集' ? 'video' : null,
        order:row.action==='调整分集顺序' ? (detail.order || (detail.ids || []).map((id,index)=>({number:index+1,title:this.db.prepare('SELECT episode_title FROM content_audit_refs WHERE audit_id=? AND episode_id=?').get(row.id,id)?.episode_title || ''}))).map(item=>({number:item.number,title:item.title})) : [],
        accountName:detail.accountName || account?.name || null,accountEmail:detail.accountEmail || account?.email || null,
        creatorName:detail.creatorName || creator?.name || null,creatorEmail:detail.creatorEmail || creator?.email || null,creatorAssigned:row.action==='设置短剧创作者' ? !!detail.creatorId : null,
        status:row.action==='处理评论' ? detail.status : null,reason:detail.reason || null,periodEnd:detail.periodEnd || null};
    })};
  }
}
