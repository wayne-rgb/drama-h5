import { AsyncLocalStorage } from 'node:async_hooks';
import axios from 'axios';
import { assertPublicTarget, publicLookup } from './public-target.mjs';

export class ContentRequestError extends Error { constructor() { super('内容服务繁忙，请稍后重试'); this.status = 429; } }
// 原内容算法保留，只给它的几个缓存增加容量边界。
export class ContentCache extends Map {
  set(key, value) {
    this.delete(key);
    if (this.size >= 128) this.delete(this.keys().next().value);
    return super.set(key, value);
  }
}
let active = 0;
const releaseRequest = config => { if (config?.releaseContentSlot) { const release = config.releaseContentSlot; delete config.releaseContentSlot; release(); } };

const playbackRequest = new AsyncLocalStorage();
// 只给播放请求建立取消上下文，不取消首页和分类在后台补齐的请求。
export const withContentSignal = (signal, action) => playbackRequest.run(signal, action);
export function createContentClient(options = {}) {
  const { allowPrivateTargets = false, ...settings } = options;
  const client = axios.create({ timeout: 30000, proxy: false, maxRedirects: 5, ...settings, ...(!allowPrivateTargets ? {
    lookup: publicLookup,
    beforeRedirect: target => { assertPublicTarget(`${target.protocol}//${target.hostname}${target.port ? `:${target.port}` : ''}/`); target.lookup = publicLookup; },
  } : {}) });
  client.interceptors.request.use(config => {
    if (!allowPrivateTargets) assertPublicTarget(new URL(config.url, config.baseURL).href);
    const signal = playbackRequest.getStore();
    if (signal) config.signal = config.signal ? AbortSignal.any([signal, config.signal]) : signal;
    // 共享内容源与解密引擎共用上限，即使调用页面断开也不能积累无限在途请求。
    const maximum = Number(process.env.CONTENT_MAX_UPSTREAM_REQUESTS || 32);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096) throw new Error('内容源并发配置无效');
    if (active >= maximum) throw new ContentRequestError();
    active++; let released = false;
    config.releaseContentSlot = () => { if (!released) { released = true; active--; } };
    return config;
  });
  client.interceptors.response.use(response => {
    if (response.config.responseType === 'stream') {
      const release = () => releaseRequest(response.config);
      response.data.once('end', release); response.data.once('close', release); response.data.once('error', release);
    } else releaseRequest(response.config);
    return response;
  }, error => { releaseRequest(error.config); return Promise.reject(error); });
  return client;
}
