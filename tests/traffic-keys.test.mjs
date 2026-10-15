import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { digest } from '../server/account-store.mjs';
import { TrafficBudget } from '../server/traffic-budget.mjs';

const dayLength = 86400000;
const limits = { CONTENT_ENFORCE_DAILY_LIMITS: '1', CONTENT_DAILY_BYTES: 100, CONTENT_VIEWER_DAILY_BYTES: 20, CONTENT_IP_DAILY_BYTES: 30, CONTENT_VIP_RESERVED_BYTES: 0 };
function temporaryFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'drama-traffic-keys-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'resource-usage.sqlite');
}

test('统计标识按日更换，同日重启额度不清零，密钥不存入统计库', t => {
  const filename = temporaryFile(t);
  let now = dayLength, budget = new TrafficBudget(filename, limits, () => now);
  t.after(() => budget.close());
  const previous = budget.keys('team:成员甲', '192.0.2.1');
  const meter = budget.meter('team:成员甲', '192.0.2.1'); meter.consume(7); meter.close();
  assert.notEqual(previous[1], `viewer:${digest('team:成员甲')}`);
  assert.notEqual(previous[2], `ip:${digest('192.0.2.1')}`);
  assert.notEqual(previous[1].split(':').at(-1), previous[2].split(':').at(-1));
  const key = fs.readFileSync(`${filename}.keys/1.key`);
  assert.equal(key.length, 32);
  assert.equal(fs.statSync(`${filename}.keys`).mode & 0o777, 0o700);
  assert.equal(fs.statSync(`${filename}.keys/1.key`).mode & 0o777, 0o600);
  budget.close(); budget = new TrafficBudget(filename, limits, () => now);
  assert.deepEqual(budget.keys('team:成员甲', '192.0.2.1'), previous);
  assert.equal(budget.available(1, previous), 13);
  assert.equal(fs.readFileSync(filename).includes(key), false);
  now += dayLength;
  const next = budget.keys('team:成员甲', '192.0.2.1');
  assert.notEqual(next[1], previous[1]); assert.notEqual(next[2], previous[2]);
  assert.equal(fs.existsSync(`${filename}.keys/1.key`), false);
  assert.deepEqual(budget.db.prepare('SELECT identity,bytes FROM traffic_budget WHERE day=1').all().map(row => ({ ...row })), [{ identity: 'global', bytes: 7 }]);
  assert.equal(fs.readFileSync(filename).includes(Buffer.from(previous[2])), false);
});

test('旧摘要升级保留当日各级额度，删除过期个体明细并清理文件残留', t => {
  const filename = temporaryFile(t), db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE traffic_budget(day INTEGER NOT NULL,identity TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(day,identity))');
  const add = db.prepare('INSERT INTO traffic_budget VALUES(?,?,?)');
  const viewer = `viewer:${digest('team:成员甲')}`, ip = `ip:${digest('192.0.2.1')}`;
  for (const day of [1, 2]) for (const identity of ['global', 'public', viewer, ip]) add.run(day, identity, 9);
  db.close();
  const budget = new TrafficBudget(filename, limits, () => 2 * dayLength); t.after(() => budget.close());
  const keys = budget.keys('team:成员甲', '192.0.2.1');
  assert.equal(budget.available(2, keys), 11);
  for (const identity of [...keys, 'public']) assert.equal(budget.read.get(2, identity).bytes, 9);
  assert.equal(budget.read.get(1, 'global').bytes, 9);
  assert.equal(budget.db.prepare("SELECT COUNT(*) AS n FROM traffic_budget WHERE identity IN (?,?)").get(viewer, ip).n, 0);
  assert.equal(budget.db.prepare('SELECT COUNT(*) AS n FROM traffic_budget WHERE day=1').get().n, 2);
  for (const name of [filename, `${filename}-wal`]) if (fs.existsSync(name)) {
    const bytes = fs.readFileSync(name); assert.equal(bytes.includes(Buffer.from(viewer)), false); assert.equal(bytes.includes(Buffer.from(ip)), false);
  }
  const meter = budget.meter('team:成员甲', '192.0.2.1'); meter.consume(11); meter.close();
  assert.throws(() => budget.check('team:成员甲', '192.0.2.2'), error => error.status === 429);
});

test('跨天持续传输与会员资格变化使用新日额度，正确退回未发送字节', t => {
  let now = dayLength;
  const budget = new TrafficBudget(':memory:', { ...limits, CONTENT_VIP_RESERVED_BYTES: 10 }, () => now); t.after(() => budget.close());
  const before = budget.keys('成员甲', '共享网络');
  const first = budget.meter('成员甲', '共享网络'), second = budget.meter('成员乙', '共享网络');
  first.consume(4); second.consume(3);
  now += dayLength;
  first.setPrivileged(true); first.consume(5); first.setPrivileged(false); first.consume(2); first.close();
  second.consume(6); second.close();
  const next = budget.keys('成员甲', '共享网络');
  assert.equal(budget.read.get(2, next[0]).bytes, 13);
  assert.equal(budget.read.get(2, next[1]).bytes, 7);
  assert.equal(budget.read.get(2, next[2]).bytes, 13);
  assert.equal(budget.read.get(2, 'public').bytes, 8);
  assert.equal(budget.read.get(1, 'global').bytes, 7);
  assert.equal(budget.read.get(2, before[1]), undefined);
  assert.equal(budget.read.get(2, before[2]), undefined);
});

test('当日密钥丢失或损坏不能重置强制额度，监测模式仍允许正常播放', t => {
  const filename = temporaryFile(t), budget = new TrafficBudget(filename, limits, () => dayLength);
  const meter = budget.meter('成员甲', '网络'); meter.consume(4); meter.close(); budget.close();
  const keyFile = `${filename}.keys/1.key`, key = fs.readFileSync(keyFile);
  fs.unlinkSync(keyFile);
  assert.throws(() => new TrafficBudget(filename, limits, () => dayLength), /密钥缺失/);
  assert.equal(fs.existsSync(keyFile), false);
  fs.writeFileSync(keyFile, '损坏密钥');
  assert.throws(() => new TrafficBudget(filename, limits, () => dayLength), /密钥无效/);
  const monitoring = new TrafficBudget(filename, {}, () => dayLength); t.after(() => monitoring.close());
  assert.equal(monitoring.db, null); assert.doesNotThrow(() => monitoring.check('成员甲', '网络')); assert.equal(monitoring.meter('成员甲', '网络'), null);
  fs.writeFileSync(keyFile, key);
  const restored = new TrafficBudget(filename, limits, () => dayLength); t.after(() => restored.close());
  assert.equal(restored.available(1, restored.keys('成员甲', '网络')), 16);
});
