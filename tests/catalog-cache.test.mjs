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

test('同一来源不能用不同查询独占全部外部目录并发', async () => {
  const cache = new CatalogCache({ maximum: 4, perActor: 2 });
  const releases = [];
  const load = value => new Promise(resolve => releases.push(() => resolve(value)));
  const first = cache.read('查询一', () => load('一'), false, '198.51.100.8');
  const second = cache.read('查询二', () => load('二'), false, '198.51.100.8');
  await assert.rejects(cache.read('查询三', () => load('三'), false, '198.51.100.8'), error => error.status === 429);
  const other = cache.read('其他来源', () => load('可用'), false, '203.0.113.9');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 3);
  for (const release of releases) release();
  assert.deepEqual(await Promise.all([first, second, other]), ['一', '二', '可用']);
  assert.equal(cache.actors.size, 0);
});
