import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { AccountError } from './account-store.mjs';
import { isAdministratorAccount } from './account-role.mjs';
import { captureAuditContext } from './content-audit.mjs';

const fail = (status, message) => { throw new AccountError(status, message); };
const read = value => { try { return JSON.parse(value); } catch { return {}; } };
const extension = mime => ({'video/mp4':'mp4','image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[mime] || 'bin');
const oldRoleActions = new Set(['设置短剧创作者','授予创作者权限','撤销创作者权限']);

// 维护流程复用现有存储，临时对应关系只保存在受保护的恢复凭证中，完成后移除。
export class TeamBusiness {
  constructor(team, accounts, uploads, directory, config) {
    Object.assign(this,{team,accounts,uploads,directory,config}); this.store=team.content; this.db=team.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS team_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_history_actors(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS team_migrations(id TEXT PRIMARY KEY,stage TEXT NOT NULL,summary TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    accounts.db.exec(`CREATE TABLE IF NOT EXISTS account_team_events(id TEXT PRIMARY KEY,member_id TEXT NOT NULL,member_code TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL,delivered INTEGER NOT NULL DEFAULT 0);`);
    team.business=this;
    this.flush();
  }
  paused() { return this.db.prepare("SELECT value FROM team_meta WHERE key='maintenance'").get()?.value==='1'; }
  writable() { if(this.paused())fail(503,'后台维护中，请稍后重试'); }
  asset(id) {
    const asset=this.store.asset(id);if(!asset)return null;
    const member=this.team.member(asset.owner_id),history=this.db.prepare('SELECT code FROM team_history_actors WHERE id=?').get(asset.owner_id);
    return {...asset,name:`${asset.id}.${extension(asset.mime)}`,owner_id:member?.id||null,ownerCode:member?.code||history?.code||null};
  }
  flush() {
    if(this.paused())return;
    for(const row of this.accounts.db.prepare('SELECT * FROM account_team_events WHERE delivered=0 ORDER BY created_at,id').all()) {
      this.store.transaction(()=>this.store.audit({id:row.member_id,code:row.member_code},row.action,row.target_id,read(row.detail),{id:row.id,createdAt:row.created_at}));
      this.accounts.db.prepare('UPDATE account_team_events SET delivered=1 WHERE id=?').run(row.id);
    }
  }
  recordMembership(member,user,end,reason,revoke) {
    this.writable();
    this.accounts.transaction(()=>{
      this.accounts.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET period_end=excluded.period_end,admin_id=excluded.admin_id,reason=excluded.reason,updated_at=excluded.updated_at').run(user.id,end,member.id,reason,Date.now());
      this.accounts.db.prepare('INSERT INTO account_team_events VALUES(?,?,?,?,?,?,?,0)').run(crypto.randomUUID(),member.id,member.code,revoke?'撤销手动会员':'开通手动会员',user.id,JSON.stringify({periodEnd:end,reason,accountName:user.name,accountEmail:user.email}),Date.now());
    });
    this.flush();
  }
  assetSeries(id) {
    return this.db.prepare('SELECT series_id AS id FROM content_episodes WHERE asset_id=? UNION SELECT id FROM content_series WHERE cover_id=?').all(id,id).map(row=>row.id);
  }
  legacyIds() {
    const ids=new Set(),add=id=>{if(id&&!this.team.member(id)&&!this.db.prepare('SELECT 1 FROM team_history_actors WHERE id=?').get(id))ids.add(id);};
    for(const row of this.db.prepare('SELECT creator_id AS id FROM content_series UNION SELECT owner_id FROM content_assets UNION SELECT admin_id FROM content_audit').all())add(row.id);
    for(const row of this.db.prepare('SELECT action,target_id,detail FROM content_audit').all()) {
      const detail=read(row.detail);add(detail.creatorId);if(oldRoleActions.has(row.action)&&row.action!=='设置短剧创作者')add(row.target_id);
    }
    for(const row of this.accounts.db.prepare('SELECT account_id AS id FROM account_creators UNION SELECT admin_id FROM account_creators UNION SELECT admin_id FROM account_manual_vip').all())add(row.id);
    return [...ids].sort();
  }
  reviewAccounts(ids) {
    return ids.flatMap(id=>{
      const account=this.accounts.byId(id);if(!account)return [];
      const subscriptions=this.accounts.db.prepare('SELECT COUNT(*) AS n FROM account_subscriptions WHERE account_id=?').get(id).n;
      const comments=this.db.prepare('SELECT COUNT(*) AS n FROM episode_comments WHERE account_id=?').get(id).n,likes=this.db.prepare('SELECT COUNT(*) AS n FROM episode_likes WHERE account_id=?').get(id).n;
      const manual=!!this.accounts.db.prepare('SELECT 1 FROM account_manual_vip WHERE account_id=?').get(id);
      const personalDirectory=fs.existsSync(path.join(this.directory,'accounts',id));
      return [{id,email:account.email,name:account.name,subscriptions,comments,likes,manual,customer:!!account.customer_id,personalDirectory,
        requiresReview:true}];
    });
  }
  review() {
    const filename=path.join(this.directory,'.team-account-review');
    return fs.existsSync(filename)?this.reviewAccounts(read(this.team.decrypt(fs.readFileSync(filename,'utf8')))):[];
  }
  preview() {
    const ids=this.legacyIds(),assets=this.db.prepare('SELECT id,owner_id,series_id,name,mime,status,offset FROM content_assets ORDER BY id').all();
    const unresolved=assets.flatMap(asset=>{
      const refs=this.assetSeries(asset.id),seriesIds=[...new Set([asset.series_id,...refs].filter(Boolean))];
      return seriesIds.length!==1||!this.store.row(seriesIds[0])?[{id:asset.id,status:asset.status,seriesIds,revision:this.store.asset(asset.id).upload_revision}]:[];
    });
    const records=this.db.prepare('SELECT * FROM content_audit ORDER BY id').all();
    const snapshot=crypto.createHash('sha256').update(JSON.stringify({ids,assets,records,series:this.db.prepare('SELECT id,creator_id FROM content_series ORDER BY id').all(),grants:this.accounts.db.prepare('SELECT * FROM account_creators ORDER BY account_id').all(),manual:this.accounts.db.prepare('SELECT * FROM account_manual_vip ORDER BY account_id').all()})).digest('hex');
    const configured=this.accounts.db.prepare('SELECT * FROM accounts').all().filter(row=>isAdministratorAccount(row,this.config)).map(row=>row.id);
    return {paused:this.paused(),snapshot,legacy:ids.map(id=>({id,seriesIds:this.db.prepare('SELECT id FROM content_series WHERE creator_id=?').all(id).map(row=>row.id),assets:assets.filter(asset=>asset.owner_id===id).length,operations:records.filter(row=>row.admin_id===id).length})),
      unresolved,accounts:this.reviewAccounts([...new Set([...ids,...configured,...this.review().map(row=>row.id)])]),
      counts:{actors:ids.length,assets:assets.length,operations:records.length,oldNames:assets.filter(asset=>asset.name!==`${asset.id}.${extension(asset.mime)}`).length},
      runs:this.db.prepare('SELECT * FROM team_migrations ORDER BY created_at DESC LIMIT 10').all().map(row=>({...row,summary:read(row.summary)})),recoverable:fs.existsSync(path.join(this.directory,'.team-migration-journal')),
      restoreId:this.db.prepare("SELECT value FROM team_meta WHERE key='restore_id'").get()?.value||null};
  }
  pause(actor) {
    this.flush();
    this.store.transaction(()=>{this.db.prepare("INSERT INTO team_meta VALUES('maintenance','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();this.team.event(actor,'暂停后台写入','maintenance');});
    return {paused:true};
  }
  resume(actor) {
    if(this.running)fail(409,'维护任务正在执行');
    if(fs.existsSync(path.join(this.directory,'.team-migration-journal')))fail(409,'请先完成中断的迁移或恢复备份');
    this.store.transaction(()=>{this.db.prepare("DELETE FROM team_meta WHERE key IN ('maintenance','restore_id')").run();this.team.event(actor,'恢复后台写入','maintenance');});
    return {paused:false};
  }
  ensureIdle() {
    if(!this.paused())fail(409,'请先暂停后台写入');
    if(this.uploads.busy()||this.db.prepare("SELECT 1 FROM content_hls_jobs WHERE status IN ('queued','processing') LIMIT 1").get())fail(409,'请等待上传处理和转码任务完成后再迁移');
  }
  invariants() {
    return JSON.stringify({series:this.db.prepare('SELECT id,status,cover_id FROM content_series ORDER BY id').all(),episodes:this.db.prepare('SELECT * FROM content_episodes ORDER BY id').all(),
      assets:this.db.prepare('SELECT id,status,size,offset,metadata FROM content_assets ORDER BY id').all(),locations:this.db.prepare('SELECT * FROM content_asset_locations ORDER BY asset_id').all(),hls:this.db.prepare('SELECT * FROM content_hls_jobs ORDER BY asset_id').all()});
  }
  async migrate(actor,input,revalidate=()=>{}) {
    if(this.running)fail(409,'维护任务正在执行');this.ensureIdle();this.running=true;
    const journalFile=path.join(this.directory,'.team-migration-journal');
    try {
      let journal;
      if(fs.existsSync(journalFile))journal=read(this.team.decrypt(fs.readFileSync(journalFile,'utf8')));
      else {
        const preview=this.preview();
        if(input.snapshot!==preview.snapshot)fail(409,'数据已经变化，请重新预检');
        const id=crypto.randomUUID(),directory=path.join(this.directory,'maintenance-backups',id);fs.mkdirSync(directory,{recursive:true,mode:0o700});
        await backup(this.db,path.join(directory,'content.sqlite'));await backup(this.accounts.db,path.join(directory,'accounts.sqlite'));revalidate();this.ensureIdle();
        for(const name of ['content','accounts']) {
          const filename=path.join(directory,`${name}.sqlite`);fs.chmodSync(filename,0o600);
          const copy=new DatabaseSync(filename,{readOnly:true});
          try {if(copy.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail(409,'迁移备份校验失败');}finally{copy.close();}
        }
        if(this.preview().snapshot!==input.snapshot)fail(409,'数据已经变化，请重新预检');
        const mappings=preview.legacy.map(row=>({old:row.id,id:crypto.randomUUID(),code:`H-${crypto.randomBytes(6).toString('hex').toUpperCase()}`}));
        journal={id,mappings,summary:preview.counts,createdAt:Date.now(),invariants:this.invariants()};
        const reviewIds=[...new Set([...preview.accounts.map(row=>row.id),...this.review().map(row=>row.id)])];
        fs.writeFileSync(path.join(this.directory,'.team-account-review'),this.team.encrypt(JSON.stringify(reviewIds)),{mode:0o600});
        fs.writeFileSync(journalFile,this.team.encrypt(JSON.stringify(journal)),{mode:0o600,flag:'wx'});
      }
      this.db.prepare("INSERT INTO team_meta VALUES('restore_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(journal.id);
      const run=this.db.prepare('SELECT * FROM team_migrations WHERE id=?').get(journal.id);
      if(run?.stage==='restored')fail(409,'请先完成备份恢复');
      if(run?.stage==='complete'){fs.unlinkSync(journalFile);return {id:journal.id,summary:journal.summary,accounts:this.review()};}
      if(!run) this.store.transaction(()=>{
        const actors=new Map(journal.mappings.map(row=>[row.old,row]));
        for(const row of journal.mappings)this.db.prepare('INSERT OR IGNORE INTO team_history_actors VALUES(?,?)').run(row.id,row.code);
        for(const asset of this.db.prepare('SELECT * FROM content_assets').all()) {
          const refs=[...new Set([asset.series_id,...this.assetSeries(asset.id)].filter(Boolean))],seriesId=refs.length===1&&this.store.row(refs[0])?refs[0]:null;
          const owner=actors.get(asset.owner_id)?.id||asset.owner_id;
          const name=`${asset.id}.${extension(asset.mime)}`;
          if(owner!==asset.owner_id||name!==asset.name||seriesId!==asset.series_id)this.db.prepare('UPDATE content_assets SET owner_id=?,name=?,series_id=?,upload_revision=upload_revision+1 WHERE id=?').run(owner,name,seriesId,asset.id);
        }
        for(const row of this.db.prepare('SELECT * FROM content_audit').all()) {
          captureAuditContext(this.store,row);
          const detail=read(row.detail),previous=actors.get(row.admin_id),creator=actors.get(detail.creatorId);
          const allowed=['seriesId','seriesTitle','episodeTitle','title','number','assetId','kind','ids','order','status','periodEnd','creatorCode','creatorAssigned'];
          if(['开通手动会员','撤销手动会员'].includes(row.action))allowed.push('accountName','accountEmail','reason');
          const clean=Object.fromEntries(allowed.filter(key=>detail[key]!==undefined).map(key=>[key,detail[key]]));
          clean.actorCode=previous?.code||this.team.member(row.admin_id)?.code||this.db.prepare('SELECT code FROM team_history_actors WHERE id=?').get(row.admin_id)?.code||null;
          if(row.action==='设置短剧创作者'){clean.creatorCode=creator?.code||detail.creatorCode||null;clean.creatorAssigned=detail.creatorAssigned??!!detail.creatorId;}
          const target=oldRoleActions.has(row.action)&&row.action!=='设置短剧创作者'?(actors.get(row.target_id)?.id||row.target_id):row.target_id;
          this.db.prepare('UPDATE content_audit SET admin_id=?,target_id=?,detail=? WHERE id=?').run(previous?.id||row.admin_id,target,JSON.stringify(clean),row.id);
        }
        this.db.prepare('UPDATE content_series SET creator_id=NULL').run();
        this.db.prepare("INSERT INTO team_migrations VALUES(?,'content',?,?)").run(journal.id,JSON.stringify(journal.summary),journal.createdAt);
      });
      this.accounts.transaction(()=>{
        for(const row of journal.mappings)this.accounts.db.prepare('UPDATE account_manual_vip SET admin_id=? WHERE admin_id=?').run(row.id,row.old);
        this.accounts.db.prepare('DELETE FROM account_creators').run();
      });
      if(this.invariants()!==journal.invariants)fail(409,'业务数据校验失败，请恢复备份');
      this.store.transaction(()=>{
        this.db.prepare("UPDATE team_migrations SET stage='complete' WHERE id=?").run(journal.id);
        this.team.event(actor,'迁移业务归属',journal.id,journal.summary);
      });
      fs.unlinkSync(journalFile);
      return {id:journal.id,summary:journal.summary,accounts:this.review(),backup:path.join(this.directory,'maintenance-backups',journal.id)};
    } finally {this.running=false;}
  }
  restore(actor,id) {
    if(this.running)fail(409,'维护任务正在执行');this.ensureIdle();
    if(!/^[a-f0-9-]{36}$/.test(id))fail(400,'迁移批次无效');
    const journalFile=path.join(this.directory,'.team-migration-journal');
    const pending=fs.existsSync(journalFile)?read(this.team.decrypt(fs.readFileSync(journalFile,'utf8'))):null;
    const restoreId=pending?.id||this.db.prepare("SELECT value FROM team_meta WHERE key='restore_id'").get()?.value;
    if(id!==restoreId)fail(409,'只能在恢复后台写入前还原当前迁移批次');
    const directory=path.join(this.directory,'maintenance-backups',id);
    if(!fs.existsSync(path.join(directory,'content.sqlite'))||!fs.existsSync(path.join(directory,'accounts.sqlite')))fail(404,'迁移备份不存在');
    // 只恢复本轮迁移改动的业务表；维护期间的观众互动与订阅不能被旧快照覆盖。
    this.db.prepare('ATTACH DATABASE ? AS migration_backup').run(path.join(directory,'content.sqlite'));
    this.accounts.db.prepare('ATTACH DATABASE ? AS migration_backup').run(path.join(directory,'accounts.sqlite'));
    try {
      this.store.transaction(()=>{
        for(const table of ['content_series','content_assets','content_audit','content_audit_refs','team_history_actors']) {
          this.db.exec(`DELETE FROM ${table}; INSERT INTO ${table} SELECT * FROM migration_backup.${table}`);
        }
        this.db.prepare("UPDATE team_migrations SET stage='restored' WHERE id=?").run(id);
        this.team.event(actor,'恢复迁移前业务数据',id);
      });
      this.accounts.transaction(()=>{
        this.accounts.db.exec('DELETE FROM account_creators; INSERT INTO account_creators SELECT * FROM migration_backup.account_creators');
        this.accounts.db.exec('UPDATE account_manual_vip SET admin_id=COALESCE((SELECT admin_id FROM migration_backup.account_manual_vip b WHERE b.account_id=account_manual_vip.account_id),admin_id)');
      });
      if(fs.existsSync(journalFile))fs.unlinkSync(journalFile);
      this.db.prepare("DELETE FROM team_meta WHERE key='restore_id'").run();
      return {ok:true};
    } finally {this.db.exec('DETACH DATABASE migration_backup');this.accounts.db.exec('DETACH DATABASE migration_backup');}
  }
}
