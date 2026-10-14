import { AccountError } from './account-store.mjs';

export function positiveLimit(config, key, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(config[key] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${key}资源保护配置无效`);
  return value;
}

export class RequestGuard {
  constructor(config = {}, clock = Date.now) {
    this.clock = clock; this.buckets = new Map(); this.active = new Map(); this.prunedAt = 0;
    this.api = positiveLimit(config, 'API_VIEWER_REQUESTS_PER_MINUTE', 360);
    this.ip = positiveLimit(config, 'API_IP_REQUESTS_PER_MINUTE', 1800);
    this.global = positiveLimit(config, 'API_GLOBAL_REQUESTS_PER_MINUTE', 6000);
    this.video = positiveLimit(config, 'CONTENT_VIEWER_REQUESTS_PER_MINUTE', 120);
    this.videoIp = positiveLimit(config, 'CONTENT_IP_REQUESTS_PER_MINUTE', 600);
    this.videoGlobal = positiveLimit(config, 'CONTENT_GLOBAL_REQUESTS_PER_MINUTE', 1200);
    this.maximum = positiveLimit(config, 'API_MAX_ACTIVE_REQUESTS', 128, 4096);
  }
  rate(entries) {
    const now = this.clock();
    if (now - this.prunedAt >= 30000) {
      for (const [key, row] of this.buckets) if (now - row.at > 120000) this.buckets.delete(key);
      this.prunedAt = now;
    }
    const rows = entries.map(([key, maximum]) => {
      let row = this.buckets.get(key);
      if (!row) {
        if (this.buckets.size >= 10000) throw new AccountError(429, '操作过于频繁，请稍后重试');
        row = { tokens: maximum, at: now }; this.buckets.set(key, row);
      }
      row.tokens = Math.min(maximum, row.tokens + Math.max(0, now - row.at) * maximum / 60000); row.at = now;
      return row;
    });
    if (rows.some(row => row.tokens < 1)) {
      const error = new AccountError(429, '操作过于频繁，请稍后重试');
      error.retryAfter = Math.max(1, ...rows.map((row, index) => Math.ceil((1 - row.tokens) * 60000 / entries[index][1])));
      throw error;
    }
    for (const row of rows) row.tokens--;
  }
  checkVideo(viewer, address) {
    this.rate([[`video:viewer:${viewer}`, this.video], [`video:ip:${address}`, this.videoIp], ['video:global', this.videoGlobal]]);
  }
  acquire(req, res, viewer, address, costly = false, upload = false) {
    // 已认证管理上传按分块计数，不能用浏览接口额度误伤正常批量大文件上传。
    const scope = upload ? 'upload' : 'api';
    this.rate([[`${scope}:viewer:${viewer}`, upload ? 6000 : this.api], [`${scope}:ip:${address}`, upload ? 12000 : this.ip], [`${scope}:global`, upload ? 30000 : this.global]]);
    // 密码计算另设小并发，避免多个合法格式请求同时占用大量计算内存。
    const entries = [['all', this.maximum], [`viewer:${viewer}`, 16], [`ip:${address}`, 64], ...(costly ? [['password', 4]] : [])];
    this.activate(req, res, entries);
  }
  acquireStatic(req, res, address) {
    this.rate([[`static:ip:${address}`, this.ip], ['static:global', this.global]]);
    this.activate(req, res, [['all', this.maximum], [`static:ip:${address}`, 64]]);
  }
  acquirePreflight(req,res,address){
    // 预检和探活独立计数，不能绕过保护，也不能挤占正常接口轮询额度。
    const probe=req.url?.split('?')[0]==='/health',scope=probe?'probe':'preflight';
    this.rate([[`${scope}:ip:${address}`,probe?120:this.ip],[`${scope}:global`,probe?600:this.global]]);
    this.activate(req,res,[[scope,probe?16:32],[`${scope}:ip:${address}`,8]]);
  }
  activate(req, res, entries) {
    if (entries.some(([key, maximum]) => (this.active.get(key) || 0) >= maximum)) throw new AccountError(429, '操作过于频繁，请稍后重试');
    for (const [key] of entries) this.active.set(key, (this.active.get(key) || 0) + 1);
    let finished = false;
    const release = () => {
      if (finished) return; finished = true;
      req.off('aborted', release); res.off('close', release); res.off('finish', release);
      for (const [key] of entries) { const count = this.active.get(key) - 1; if (count) this.active.set(key, count); else this.active.delete(key); }
    };
    req.once('aborted', release); res.once('close', release); res.once('finish', release);
    if (req.aborted || res.destroyed) release();
  }
}
