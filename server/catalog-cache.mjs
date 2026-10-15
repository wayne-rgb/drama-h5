import { AccountError } from './account-store.mjs';

// 自有结果先返回，外部列表在后台补齐；同一请求合并，缓存只保存成功的真实结果。
export class CatalogCache {
  constructor({ maximum = 32, perActor = 16 } = {}) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(perActor) || perActor < 1 || perActor > maximum) throw new Error('目录请求并发配置无效');
    this.values = new Map(); this.pending = new Map(); this.actors = new Map();
    this.maximum = maximum; this.perActor = perActor;
  }
  async read(key, load, hasLocal = false, actor = '') {
    const cached = this.values.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    let request = this.pending.get(key);
    const actorKey = typeof actor === 'string' ? actor.slice(0, 200) : '';
    if (!request && this.pending.size < this.maximum && (!actorKey || (this.actors.get(actorKey) || 0) < this.perActor)) {
      if (actorKey) this.actors.set(actorKey, (this.actors.get(actorKey) || 0) + 1);
      request = Promise.resolve().then(load).then(value => {
        this.values.delete(key);
        this.values.set(key, { value, until: Date.now() + 60000 });
        if (this.values.size > 128) this.values.delete(this.values.keys().next().value);
        return value;
      }).finally(() => {
        this.pending.delete(key);
        if (actorKey) {
          const count = (this.actors.get(actorKey) || 1) - 1;
          if (count) this.actors.set(actorKey, count); else this.actors.delete(actorKey);
        }
      });
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
