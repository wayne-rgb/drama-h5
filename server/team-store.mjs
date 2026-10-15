import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AccountError, digest, secret, passwordHash, passwordMatches } from './account-store.mjs';
import { totp } from './account-mfa.mjs';

export const teamRoles = ['owner', 'editor', 'moderator', 'analyst'];
const lifetime = 8 * 3600000;
const fail = (status, message) => { throw new AccountError(status, message); };
const cookie = req => /(?:^|;\s*)drama_team_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
export function normalizeTeamCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return code.length <= 80 ? code : '';
}

// 与内容共用数据库事务，团队凭证和观众账户互不关联。
export class TeamStore {
  constructor(content, directory, config = {}) {
    this.content = content; this.db = content.db; this.directory = directory; this.config = config;
    this.db.exec(`CREATE TABLE IF NOT EXISTS team_members(id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,roles TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_sessions(token_hash TEXT PRIMARY KEY,member_id TEXT NOT NULL,expires_at INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS team_sessions_member ON team_sessions(member_id);
      CREATE TABLE IF NOT EXISTS team_invites(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,roles TEXT NOT NULL,series_ids TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER);
      CREATE TABLE IF NOT EXISTS team_mfa(member_id TEXT PRIMARY KEY,secret TEXT NOT NULL,last_counter INTEGER NOT NULL,recovery TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_mfa_pending(token_hash TEXT PRIMARY KEY,member_id TEXT NOT NULL,secret TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_series_members(series_id TEXT NOT NULL,member_id TEXT NOT NULL,PRIMARY KEY(series_id,member_id));
      CREATE TABLE IF NOT EXISTS team_events(id TEXT PRIMARY KEY,member_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  transaction(action) { return this.content.transaction(action); }
  initialized() { return !!this.db.prepare('SELECT 1 FROM team_members LIMIT 1').get(); }
  member(id) { return this.db.prepare('SELECT * FROM team_members WHERE id=?').get(id) || null; }
  publicMember(member) {
    return { id: member.id, code: member.code, roles: JSON.parse(member.roles), enabled: !!member.enabled, createdAt: member.created_at,
      seriesIds: this.db.prepare('SELECT series_id FROM team_series_members WHERE member_id=? ORDER BY series_id').all(member.id).map(row => row.series_id),
      series: this.db.prepare('SELECT s.id,s.title FROM content_series s JOIN team_series_members t ON t.series_id=s.id WHERE t.member_id=? ORDER BY s.title').all(member.id) };
  }
  event(member, action, target, detail = {}) {
    this.db.prepare('INSERT INTO team_events VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), member.id, action, target, JSON.stringify(detail), Date.now());
  }
  roles(values) {
    if (!Array.isArray(values) || !values.length || values.length > 4 || values.some(value => !teamRoles.includes(value))) fail(400, '团队角色无效');
    return [...new Set(values)];
  }
  series(values) {
    if (!Array.isArray(values) || values.length > 1000 || values.some(id => typeof id !== 'string' || !this.content.row(id))) fail(400, '作品授权无效');
    return [...new Set(values)];
  }
  owner(member) { return !!member && JSON.parse(member.roles).includes('owner'); }
  has(member, role) { return !!member && !!member.enabled && (this.owner(member) || JSON.parse(member.roles).includes(role)); }
  allowed(member, role, seriesId) {
    return this.has(member, role) && (this.owner(member) || !!this.db.prepare('SELECT 1 FROM team_series_members WHERE member_id=? AND series_id=?').get(member.id, seriesId));
  }
  requireSeries(req, role, seriesId) {
    const member = this.require(req);
    if (!this.allowed(member, role, seriesId)) fail(403, '没有此作品的操作权限');
    return member;
  }
  viewer(req, verified = true) {
    const token = cookie(req);
    if (!token || token.length > 256) return null;
    return this.db.prepare(`SELECT m.*,s.verified,s.created_at AS session_created_at FROM team_members m JOIN team_sessions s ON s.member_id=m.id
      WHERE s.token_hash=? AND s.expires_at>? AND m.enabled=1 AND (?=0 OR s.verified=1)`).get(digest(token), Date.now(), verified ? 1 : 0) || null;
  }
  require(req, role) {
    const member = this.viewer(req);
    if (!member) fail(401, '请先完成团队登录');
    if (role && !this.has(member, role)) fail(403, '没有此操作的团队权限');
    return member;
  }
  session(member, verified = false) {
    const token = secret(), now = Date.now();
    this.db.prepare('DELETE FROM team_sessions WHERE expires_at<=?').run(now);
    this.db.prepare('INSERT INTO team_sessions VALUES(?,?,?,?,?)').run(digest(token), member.id, now + (verified ? lifetime : 600000), verified ? 1 : 0, now);
    return token;
  }
  logout(req) { if (cookie(req)) this.db.prepare('DELETE FROM team_sessions WHERE token_hash=?').run(digest(cookie(req))); }
  create(hash, roles, seriesIds) {
    const id = crypto.randomUUID(), code = `M-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    this.db.prepare('INSERT INTO team_members VALUES(?,?,?,?,1,?)').run(id, code, hash, JSON.stringify(roles), Date.now());
    for (const seriesId of seriesIds) this.db.prepare('INSERT INTO team_series_members VALUES(?,?)').run(seriesId, id);
    return this.member(id);
  }
  async bootstrap(token, password) {
    const configured = this.config.TEAM_BOOTSTRAP_TOKEN;
    if (this.initialized() || !configured || configured.length < 32 || typeof token !== 'string' || !crypto.timingSafeEqual(Buffer.from(digest(token)),Buffer.from(digest(configured)))) fail(403, '团队初始化凭证无效');
    const hash = await passwordHash(password);
    return this.transaction(() => {
      if (this.initialized()) fail(409, '团队已经初始化');
      const member = this.create(hash, ['owner'], []);
      this.event(member, '创建团队负责人', member.id); return member;
    });
  }
  invite(req, data) {
    this.business?.writable();
    const actor = this.require(req, 'owner'), roles = this.roles(data.roles), seriesIds = this.series(data.seriesIds || []);
    const token = secret(), id = crypto.randomUUID(), expiresAt = Date.now() + 86400000;
    return this.transaction(() => {
      this.db.prepare('DELETE FROM team_invites WHERE expires_at<=?').run(Date.now());
      if (this.db.prepare('SELECT COUNT(*) AS n FROM team_invites WHERE used_at IS NULL').get().n >= 100) fail(429, '待使用邀请过多');
      this.db.prepare('INSERT INTO team_invites VALUES(?,?,?,?,?,NULL)').run(id, digest(token), JSON.stringify(roles), JSON.stringify(seriesIds), expiresAt);
      this.event(actor, '创建团队邀请', id, { roles, seriesIds }); return { id, token, expiresAt };
    });
  }
  async join(token, password) {
    if (typeof token !== 'string' || token.length > 256) fail(400, '团队邀请已失效');
    const hash = await passwordHash(password);
    return this.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM team_invites WHERE token_hash=? AND expires_at>? AND used_at IS NULL').get(digest(token), Date.now());
      if (!invite) fail(400, '团队邀请已失效');
      const seriesIds = this.series(JSON.parse(invite.series_ids)), member = this.create(hash, JSON.parse(invite.roles), seriesIds);
      this.db.prepare('UPDATE team_invites SET used_at=? WHERE id=?').run(Date.now(), invite.id);
      this.event(member, '加入团队', member.id); return member;
    });
  }
  async login(code, password) {
    const member = this.db.prepare('SELECT * FROM team_members WHERE code=?').get(normalizeTeamCode(code));
    if (!await passwordMatches(password, member?.password_hash) || !member?.enabled) fail(401, '团队账号或密码不正确');
    const current = this.member(member.id);
    if (!current?.enabled || current.password_hash !== member.password_hash) fail(401, '团队账号或密码不正确');
    return current;
  }
  key() {
    const filename = path.join(this.directory, '.team-key');
    if (!fs.existsSync(filename)) {
      if (this.db.prepare('SELECT 1 FROM team_mfa LIMIT 1').get() || this.db.prepare('SELECT 1 FROM team_mfa_pending LIMIT 1').get()) fail(503, '团队验证密钥不可用');
      try { fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    fs.chmodSync(filename,0o600);
    const key = fs.readFileSync(filename); if (key.length !== 32) fail(503, '团队验证密钥不可用'); return key;
  }
  encrypt(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv), data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(value) {
    try { const data = Buffer.from(value, 'base64'), decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'); }
    catch { fail(503, '团队验证密钥不可用'); }
  }
  setup(req) {
    const member = this.viewer(req, false); if (!member) fail(401, '请先完成团队登录');
    if (this.db.prepare('SELECT 1 FROM team_mfa WHERE member_id=?').get(member.id)) fail(409, '二次验证已启用');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let value = 0, bits = 0, key = '';
    for (const byte of crypto.randomBytes(20)) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; key += alphabet[(value >>> bits) & 31]; } }
    const token = secret();
    this.transaction(() => {
      this.db.prepare('DELETE FROM team_mfa_pending WHERE member_id=? OR expires_at<=?').run(member.id, Date.now());
      this.db.prepare('INSERT INTO team_mfa_pending VALUES(?,?,?,?)').run(digest(token), member.id, this.encrypt(key), Date.now() + 300000);
    });
    return { token, secret: key, uri: `otpauth://totp/Drama:${member.code}?secret=${key}&issuer=Drama` };
  }
  match(key, code, last = -1) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
    const counter = Math.floor(Date.now() / 30000);
    for (const candidate of [counter, counter - 1, counter + 1]) if (candidate > last && crypto.timingSafeEqual(Buffer.from(totp(key, candidate)), Buffer.from(code))) return candidate;
    return null;
  }
  enable(req, data) {
    const member = this.viewer(req, false); if (!member) fail(401, '请先完成团队登录');
    return this.transaction(() => {
      const pending = typeof data.token === 'string' && this.db.prepare('SELECT * FROM team_mfa_pending WHERE token_hash=? AND member_id=? AND expires_at>?').get(digest(data.token), member.id, Date.now());
      if (!pending || this.db.prepare('SELECT 1 FROM team_mfa WHERE member_id=?').get(member.id)) fail(400, '二次验证设置已失效，请重新开始');
      const counter = this.match(this.decrypt(pending.secret), data.code); if (counter === null) fail(400, '动态码无效或已使用');
      const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(12).toString('hex'));
      this.db.prepare('INSERT INTO team_mfa VALUES(?,?,?,?)').run(member.id, pending.secret, counter, JSON.stringify(recoveryCodes.map(digest)));
      this.db.prepare('DELETE FROM team_mfa_pending WHERE member_id=?').run(member.id);
      this.db.prepare('DELETE FROM team_sessions WHERE member_id=?').run(member.id);
      this.event(member, '启用团队二次验证', member.id);
      return { member, recoveryCodes, token: this.session(member, true) };
    });
  }
  verifyCode(member, code) {
    const row = this.db.prepare('SELECT * FROM team_mfa WHERE member_id=?').get(member.id);
    if (!row) fail(400, '请先设置二次验证');
    if (typeof code === 'string' && /^[a-f0-9]{24}$/i.test(code)) {
      const recovery = JSON.parse(row.recovery), index = recovery.indexOf(digest(code.toLowerCase()));
      if (index < 0) fail(400, '动态码无效或已使用');
      recovery.splice(index, 1); this.db.prepare('UPDATE team_mfa SET recovery=? WHERE member_id=?').run(JSON.stringify(recovery), member.id); return;
    }
    const counter = this.match(this.decrypt(row.secret), code, row.last_counter);
    if (counter === null) fail(400, '动态码无效或已使用');
    this.db.prepare('UPDATE team_mfa SET last_counter=? WHERE member_id=?').run(counter, member.id);
  }
  verify(req, code) {
    const member = this.viewer(req, false); if (!member) fail(401, '请先完成团队登录');
    return this.transaction(() => { this.verifyCode(member, code); this.logout(req); this.event(member, '完成团队登录', member.id); return this.session(member, true); });
  }
  async recover(code, recoveryCode, password) {
    const hash = await passwordHash(password);
    return this.transaction(() => {
      const member = this.db.prepare('SELECT * FROM team_members WHERE code=? AND enabled=1').get(normalizeTeamCode(code));
      if (!member || typeof recoveryCode !== 'string' || !/^[a-f0-9]{24}$/i.test(recoveryCode)) fail(400, '动态码无效或已使用');
      this.verifyCode(member, recoveryCode);
      this.db.prepare('UPDATE team_members SET password_hash=? WHERE id=?').run(hash, member.id);
      this.db.prepare('DELETE FROM team_sessions WHERE member_id=?').run(member.id);
      this.event(member, '重设团队密码', member.id); return member;
    });
  }
  update(req, id, data) {
    this.business?.writable();
    const actor = this.require(req, 'owner'), roles = this.roles(data.roles), seriesIds = this.series(data.seriesIds || []);
    if (typeof data.enabled !== 'boolean') fail(400, '成员状态无效');
    return this.transaction(() => {
      const member = this.member(id); if (!member) fail(404, '团队成员不存在');
      if (id === actor.id && (!data.enabled || !roles.includes('owner'))) fail(400, '不能撤销自己的负责人权限');
      if (member.enabled && this.owner(member) && (!data.enabled || !roles.includes('owner')) && this.db.prepare("SELECT COUNT(*) AS n FROM team_members WHERE enabled=1 AND EXISTS(SELECT 1 FROM json_each(roles) WHERE value='owner')").get().n <= 1) fail(400, '必须保留一名团队负责人');
      this.db.prepare('UPDATE team_members SET roles=?,enabled=? WHERE id=?').run(JSON.stringify(roles), data.enabled ? 1 : 0, id);
      this.db.prepare('DELETE FROM team_series_members WHERE member_id=?').run(id);
      for (const seriesId of seriesIds) this.db.prepare('INSERT INTO team_series_members VALUES(?,?)').run(seriesId, id);
      if (id !== actor.id) this.db.prepare('DELETE FROM team_sessions WHERE member_id=?').run(id);
      this.event(actor, '调整团队成员权限', id, { roles, enabled: data.enabled, seriesIds }); return this.publicMember(this.member(id));
    });
  }
  authorize(req, url) {
    const route = url.pathname, member = this.require(req);
    if (!['GET','HEAD'].includes(req.method)) this.business?.writable();
    if (route === '/api/admin/creators' || /^\/api\/admin\/series\/\d+\/creator$/.test(route)) fail(404, '管理接口不存在');
    if (/^\/api\/analytics\/(series|report)$/.test(route)) { if (!this.has(member, 'analyst')) fail(403, '没有此操作的团队权限'); if (url.searchParams.get('seriesId')) this.requireSeries(req, 'analyst', url.searchParams.get('seriesId')); return member; }
    if (this.owner(member)) return member;
    const series = /^\/api\/admin\/series(?:\/(\d+)(?:\/(?:episodes|publish|reorder)(?:\/\d+)?)?)?$/.exec(route);
    if (series) { if (!this.has(member, 'editor') || !series[1] && req.method !== 'GET') fail(403, '没有此操作的团队权限'); if (series[1]) this.requireSeries(req, 'editor', series[1]); return member; }
    if (/^\/api\/admin\/uploads(?:\/[a-f0-9-]+(?:\/hls\/retry|\/verify)?)?$/.test(route)) {
      if (!this.has(member, 'editor')) fail(403, '没有此操作的团队权限');
      const id = /^\/api\/admin\/uploads\/([^/]+)(?:\/hls\/retry|\/verify)?$/.exec(route)?.[1], asset = id && this.content.asset(id);
      const shared = req.method==='GET' || route.endsWith('/hls/retry');
      if (id && (!asset || !shared && asset.owner_id !== member.id || !this.allowed(member, 'editor', asset.series_id))) fail(403, '没有此作品的操作权限');
      return member;
    }
    if (/^\/api\/admin\/(comment-series|comments)(?:\/[a-f0-9-]+)?$/.test(route)) {
      if (!this.has(member, 'moderator')) fail(403, '没有此操作的团队权限');
      const id = /^\/api\/admin\/comments\/([^/]+)$/.exec(route)?.[1];
      const seriesId = id ? this.db.prepare('SELECT series_id FROM episode_comments WHERE id=?').get(id)?.series_id : url.searchParams.get('seriesId');
      if (seriesId) this.requireSeries(req, 'moderator', seriesId); else if (id || route.endsWith('/comments')) fail(403, '没有此作品的操作权限');
      return member;
    }
    fail(403, '没有此操作的团队权限');
  }
}
