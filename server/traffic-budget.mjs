import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { AccountError, digest } from './account-store.mjs';
import { positiveLimit } from './request-guard.mjs';

// 与观看分析分库存储；只记录保护所需的日期、身份摘要及响应字节额度。
export class TrafficBudget {
  constructor(filename, config = {}, clock = Date.now) {
    this.clock = clock;
    this.keyDirectory = filename === ':memory:' ? null : `${filename}.keys`;
    // 日流量默认仅统计与告警；必须明确打开紧急开关，额度才会拒绝播放。
    this.enforce = config.CONTENT_ENFORCE_DAILY_LIMITS === '1';
    let invalid=false;
    const limit=(key,fallback)=>{try{return positiveLimit(config,key,fallback);}catch(error){if(this.enforce)throw error;invalid=true;return fallback;}};
    this.limits = [limit('CONTENT_DAILY_BYTES',100*1024**3),limit('CONTENT_VIEWER_DAILY_BYTES',5*1024**3),limit('CONTENT_IP_DAILY_BYTES',50*1024**3)];
    const reserve=Number(config.CONTENT_VIP_RESERVED_BYTES??Math.floor(this.limits[0]/5));
    if(!Number.isSafeInteger(reserve)||reserve<0){if(this.enforce)throw new Error('会员流量保留额度配置无效');invalid=true;}
    this.vipReserve = Math.min(Number.isSafeInteger(reserve)&&reserve>=0?reserve:Math.floor(this.limits[0]/5),this.limits[0]);
    if(invalid)console.warn('日流量监测配置无效，已采用默认参考值，正常播放不受影响');
    this.warnedDay=-1;this.failureWarned=false;this.detailWarnedDay=-1;this.suspendedUntil=0;
    try {
      if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(filename);
      if (filename !== ':memory:') chmodSync(filename, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS traffic_budget(day INTEGER NOT NULL, identity TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(day,identity));');
      this.read = this.db.prepare('SELECT bytes FROM traffic_budget WHERE day=? AND identity=?');
      this.add = this.db.prepare('INSERT INTO traffic_budget VALUES(?,?,?) ON CONFLICT(day,identity) DO UPDATE SET bytes=bytes+excluded.bytes');
      this.refund = this.db.prepare('UPDATE traffic_budget SET bytes=MAX(0,bytes-?) WHERE day=? AND identity=?');
      this.count = this.db.prepare('SELECT COUNT(*) AS count FROM traffic_budget WHERE day=?');
      this.day = -1;
      this.currentDay();
    } catch(error) {
      try{this.db?.close();}catch{}
      if(this.enforce)throw error;
      this.db=null;this.warnFailure();
    }
  }
  warnFailure(){this.suspendedUntil=this.clock()+60000;if(!this.failureWarned){this.failureWarned=true;console.warn('播放流量统计暂不可用，保留正常播放');}}
  dailyKey(day) {
    if (!this.keyDirectory) return randomBytes(32);
    mkdirSync(this.keyDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.keyDirectory, 0o700);
    const filename = path.join(this.keyDirectory, `${day}.key`);
    try {
      const key = readFileSync(filename);
      if (key.length !== 32) throw new Error('当日流量统计密钥无效');
      chmodSync(filename, 0o600);
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // 已有当日明细时，密钥丢失不能通过重新生成来重置保护额度。
    if (this.db.prepare("SELECT 1 FROM traffic_budget WHERE day=? AND (identity LIKE 'viewer:v2:%' OR identity LIKE 'ip:v2:%') LIMIT 1").get(day)) throw new Error('当日流量统计密钥缺失');
    try { writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: 'wx', flush: true }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const key = readFileSync(filename);
    if (key.length !== 32) throw new Error('当日流量统计密钥无效');
    return key;
  }
  identity(kind, value, key = this.dayKey) {
    return `${kind}:v2:${createHmac('sha256', key).update(`${kind}:${value}`).digest('hex')}`;
  }
  currentDay() {
    const day = Math.floor(this.clock() / 86400000);
    if (this.day !== day) {
      const key = this.dailyKey(day);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM traffic_budget WHERE day<?').run(day - 1);
        // 跨日只留下汇总；旧固定摘要按原摘要转换，保留当日已消费额度。
        this.db.prepare("DELETE FROM traffic_budget WHERE day<>? AND (identity LIKE 'viewer:%' OR identity LIKE 'ip:%')").run(day);
        const legacy = this.db.prepare("SELECT identity,bytes FROM traffic_budget WHERE day=? AND (identity LIKE 'viewer:%' OR identity LIKE 'ip:%') AND identity NOT LIKE 'viewer:v2:%' AND identity NOT LIKE 'ip:v2:%'").all(day);
        for (const row of legacy) {
          const match = /^(viewer|ip):([a-f0-9]{64})$/.exec(row.identity);
          if (match) this.add.run(day, this.identity(match[1], match[2], key), row.bytes);
          this.db.prepare('DELETE FROM traffic_budget WHERE day=? AND identity=?').run(day, row.identity);
        }
        this.db.exec('COMMIT');
      } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
      if (this.keyDirectory) for (const name of readdirSync(this.keyDirectory)) {
        if (/^\d+\.key$/.test(name) && Number(name.slice(0, -4)) < day) {
          try { unlinkSync(path.join(this.keyDirectory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.dayKey = key;
      this.day = day;
    }
    return day;
  }
  keys(viewer, address, privileged=false) {
    this.currentDay();
    return ['global', this.identity('viewer', digest(viewer)), this.identity('ip', digest(address)), ...(this.enforce && !privileged && this.vipReserve ? ['public'] : [])];
  }
  available(day, keys) { if(!this.enforce)return Infinity;return Math.min(...keys.map((key, index) => (key==='public'?this.limits[0]-this.vipReserve:this.limits[index]) - (this.read.get(day, key==='public'?'global':key)?.bytes || 0))); }
  exhausted() { const error = new AccountError(429, '播放流量已达保护上限，请稍后再试'); error.retryAfter = Math.max(1, Math.ceil((86400000 - this.clock() % 86400000) / 1000)); return error; }
  check(viewer, address, privileged=false) { if (this.enforce && this.available(this.currentDay(), this.keys(viewer, address,privileged)) <= 0) throw this.exhausted(); }
  meter(viewer, address, privileged=false) {
    if(!this.db || !this.enforce && this.clock()<this.suspendedUntil)return null;
    let day;try{day=this.currentDay();}catch(error){if(this.enforce)throw error;this.warnFailure();return null;}
    let keys = this.keys(viewer, address,privileged), remaining = 0, closed = false, disabled = false;
    const release = () => {
      if (!remaining) return;
      this.db.exec('BEGIN IMMEDIATE');
      try { for (const key of keys) this.refund.run(remaining, day, key); this.db.exec('COMMIT'); remaining = 0; }
      catch (error) { try{this.db.exec('ROLLBACK');}catch{}throw error; }
    };
    return {
      setPrivileged: value => { if(!this.enforce)return;const next=this.keys(viewer,address,!!value);privileged=!!value;if(next.length!==keys.length){release();keys=next;} },
      consume: size => {
        if(disabled)return;
        if(!this.enforce&&this.clock()<this.suspendedUntil){disabled=true;return;}
        try {
        if (closed) throw this.exhausted();
        if (day !== this.currentDay()) { release(); day = this.currentDay(); keys = this.keys(viewer, address, privileged); }
        if (remaining < size) {
          // 按小块预留，所有并发流共同遵守上限；正常关闭退还尚未写出的字节。
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const available = this.available(day, keys), needed = size - remaining;
            if (available < needed) throw this.exhausted();
            const missing = keys.filter(key => !this.read.get(day, key)).length;
            if (missing && this.count.get(day).count + missing > 10000) {
              if(this.enforce)throw this.exhausted();
              // 明细数量有界，超出后只更新现有计数与全站汇总，不阻止新观众。
              keys=keys.filter(key=>key==='global'||this.read.get(day,key));
              if(this.detailWarnedDay!==day){this.detailWarnedDay=day;console.warn('播放流量身份明细已达统计上限，保留汇总与正常播放');}
            }
            const reserved = Math.min(available, Math.max(1024 * 1024, needed));
            for (const key of keys) this.add.run(day, key, reserved);
            this.db.exec('COMMIT'); remaining += reserved;
            if(this.warnedDay!==day && (this.read.get(day,'global')?.bytes||0)>=this.limits[0]*0.8){this.warnedDay=day;console.warn(JSON.stringify({event:this.enforce?'播放流量保护预警':'播放流量监测预警',enforced:this.enforce,remainingBytes:Math.max(0,this.limits[0]-(this.read.get(day,'global')?.bytes||0))}));}
          } catch (error) { try{this.db.exec('ROLLBACK');}catch{}throw error; }
        }
        remaining -= size;
        } catch(error) {
          if(this.enforce)throw error;
          disabled=true;try{release();}catch{}this.warnFailure();
        }
      },
      close: () => { if (closed) return; closed = true;if(!this.enforce&&this.clock()<this.suspendedUntil)return;try{release();}catch(error){if(this.enforce)throw error;this.warnFailure();} },
    };
  }
  close() { this.db?.close(); }
}
