import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { AccountError, digest } from './account-store.mjs';
import { positiveLimit } from './request-guard.mjs';

// 与观看分析分库存储；只记录保护所需的日期、身份摘要及响应字节额度。
export class TrafficBudget {
  constructor(filename, config = {}, clock = Date.now) {
    this.clock = clock;
    this.limits = [positiveLimit(config, 'CONTENT_DAILY_BYTES', 100 * 1024 ** 3), positiveLimit(config, 'CONTENT_VIEWER_DAILY_BYTES', 5 * 1024 ** 3), positiveLimit(config, 'CONTENT_IP_DAILY_BYTES', 50 * 1024 ** 3)];
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS traffic_budget(day INTEGER NOT NULL, identity TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(day,identity));');
    this.read = this.db.prepare('SELECT bytes FROM traffic_budget WHERE day=? AND identity=?');
    this.add = this.db.prepare('INSERT INTO traffic_budget VALUES(?,?,?) ON CONFLICT(day,identity) DO UPDATE SET bytes=bytes+excluded.bytes');
    this.refund = this.db.prepare('UPDATE traffic_budget SET bytes=MAX(0,bytes-?) WHERE day=? AND identity=?');
    this.count = this.db.prepare('SELECT COUNT(*) AS count FROM traffic_budget WHERE day=?');
    this.day = -1;
  }
  currentDay() {
    const day = Math.floor(this.clock() / 86400000);
    if (this.day !== day) { this.db.prepare('DELETE FROM traffic_budget WHERE day<?').run(day - 1); this.day = day; }
    return day;
  }
  keys(viewer, address) { return ['global', `viewer:${digest(viewer)}`, `ip:${digest(address)}`]; }
  available(day, keys) { return Math.min(...keys.map((key, index) => this.limits[index] - (this.read.get(day, key)?.bytes || 0))); }
  exhausted() { const error = new AccountError(429, '播放流量已达保护上限，请稍后再试'); error.retryAfter = Math.max(1, Math.ceil((86400000 - this.clock() % 86400000) / 1000)); return error; }
  check(viewer, address) { if (this.available(this.currentDay(), this.keys(viewer, address)) <= 0) throw this.exhausted(); }
  meter(viewer, address) {
    const keys = this.keys(viewer, address); let day = this.currentDay(), remaining = 0, closed = false;
    const release = () => {
      if (!remaining) return;
      this.db.exec('BEGIN IMMEDIATE');
      try { for (const key of keys) this.refund.run(remaining, day, key); this.db.exec('COMMIT'); remaining = 0; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    };
    return {
      consume: size => {
        if (closed) throw this.exhausted();
        if (day !== this.currentDay()) { release(); day = this.currentDay(); }
        if (remaining < size) {
          // 按小块预留，所有并发流共同遵守上限；正常关闭退还尚未写出的字节。
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const available = this.available(day, keys), needed = size - remaining;
            if (available < needed) throw this.exhausted();
            const missing = keys.filter(key => !this.read.get(day, key)).length;
            if (missing && this.count.get(day).count + missing > 10000) throw this.exhausted();
            const reserved = Math.min(available, Math.max(1024 * 1024, needed));
            for (const key of keys) this.add.run(day, key, reserved);
            this.db.exec('COMMIT'); remaining += reserved;
          } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        }
        remaining -= size;
      },
      close: () => { if (closed) return; closed = true; release(); },
    };
  }
  close() { this.db.close(); }
}
