import { AccountError } from './account-store.mjs';

export class PlaybackGuard {
  constructor(config = {}, budget, mediaPrefix = 'video/') {
    this.mediaPrefix = mediaPrefix;
    this.maximum = Number(config.CONTENT_MAX_ACTIVE_STREAMS || 64);
    this.perViewer = Number(config.CONTENT_MAX_VIEWER_STREAMS || 6);
    this.timeout = Number(config.CONTENT_STREAM_TIMEOUT_MS || 1800000);
    this.perIp = Number(config.CONTENT_MAX_IP_STREAMS || 24);
    if (![this.maximum, this.perViewer, this.perIp].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096) || !Number.isSafeInteger(this.timeout) || this.timeout < 1000 || this.timeout > 86400000) throw new Error('播放并发或超时配置无效');
    this.active = 0; this.viewers = new Map(); this.addresses = new Map(); this.anonymousAddresses = new Map(); this.budget = budget;
  }
  acquire(req, res, viewer, address = viewer, identified = false) {
    const count = this.viewers.get(viewer) || 0;
    const ipCount = this.addresses.get(address) || 0;
    const anonymousCount = this.anonymousAddresses.get(address) || 0;
    // 身份由服务端会话校验结果提供，共享出口不能把不同观众合并成一个人。
    if (this.active >= this.maximum || count >= this.perViewer || !identified && anonymousCount >= this.perIp) throw new AccountError(429, '操作过于频繁，请稍后重试');
    if (req.method !== 'HEAD') this.budget?.check(viewer, address,!!req.playbackPrivileged);
    const meter = req.method !== 'HEAD' ? this.budget?.meter(viewer, address,!!req.playbackPrivileged) : null;
    this.active++; this.viewers.set(viewer, count + 1); this.addresses.set(address, ipCount + 1);
    if(!identified)this.anonymousAddresses.set(address,anonymousCount+1);
    const controller = new AbortController(); let released = false;
    // 统计不可用也继续复核播放权限；不能把计量降级变成VIP鉴权绕过。
    {
      const consume = (chunk, encoding) => {
        const contentType = String(res.getHeader('Content-Type') || '').toLowerCase();
        if (chunk === undefined || chunk === null || !(contentType.startsWith(this.mediaPrefix) || this.mediaPrefix === 'video/' && contentType === 'application/vnd.apple.mpegurl') || ![200, 206].includes(res.statusCode)) return true;
        try { req.revalidatePlayback?.(); meter?.setPrivileged?.(req.playbackPrivileged); meter?.consume(typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined) : chunk.byteLength); return true; }
        catch { res.destroy(); return false; }
      };
      const write = res.write, end = res.end;
      res.write = function(chunk, encoding, callback) { return consume(chunk, encoding) ? write.call(this, chunk, encoding, callback) : false; };
      res.end = function(chunk, encoding, callback) { return consume(chunk, encoding) ? end.call(this, chunk, encoding, callback) : this; };
    }
    const release = () => {
      if (released) return; released = true;
      clearTimeout(timer); controller.abort();
      req.off('aborted', release); res.off('finish', release); res.off('close', release);
      this.active--;
      const remaining = (this.viewers.get(viewer) || 1) - 1;
      if (remaining) this.viewers.set(viewer, remaining); else this.viewers.delete(viewer);
      const ipRemaining = (this.addresses.get(address) || 1) - 1;
      if (ipRemaining) this.addresses.set(address, ipRemaining); else this.addresses.delete(address);
      if(!identified){const remaining=(this.anonymousAddresses.get(address)||1)-1;if(remaining)this.anonymousAddresses.set(address,remaining);else this.anonymousAddresses.delete(address);}
      try { meter?.close(); } catch { console.warn('播放流量预留释放失败，已保留保护额度'); }
    };
    const timer = setTimeout(() => { release(); res.destroy(); }, this.timeout);
    timer.unref();
    req.once('aborted', release); res.once('finish', release); res.once('close', release);
    if (req.aborted || res.destroyed) release();
    return controller.signal;
  }
}
