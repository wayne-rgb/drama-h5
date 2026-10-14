import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fork } from 'node:child_process';
import { RequestGuard } from '../server/request-guard.mjs';
import { TrafficBudget } from '../server/traffic-budget.mjs';
import { PlaybackGuard } from '../server/playback-guard.mjs';
import { isPublicAddress, assertPublicTarget, publicLookup } from '../shared/public-target.mjs';
import { createContentClient, ContentCache } from '../shared/content-request.mjs';

test('请求频率按观众和IP叠加，换游客身份不会恢复IP额度，到期正常恢复', () => {
  let now = 1000;
  const guard = new RequestGuard({ CONTENT_VIEWER_REQUESTS_PER_MINUTE: 2, CONTENT_IP_REQUESTS_PER_MINUTE: 3 }, () => now);
  guard.checkVideo('甲', '地址甲'); guard.checkVideo('甲', '地址甲');
  assert.throws(() => guard.checkVideo('甲', '地址乙'), error => error.status === 429);
  guard.checkVideo('乙', '地址甲');
  assert.throws(() => guard.checkVideo('丙', '地址甲'), error => error.status === 429);
  now += 60001; assert.doesNotThrow(() => guard.checkVideo('甲', '地址甲'));
});

test('公开接口及密码计算并发有界，完成和关闭只释放一次', () => {
  const guard = new RequestGuard({ API_MAX_ACTIVE_REQUESTS: 2 });
  const pair = () => ({ req: new EventEmitter(), res: new EventEmitter() });
  const first = pair(), second = pair();
  guard.acquire(first.req, first.res, '甲', '甲'); guard.acquire(second.req, second.res, '乙', '乙');
  assert.throws(() => guard.acquire(...Object.values(pair()), '丙', '丙'), error => error.status === 429);
  first.res.emit('finish'); first.res.emit('close'); first.req.emit('aborted'); second.res.emit('close');
  assert.equal(guard.active.size, 0);
  const costly = new RequestGuard(), pairs = Array.from({ length: 4 }, pair);
  for (const [index, row] of pairs.entries()) costly.acquire(row.req, row.res, String(index), String(index), true);
  assert.throws(() => costly.acquire(...Object.values(pair()), '另一个', '另一个', true), error => error.status === 429);
  for (const row of pairs) row.res.emit('finish');
});

test('全站请求额度同时覆盖不同来源，管理上传保留独立分块额度', () => {
  const guard = new RequestGuard({ API_GLOBAL_REQUESTS_PER_MINUTE: 1, CONTENT_GLOBAL_REQUESTS_PER_MINUTE: 1 });
  const req = new EventEmitter(), res = new EventEmitter();
  guard.acquire(req, res, '甲', '甲'); res.emit('finish');
  assert.throws(() => guard.acquire(new EventEmitter(), new EventEmitter(), '乙', '乙'), error => error.status === 429);
  const uploadReq = new EventEmitter(), uploadRes = new EventEmitter();
  assert.doesNotThrow(() => guard.acquire(uploadReq, uploadRes, '管理员', '管理地址', false, true)); uploadRes.emit('finish');
  guard.checkVideo('甲', '甲');
  assert.throws(() => guard.checkVideo('乙', '乙'), error => error.status === 429);
  const staticRes = new EventEmitter(); guard.acquireStatic(new EventEmitter(), staticRes, '地址'); staticRes.emit('finish');
  assert.throws(() => guard.acquireStatic(new EventEmitter(), new EventEmitter(), '另一地址'), error => error.status === 429);
});

test('视频额度只保留已消费字节，独立数据库重开不清零，UTC换日恢复', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-traffic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = 86400000;
  const filename = path.join(directory, 'resource-usage.sqlite'), config = { CONTENT_DAILY_BYTES: 12, CONTENT_VIEWER_DAILY_BYTES: 8, CONTENT_IP_DAILY_BYTES: 10 };
  let budget = new TrafficBudget(filename, config, () => now);
  const meter = budget.meter('甲', '地址'); meter.consume(4);
  assert.throws(() => meter.consume(5), error => error.status === 429);
  meter.close(); meter.close(); budget.close();
  budget = new TrafficBudget(filename, config, () => now);
  try {
    assert.equal(budget.available(1, budget.keys('甲', '地址')), 4);
    assert.equal(budget.db.prepare('SELECT bytes FROM traffic_budget WHERE identity=?').get('global').bytes, 4);
    const second = budget.meter('甲', '地址'); second.consume(4); second.close();
    assert.throws(() => budget.check('甲', '其他地址'), error => error.status === 429 && error.retryAfter === 86400);
    now += 86400000; assert.doesNotThrow(() => budget.check('甲', '地址'));
  } finally { budget.close(); }
});

test('同时播放共享来源额度，小块预留不超额，中途关闭退回未发出的字节', () => {
  const budget = new TrafficBudget(':memory:', { CONTENT_DAILY_BYTES: 20, CONTENT_VIEWER_DAILY_BYTES: 20, CONTENT_IP_DAILY_BYTES: 20 });
  try {
    const first = budget.meter('甲', '同一地址'), second = budget.meter('乙', '同一地址');
    first.consume(4);
    assert.throws(() => second.consume(1), error => error.status === 429);
    first.close(); second.consume(8); second.close();
    assert.equal(budget.available(budget.currentDay(), budget.keys('乙', '同一地址')), 8);
  } finally { budget.close(); }
});

test('真实小尺寸HTTP媒体响应计量包含write和end，HEAD及JSON不扣视频字节', async t => {
  const budget = new TrafficBudget(':memory:', { CONTENT_DAILY_BYTES: 8, CONTENT_VIEWER_DAILY_BYTES: 8, CONTENT_IP_DAILY_BYTES: 8 });
  const guard = new PlaybackGuard({}, budget);
  const server = http.createServer((req, res) => {
    try {
      guard.acquire(req, res, '观众', '地址');
      if (req.url === '/json') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); }
      else { res.setHeader('Content-Type', 'video/mp4'); if (req.method === 'HEAD') res.end(); else { res.write(Buffer.from('1234')); res.end(Buffer.from('5678')); } }
    } catch (error) { res.writeHead(error.status, { 'Retry-After': String(error.retryAfter || 1) }); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); budget.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(`${base}/json`)).text(), '{}');
  assert.equal((await fetch(`${base}/video`, { method: 'HEAD' })).status, 200);
  assert.equal(await (await fetch(`${base}/video`)).text(), '12345678');
  const limited = await fetch(`${base}/video`); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await fetch(`${base}/video`, { method: 'HEAD' })).status, 200);
  assert.equal(guard.active, 0);
});

test('内容代理仅接受公网HTTP地址，IPv4、IPv6、映射地址及带凭据地址都执行边界检查', () => {
  for (const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const url of ['file:///etc/passwd','http://127.0.0.1/','http://[::1]/','http://2130706433/','http://user:password@example.com/','http://localhost/']) assert.throws(() => assertPublicTarget(url));
  assert.equal(assertPublicTarget('https://hongguoduanju.com/').hostname, 'hongguoduanju.com');
});

test('DNS解析到本机的域名及重定向地址在实际连接前被拒绝', async () => {
  await assert.rejects(new Promise((resolve, reject) => publicLookup('localhost', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), /内容源地址不允许访问/);
  const client = createContentClient();
  assert.throws(() => client.defaults.beforeRedirect({ protocol: 'http:', hostname: '127.0.0.1', port: '80' }), /内容源地址不允许访问/);
});

test('真实本机夹具只使用明确测试豁免；生产客户端拒绝内网目标且并发槽正常释放', async t => {
  let responded;
  const waiting = new Promise(resolve => { responded = resolve; });
  const server = http.createServer((req, res) => { if (req.url === '/wait') { res.writeHead(200); res.write('实际字节'); responded(); } else res.end('正常'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, client = createContentClient({ allowPrivateTargets: true });
  await assert.rejects(createContentClient().get(base), /内容源地址不允许访问/);
  const old = process.env.CONTENT_MAX_UPSTREAM_REQUESTS; process.env.CONTENT_MAX_UPSTREAM_REQUESTS = '1';
  try {
    const stream = await client.get(`${base}/wait`, { responseType: 'stream' }); await waiting;
    await assert.rejects(client.get(base), error => error.status === 429);
    const closed = new Promise(resolve => stream.data.once('close', resolve)); stream.data.destroy(); await closed;
    assert.equal((await client.get(base)).data, '正常');
  } finally { if (old === undefined) delete process.env.CONTENT_MAX_UPSTREAM_REQUESTS; else process.env.CONTENT_MAX_UPSTREAM_REQUESTS = old; }
});

test('内容缓存容量有界，更新原条目仍保留最新真实内容', () => {
  const cache = new ContentCache();
  for (let index = 0; index < 129; index++) cache.set(index, { title: `真实内容${index}` });
  assert.equal(cache.size, 128); assert.equal(cache.has(0), false);
  cache.set(1, { title: '更新内容' }); cache.set(129, { title: '新增内容' });
  assert.equal(cache.size, 128); assert.equal(cache.get(1).title, '更新内容'); assert.equal(cache.has(2), false);
});

test('隔离静态目录拒绝隐藏文件、源码映射和越界链接，正常构建文件与手机路由可访问', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-static-boundary-')), web = path.join(directory, 'web');
  await fs.mkdir(web);
  await fs.writeFile(path.join(web, 'index.html'), '<!doctype html><title>正常手机页面</title>');
  await fs.writeFile(path.join(web, 'app.js'), 'console.log("正常构建文件")');
  await fs.writeFile(path.join(web, '.env'), '仅限独立测试的占位数据');
  await fs.writeFile(path.join(web, 'app.js.map'), '仅限独立测试的源码映射');
  await fs.writeFile(path.join(directory, 'private.js'), '仅限独立测试的私有文件');
  await fs.symlink(path.join(directory, 'private.js'), path.join(web, 'linked.js'));
  const child = fork(new URL('../server/index.mjs', import.meta.url), [], { env: { ...process.env, HG_HOST: '127.0.0.1', PORT: '0', HG_DATA_DIR: directory, HG_WEB_DIR: web, HG_ENV_FILE: path.join(directory, 'absent.env'), APP_ORIGIN: 'http://127.0.0.1:4318', ADMIN_ACCOUNT_IDS: '', ADMIN_EMAILS: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', BILLING_PROVIDER: 'none', TRUSTED_PROXY_IPS: '', API_VIEWER_REQUESTS_PER_MINUTE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.send({ type: 'shutdown' }); await exit; } await fs.rm(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('隔离静态服务启动超时')),10000); child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error('隔离静态服务提前退出')); }); child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); } }); });
  const base = `http://127.0.0.1:${port}`;
  for (const route of ['/.env','/app.js.map','/linked.js','/missing.js']) assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.match(await (await fetch(`${base}/admin`)).text(), /正常手机页面/);
  assert.equal((await fetch(`${base}/api/rank/types`)).status, 200);
  const limited = await fetch(`${base}/api/rank/types`);
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
});
