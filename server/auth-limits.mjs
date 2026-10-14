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
  constructor(config = {}, clock = Date.now) {
    this.clock = clock; this.buckets = new Map();
    this.trusted = new Set(String(config.TRUSTED_PROXY_IPS || '').split(',').map(value => normalize(value.trim())).filter(Boolean));
    if ([...this.trusted].some(value => !isIP(value))) throw new Error('可信代理地址配置无效');
  }
  prune() { for (const [key, row] of this.buckets) if (row.until <= this.clock()) this.buckets.delete(key); }
  row(key) {
    this.prune();
    const row = this.buckets.get(key);
    if (row) return row;
    if (this.buckets.size >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试');
    const created = { count: 0, until: this.clock() + 900000 };
    this.buckets.set(key, created); return created;
  }
  request(req, scope, maximum) {
    if (++this.row(`request:${scope}:${clientAddress(req, this.trusted)}`).count > maximum) throw new AccountError(429, '操作过于频繁，请稍后重试');
  }
  keys(req, email) {
    const address = clientAddress(req, this.trusted), account = digest(email);
    return [[`failure:pair:${account}:${address}`, 10], [`failure:account:${account}`, 20], [`failure:ip:${address}`, 100]];
  }
  checkLogin(req, email) {
    this.prune();
    for (const [key, maximum] of this.keys(req, email)) if ((this.buckets.get(key)?.count || 0) >= maximum) throw new AccountError(429, '操作过于频繁，请稍后重试');
  }
  failedLogin(req, email) { for (const [key] of this.keys(req, email)) this.row(key).count++; }
  successfulLogin(req, email) {
    const keys = this.keys(req, email);
    this.buckets.delete(keys[0][0]); this.buckets.delete(keys[1][0]);
  }
}
