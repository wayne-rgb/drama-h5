import fs from 'node:fs';
import path from 'node:path';
import { AccountError } from './account-store.mjs';
import { positiveLimit } from './request-guard.mjs';

// 只核算个人资料目录，不删除用户记录；额度不足时暂停写入，读取和播放仍可使用。
export class PersonalStorage {
  constructor(directory, config = {}) {
    this.directory = directory;
    this.guestMaximum = positiveLimit(config,'PERSONAL_MAX_GUESTS',10000);
    this.guestBytes = positiveLimit(config,'PERSONAL_GUEST_TOTAL_BYTES',2*1024**3);
    this.totalBytes = positiveLimit(config,'PERSONAL_TOTAL_BYTES',10*1024**3);
    this.profileBytes = positiveLimit(config,'PERSONAL_GUEST_PROFILE_BYTES',32*1024**2);
    this.freeBytes = positiveLimit(config,'PERSONAL_MIN_FREE_BYTES',512*1024**2);
    this.entries = new Map(); this.reserved = 0; this.guestReserved = 0;
    for(const group of ['guests','accounts']) {
      const root=path.join(directory,group);
      if(!fs.existsSync(root))continue;
      for(const row of fs.readdirSync(root,{withFileTypes:true})) if(row.isDirectory() && /^[a-f0-9-]{36}$/.test(row.name)) {
        const location=path.join(root,row.name);this.entries.set(location,{guest:group==='guests',size:this.size(location)});
      }
    }
  }
  size(directory) {
    if(!fs.existsSync(directory))return 0;
    return fs.readdirSync(directory,{withFileTypes:true}).filter(row=>row.isFile()).reduce((sum,row)=>sum+fs.statSync(path.join(directory,row.name)).size,0);
  }
  totals() { let total=0,guest=0,count=0;for(const row of this.entries.values()){total+=row.size;if(row.guest){guest+=row.size;count++;}}return {total,guest,count}; }
  refresh(directory) { const row=this.entries.get(directory);if(row)row.size=this.size(directory); }
  ensureFree() {const disk=fs.statfsSync(this.directory,{bigint:true});if(disk.bavail*disk.bsize<BigInt(this.freeBytes+this.reserved))throw new AccountError(507,'存储空间不足，请稍后重试');}
  check(directory, guest, bytes) {
    this.refresh(directory);const {total,guest:used,count}=this.totals();
    if(guest && !this.entries.has(directory) && count>=this.guestMaximum || total+this.reserved+bytes>this.totalBytes || guest && (used+this.guestReserved+bytes>this.guestBytes || (this.entries.get(directory)?.size||0)+bytes>this.profileBytes)) throw new AccountError(507,'个人资料存储额度不足，请稍后重试');
    const disk=fs.statfsSync(this.directory,{bigint:true});
    if(disk.bavail*disk.bsize<BigInt(this.freeBytes+this.reserved+bytes))throw new AccountError(507,'存储空间不足，请稍后重试');
  }
  open(directory, guest) {
    if(this.entries.has(directory)){this.refresh(directory);return;}
    this.check(directory,guest,256*1024);
    if(!this.entries.has(directory))this.entries.set(directory,{guest,size:0});
  }
  attach(req,res,directory,guest,databases) {
    if(['GET','HEAD'].includes(req.method))return;
    // SQLite硬上限阻止持续写入增长；现有超额资料保持可读，不缩小或删除旧文件。
    if(guest)for(const db of databases){const page=db.prepare('PRAGMA page_size').get().page_size,current=db.prepare('PRAGMA page_count').get().page_count;db.exec(`PRAGMA max_page_count=${Math.max(current,Math.floor(this.profileBytes/2/page))}; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=262144;`);}
    const bytes=256*1024+Math.min(Number(req.headers['content-length'])||2097152,2097152)*4;
    this.check(directory,guest,bytes);this.reserved+=bytes;if(guest)this.guestReserved+=bytes;
    let released=false;const release=()=>{if(released)return;released=true;this.reserved-=bytes;if(guest)this.guestReserved-=bytes;this.refresh(directory);};
    res.once('finish',release);res.once('close',release);
    const previous=req.revalidateAccess;
    req.revalidateAccess=()=>{previous?.();this.refresh(directory);const disk=fs.statfsSync(this.directory,{bigint:true});if(disk.bavail*disk.bsize<BigInt(this.freeBytes))throw new AccountError(507,'存储空间不足，请稍后重试');};
  }
}
