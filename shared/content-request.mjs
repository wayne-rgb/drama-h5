import { AsyncLocalStorage } from 'node:async_hooks';
import axios from 'axios';

const playbackRequest = new AsyncLocalStorage();
// 只给播放请求建立取消上下文，不取消首页和分类在后台补齐的请求。
export const withContentSignal = (signal, action) => playbackRequest.run(signal, action);
export function createContentClient(options = {}) {
  const client = axios.create({ timeout: 30000, ...options });
  client.interceptors.request.use(config => {
    const signal = playbackRequest.getStore();
    if (signal) config.signal = config.signal ? AbortSignal.any([signal, config.signal]) : signal;
    return config;
  });
  return client;
}
