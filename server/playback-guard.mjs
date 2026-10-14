import { AccountError } from './account-store.mjs';

export class PlaybackGuard {
  constructor(config = {}) {
    this.maximum = Number(config.CONTENT_MAX_ACTIVE_STREAMS || 64);
    this.perViewer = Number(config.CONTENT_MAX_VIEWER_STREAMS || 6);
    this.timeout = Number(config.CONTENT_STREAM_TIMEOUT_MS || 1800000);
    if (![this.maximum, this.perViewer].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096) || !Number.isSafeInteger(this.timeout) || this.timeout < 1000 || this.timeout > 86400000) throw new Error('播放并发或超时配置无效');
    this.active = 0; this.viewers = new Map();
  }
  acquire(req, res, viewer) {
    const count = this.viewers.get(viewer) || 0;
    if (this.active >= this.maximum || count >= this.perViewer) throw new AccountError(429, '操作过于频繁，请稍后重试');
    this.active++; this.viewers.set(viewer, count + 1);
    const controller = new AbortController(); let released = false;
    const release = () => {
      if (released) return; released = true;
      clearTimeout(timer); controller.abort();
      req.off('aborted', release); res.off('finish', release); res.off('close', release);
      this.active--;
      const remaining = (this.viewers.get(viewer) || 1) - 1;
      if (remaining) this.viewers.set(viewer, remaining); else this.viewers.delete(viewer);
    };
    const timer = setTimeout(() => { release(); res.destroy(); }, this.timeout);
    timer.unref();
    req.once('aborted', release); res.once('finish', release); res.once('close', release);
    if (req.aborted || res.destroyed) release();
    return controller.signal;
  }
}
