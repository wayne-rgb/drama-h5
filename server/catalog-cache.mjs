import { AccountError } from './account-store.mjs';

// 自有结果先返回，外部列表在后台补齐；同一请求合并，缓存只保存成功的真实结果。
export class CatalogCache {
  constructor() { this.values = new Map(); this.pending = new Map(); }
  async read(key, load, hasLocal = false) {
    const cached = this.values.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    let request = this.pending.get(key);
    if (!request && this.pending.size < 32) {
      request = Promise.resolve().then(load).then(value => {
        this.values.delete(key);
        this.values.set(key, { value, until: Date.now() + 60000 });
        if (this.values.size > 128) this.values.delete(this.values.keys().next().value);
        return value;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, request);
    }
    if (hasLocal) {
      request?.catch(() => { console.warn('[外部列表暂不可用]: 已保留自有内容'); });
      return cached?.value || null;
    }
    if (!request) throw new AccountError(429, '操作过于频繁，请稍后重试');
    return request;
  }
}
