import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import http from 'node:http';
import { AuthenticationLimits, clientAddress } from '../server/auth-limits.mjs';
import { PlaybackGuard } from '../server/playback-guard.mjs';
import { createContentClient, withContentSignal } from '../shared/content-request.mjs';
import { readBody, readJson, protectRequestBody } from '../shared/http-json.mjs';

const request = (address, forwarded) => ({ socket: { remoteAddress: address }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('登录成功不累计失败额度，账户和地址的失败限制分别生效并按时恢复', () => {
  let now = 1000;
  const limits = new AuthenticationLimits({}, () => now), one = request('192.0.2.1'), two = request('192.0.2.2');
  for (let index = 0; index < 25; index++) { limits.request(one, 'login', 300); limits.checkLogin(one, 'viewer@example.test'); limits.successfulLogin(one, 'viewer@example.test'); }
  for (let index = 0; index < 10; index++) { limits.checkLogin(one, 'viewer@example.test'); limits.failedLogin(one, 'viewer@example.test'); }
  assert.throws(() => limits.checkLogin(one, 'viewer@example.test'), error => error.status === 429);
  assert.doesNotThrow(() => limits.checkLogin(one, 'another@example.test'));
  for (let index = 0; index < 10; index++) { limits.checkLogin(two, 'viewer@example.test'); limits.failedLogin(two, 'viewer@example.test'); }
  assert.throws(() => limits.checkLogin(request('192.0.2.3'), 'viewer@example.test'), error => error.status === 429);
  now += 900001;
  assert.doesNotThrow(() => limits.checkLogin(one, 'viewer@example.test'));
});

test('团队登录失败限制跨进程重建保留，过期后自动释放', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'drama-auth-limits-')),filename=path.join(directory,'content.sqlite');
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let now=1000;const notices=[];
  const first=new DatabaseSync(filename),source=request('192.0.2.20');
  const limits=new AuthenticationLimits({},()=>now,{db:first,onThreshold:value=>notices.push(value)});
  for(let index=0;index<10;index++){limits.checkLogin(source,'team:M-TEST');limits.failedLogin(source,'team:M-TEST');}
  assert.equal(notices.length,1);assert.equal(notices[0].dimension,'pair');
  assert.equal(first.prepare('SELECT key FROM team_auth_limits').all().some(row=>row.key.includes('192.0.2.20')||row.key.includes('M-TEST')),false);first.close();
  const second=new DatabaseSync(filename),restored=new AuthenticationLimits({},()=>now,{db:second});
  assert.throws(()=>restored.checkLogin(source,'team:M-TEST'),error=>error.status===429);
  now+=900001;assert.doesNotThrow(()=>restored.checkLogin(source,'team:M-TEST'));
  assert.equal(second.prepare('SELECT COUNT(*) AS n FROM team_auth_limits').get().n,0);second.close();
});

test('转发地址只有在直接代理可信时才生效，并从右侧排除伪造的前缀', () => {
  const trusted = new Set(['127.0.0.1', '192.0.2.10']);
  assert.equal(clientAddress(request('192.0.2.1', '198.51.100.9'), trusted), '192.0.2.1');
  assert.equal(clientAddress(request('127.0.0.1', '198.51.100.9, 192.0.2.1, 192.0.2.10'), trusted), '192.0.2.1');
  assert.equal(clientAddress(request('::ffff:127.0.0.1', '192.0.2.1'), trusted), '192.0.2.1');
  assert.equal(clientAddress(request('127.0.0.1', '无效地址'), trusted), '127.0.0.1');
});

function streamPair() {
  const req = new EventEmitter(), res = new EventEmitter();
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return { req, res };
}
test('播放并发按观众及全局限制，完成或中断只释放一次并取消在途请求', () => {
  const guard = new PlaybackGuard({ CONTENT_MAX_ACTIVE_STREAMS: 2, CONTENT_MAX_VIEWER_STREAMS: 1 });
  const first = streamPair(), second = streamPair();
  const signal = guard.acquire(first.req, first.res, '观众甲');
  assert.throws(() => guard.acquire(...Object.values(streamPair()), '观众甲'), error => error.status === 429);
  guard.acquire(second.req, second.res, '观众乙');
  assert.throws(() => guard.acquire(...Object.values(streamPair()), '观众丙'), error => error.status === 429);
  first.res.emit('close'); first.res.emit('finish'); first.req.emit('aborted');
  assert.equal(signal.aborted, true); assert.equal(guard.active, 1);
  const third = streamPair(); guard.acquire(third.req, third.res, '观众甲');
  second.res.emit('finish'); third.req.emit('aborted');
  assert.equal(guard.active, 0); assert.equal(guard.viewers.size, 0);
});

test('一个观众切走时中止真实在途源请求，不影响另一观众或后台目录请求', async t => {
  let arrived, closed;
  const arrival = new Promise(resolve => { arrived = resolve; }), closure = new Promise(resolve => { closed = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === '/playing') { res.writeHead(200); res.write('正在传输的真实测试字节'); res.once('close', closed); arrived(); }
    else res.end('目录正常');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = createContentClient({ proxy: false, allowPrivateTargets: true }), controller = new AbortController(), base = `http://127.0.0.1:${server.address().port}`;
  const playing = withContentSignal(controller.signal, () => client.get(`${base}/playing`));
  const canceled = assert.rejects(playing, error => error.code === 'ERR_CANCELED');
  await arrival;
  const another = withContentSignal(new AbortController().signal, () => client.get(`${base}/another`));
  controller.abort(); await canceled; await closure;
  assert.equal((await another).data, '目录正常');
  assert.equal((await client.get(`${base}/catalog`)).data, '目录正常');
  assert.equal((await withContentSignal(controller.signal, () => withContentSignal(undefined, () => client.get(`${base}/catalog`)))).data, '目录正常');
});

test('正常JSON保留中文数据，声明超限时在读取正文之前拒绝', async () => {
  const bytes = Buffer.from(JSON.stringify({ title: '真实中文剧名' })), input = Readable.from([bytes.subarray(0, 7), bytes.subarray(7)]);
  input.headers = { 'content-length': String(bytes.length) };
  assert.deepEqual(await readJson(input), { title: '真实中文剧名' });
  let rejected = false;
  const oversized = { headers: { 'content-length': '9' }, pause() {}, emit() { rejected = true; }, [Symbol.asyncIterator]() { throw Error('不应读取正文'); } };
  await assert.rejects(readBody(oversized, { maximum: 8 }), error => error.status === 413);
  assert.equal(rejected, true);
});

test('无长度分块超限立即停止，受控读取超时先返回错误再关闭连接', async () => {
  const oversized = Readable.from([Buffer.from('123456789')]); oversized.headers = {};
  await assert.rejects(readBody(oversized, { maximum: 8 }), error => error.status === 413);
  oversized.destroy();
  const slow = new PassThrough(), response = new EventEmitter(); slow.headers = {};
  const headers = {}; response.setHeader = (key, value) => { headers[key] = value; };
  protectRequestBody(slow, response);
  await assert.rejects(readBody(slow, { timeoutMs: 5 }), error => error.status === 408);
  assert.equal(headers.Connection, 'close'); assert.equal(response.shouldKeepAlive, false);
  response.emit('finish'); assert.equal(slow.destroyed, true);
});

test('小尺寸独立HTTP夹具中，超限仍返回完整413响应，随后正常请求可用', async t => {
  const server = http.createServer(async (req, res) => {
    protectRequestBody(req, res);
    try { await readBody(req, { maximum: 8 }); res.end('正常'); }
    catch (error) { res.writeHead(error.status); res.end('正文超限'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exceeded = await fetch(base, { method: 'POST', body: '123456789' });
  assert.equal(exceeded.status, 413); assert.equal(await exceeded.text(), '正文超限'); assert.equal(exceeded.headers.get('connection'), 'close');
  assert.equal(await (await fetch(base, { method: 'POST', body: '{}' })).text(), '正常');
});
