import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const scrypt = promisify(crypto.scrypt);
export class AccountError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export const secret = () => crypto.randomBytes(32).toString('base64url');
export function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>@,;:"\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.trim())) throw new AccountError(400, '请输入有效的邮箱地址');
  return value.trim().toLowerCase();
}
export function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new AccountError(400, '昵称需为1至80个字符');
  return value.trim();
}
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new AccountError(400, '密码需为12至256个字符');
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}
const dummyHash = passwordHash(secret());
export async function passwordMatches(password, stored) {
  const [, salt, encoded] = (stored || await dummyHash).split(':');
  const input = typeof password === 'string' && password.length <= 256 ? password : '';
  const key = await scrypt(input, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 });
  return crypto.timingSafeEqual(key, Buffer.from(encoded, 'hex')) && !!stored;
}

export const membershipPlans = [
  { id: 'monthly', currency: 'USD', amount: 2999, interval: 'month' },
  { id: 'annual', currency: 'USD', amount: 19999, interval: 'year' },
];

export class AccountStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT, google_sub TEXT UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, avatar_data BLOB, avatar_mime TEXT, google_avatar TEXT, customer_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_tokens (token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, account_id TEXT, payload TEXT, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_subscriptions (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), plan_id TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER NOT NULL, cancel_at_period_end INTEGER NOT NULL, event_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_subscriptions_owner ON account_subscriptions(account_id);
      CREATE TABLE IF NOT EXISTS account_billing_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  byId(id) { return this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) || null; }
  byEmail(email) { return this.db.prepare('SELECT * FROM accounts WHERE email=?').get(email) || null; }
  create({ email, name, hash = null, googleSub = null, avatar = null, verified = false }) {
    const id = crypto.randomUUID(), now = Date.now();
    try { this.db.prepare('INSERT INTO accounts(id,email,name,password_hash,google_sub,email_verified,google_avatar,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, emailAddress(email), displayName(name), hash, googleSub, verified ? 1 : 0, avatar, now, now); }
    catch (error) { if (String(error.message).includes('UNIQUE')) throw new AccountError(409, '此邮箱已注册，请登录后再绑定Google'); throw error; }
    return this.byId(id);
  }
  googleAccount(sub) { return this.db.prepare('SELECT * FROM accounts WHERE google_sub=?').get(sub) || null; }
  linkGoogle(id, sub) {
    try { this.db.prepare('UPDATE accounts SET google_sub=?,email_verified=1,updated_at=? WHERE id=?').run(sub, Date.now(), id); }
    catch { throw new AccountError(409, '此Google账号已绑定其他账户'); }
  }
  session(id) {
    const token = secret();
    this.db.prepare('DELETE FROM account_sessions WHERE expires_at<?').run(Date.now());
    this.db.prepare('INSERT INTO account_sessions VALUES(?,?,?)').run(digest(token), id, Date.now() + 30 * 86400000);
    return token;
  }
  viewer(token) {
    if (!token || token.length > 256) return null;
    return this.db.prepare('SELECT a.* FROM accounts a JOIN account_sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.expires_at>?').get(digest(token), Date.now()) || null;
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(digest(token)); }
  token(purpose, accountId, payload = {}, ttl = 1800000) {
    const token = secret();
    this.db.prepare('DELETE FROM account_tokens WHERE expires_at<?').run(Date.now());
    this.db.prepare('INSERT INTO account_tokens VALUES(?,?,?,?,?)').run(digest(token), purpose, accountId, JSON.stringify(payload), Date.now() + ttl);
    return token;
  }
  consumeToken(token, purpose) {
    if (typeof token !== 'string' || token.length > 256) throw new AccountError(400, '链接已失效，请重新申请');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM account_tokens WHERE token_hash=? AND purpose=? AND expires_at>?').get(digest(token), purpose, Date.now());
      if (!row) throw new AccountError(400, '链接已失效，请重新申请');
      this.db.prepare('DELETE FROM account_tokens WHERE token_hash=?').run(row.token_hash);
      return { accountId: row.account_id, payload: JSON.parse(row.payload) };
    });
  }
  resetPassword(id, hash) {
    this.transaction(() => {
      this.db.prepare('UPDATE accounts SET password_hash=?,email_verified=1,updated_at=? WHERE id=?').run(hash, Date.now(), id);
      this.db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(id);
      this.db.prepare('DELETE FROM account_tokens WHERE account_id=? AND purpose=?').run(id, 'reset');
    });
  }
  verifyEmail(id) { this.db.prepare('UPDATE accounts SET email_verified=1,updated_at=? WHERE id=?').run(Date.now(), id); }
  updateProfile(id, input) {
    const account = this.byId(id);
    const name = input.name == null ? account.name : displayName(input.name);
    let data = account.avatar_data, mime = account.avatar_mime;
    if (input.avatar != null) {
      if (typeof input.avatar !== 'string' || input.avatar.length > 1400000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.avatar)) throw new AccountError(400, '头像需为1MB以内的JPEG、PNG或WebP图片');
      data = Buffer.from(input.avatar, 'base64');
      if (data.length > 1048576) throw new AccountError(400, '头像需为1MB以内的JPEG、PNG或WebP图片');
      mime = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png' : data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg' : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
      if (!mime) throw new AccountError(400, '头像需为1MB以内的JPEG、PNG或WebP图片');
    }
    this.db.prepare('UPDATE accounts SET name=?,avatar_data=?,avatar_mime=?,updated_at=? WHERE id=?').run(name, data ?? null, mime ?? null, Date.now(), id);
    return this.byId(id);
  }
  customer(id, customerId) { this.db.prepare('UPDATE accounts SET customer_id=? WHERE id=?').run(customerId, id); }
  saveSubscription(eventId, subscription, eventAt) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM account_billing_events WHERE id=?').get(eventId)) return false;
      this.db.prepare('INSERT INTO account_billing_events VALUES(?,?)').run(eventId, Date.now());
      this.db.prepare('INSERT INTO account_subscriptions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id,status=excluded.status,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_at=excluded.event_at WHERE excluded.event_at>=account_subscriptions.event_at AND excluded.account_id=account_subscriptions.account_id').run(subscription.id, subscription.accountId, subscription.planId, subscription.status, subscription.periodEnd, subscription.cancelAtPeriodEnd ? 1 : 0, eventAt);
      return true;
    });
  }
  membership(id) {
    const row = this.db.prepare("SELECT * FROM account_subscriptions WHERE account_id=? ORDER BY CASE WHEN status IN ('active','trialing') AND period_end>? THEN 0 ELSE 1 END,period_end DESC LIMIT 1").get(id, Date.now());
    return { active: !!row && ['active', 'trialing'].includes(row.status) && row.period_end > Date.now(), status: row?.status || 'none', planId: row?.plan_id || null, periodEnd: row?.period_end || null, cancelAtPeriodEnd: !!row?.cancel_at_period_end };
  }
  publicAccount(account) {
    if (!account) return null;
    return { id: account.id, email: account.email, name: account.name, emailVerified: !!account.email_verified, googleLinked: !!account.google_sub, avatarUrl: account.avatar_mime ? `/api/account/avatar?v=${account.updated_at}` : account.google_avatar || null, membership: this.membership(account.id) };
  }
}
