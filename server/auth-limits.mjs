import { isIP } from 'node:net';
import { AccountError, digest } from './account-store.mjs';

const normalize = value => String(value || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
// 只在直接连接来自明确配置的代理时，按右向左的可信代理链解析客户端地址。
export function clientAddress(req, trusted = new Set()) {
  const peer = normalize(req.socket?.remoteAddress) || 'unknown';
  if (!trusted.has(peer)) return peer;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string') return peer;
  const chain = forwarded.split(',').map(value => normalize(value.trim()));
  if (!chain.length || chain.length > 16 || chain.some(value => !isIP(value))) return peer;
  for (let index = chain.length - 1; index >= 0; index--) if (!trusted.has(chain[index])) return chain[index];
  return chain[0];
}

export class AuthenticationLimits {
  constructor(config = {}, clock = Date.now, options = {}) {
    this.clock = clock; this.buckets = new Map(); this.db = options.db || null; this.onThreshold = options.onThreshold;
    this.trusted = new Set(String(config.TRUSTED_PROXY_IPS || '').split(',').map(value => normalize(value.trim())).filter(Boolean));
    if ([...this.trusted].some(value => !isIP(value))) throw new Error('可信代理地址配置无效');
    this.db?.exec('CREATE TABLE IF NOT EXISTS team_auth_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL)');
  }
  prune() {
    const now = this.clock();
    for (const [key, row] of this.buckets) if (row.until <= now) this.buckets.delete(key);
    this.db?.prepare('DELETE FROM team_auth_limits WHERE until<=?').run(now);
  }
  row(key) {
    this.prune();
    if (this.db) {
      let row = this.db.prepare('SELECT count,until FROM team_auth_limits WHERE key=?').get(key);
      if (row) return row;
      if (this.db.prepare('SELECT COUNT(*) AS n FROM team_auth_limits').get().n >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试');
      this.db.prepare('INSERT OR IGNORE INTO team_auth_limits VALUES(?,0,?)').run(key, this.clock() + 900000);
      return this.db.prepare('SELECT count,until FROM team_auth_limits WHERE key=?').get(key);
    }
    const row = this.buckets.get(key);
    if (row) return row;
    if (this.buckets.size >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试');
    const created = { count: 0, until: this.clock() + 900000 };
    this.buckets.set(key, created); return created;
  }
  increment(key) {
    const row = this.row(key);
    if (!this.db) { row.count++; return row; }
    return this.db.prepare('UPDATE team_auth_limits SET count=count+1 WHERE key=? RETURNING count,until').get(key);
  }
  count(key) { return this.db ? this.db.prepare('SELECT count FROM team_auth_limits WHERE key=?').get(key)?.count || 0 : this.buckets.get(key)?.count || 0; }
  remove(key) { if (this.db) this.db.prepare('DELETE FROM team_auth_limits WHERE key=?').run(key); else this.buckets.delete(key); }
  request(req, scope, maximum) {
    const source = digest(clientAddress(req, this.trusted));
    if (this.increment(`request:${scope}:${source}`).count > maximum) throw new AccountError(429, '操作过于频繁，请稍后重试');
  }
  keys(req, email) {
    const source = digest(clientAddress(req, this.trusted)), account = digest(email);
    return [[`failure:pair:${account}:${source}`, 10, 'pair'], [`failure:account:${account}`, 20, 'account'], [`failure:ip:${source}`, 100, 'source']];
  }
  checkLogin(req, email) {
    this.prune();
    for (const [key, maximum] of this.keys(req, email)) if (this.count(key) >= maximum) throw new AccountError(429, '操作过于频繁，请稍后重试');
  }
  failedLogin(req, email) {
    for (const [key, maximum, dimension] of this.keys(req, email)) {
      const row = this.increment(key);
      if (row.count === maximum) this.onThreshold?.({ scope: email, dimension, attempts: maximum, until: row.until });
    }
  }
  successfulLogin(req, email) {
    const keys = this.keys(req, email);
    this.remove(keys[0][0]); this.remove(keys[1][0]);
  }
}
