import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogCache } from '../server/catalog-cache.mjs';

test('自有目录不等待外部结果，同一外部请求合并并在成功后正常补齐', async () => {
  const cache = new CatalogCache(); let resolve, calls = 0;
  const pending = new Promise(done => { resolve = done; });
  const load = () => { calls++; return pending; };
  assert.equal(await cache.read('分类:真人剧', load, true), null);
  assert.equal(await cache.read('分类:真人剧', load, true), null);
  assert.equal(calls, 1);
  const waiting = cache.read('分类:真人剧', load);
  const result = { items: [{id:'7503745441910017049',title:'首辅娇娘'}] };
  resolve(result);
  assert.deepEqual(await waiting, result);
  assert.deepEqual(await cache.read('分类:真人剧', load, true), result);
  assert.equal(calls, 1);
});

test('外部读取失败不覆盖自有结果，也不把失败缓存成空内容', async () => {
  const cache = new CatalogCache();
  const unavailable = () => Promise.reject(Error('隔离测试中的外部源不可用'));
  assert.equal(await cache.read('首页', unavailable, true), null);
  await assert.rejects(cache.read('首页', unavailable), /外部源不可用/);
  const restored = { items: [{id:'7503745441910017049',title:'首辅娇娘'}] };
  assert.deepEqual(await cache.read('首页', async () => restored), restored);
});
