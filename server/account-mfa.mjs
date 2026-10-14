import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AccountError, digest, passwordMatches } from './account-store.mjs';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totp(secret,counter=Math.floor(Date.now()/30000)) {
  let bits=0,value=0;const bytes=[];
  for(const char of secret){const number=alphabet.indexOf(char);if(number<0)throw Error('动态码密钥格式无效');value=(value<<5)|number;bits+=5;if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}}
  const input=Buffer.alloc(8);input.writeBigUInt64BE(BigInt(counter));
  const hash=crypto.createHmac('sha1',Buffer.from(bytes)).update(input).digest(),offset=hash[19]&15;
  return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
const generateSecret=()=>{const bytes=crypto.randomBytes(20);let bits=0,value=0,result='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;result+=alphabet[(value>>>bits)&31];}}return result;};
export class AccountMfa {
  constructor(store,config={}) {this.store=store;this.config=config;}
  key() {
    if(this.config.ACCOUNT_MFA_KEY){if(!/^[a-f0-9]{64}$/i.test(this.config.ACCOUNT_MFA_KEY))throw new AccountError(503,'二次验证服务配置无效');return Buffer.from(this.config.ACCOUNT_MFA_KEY,'hex');}
    if(this.store.filename===':memory:')return this.store.memoryMfaKey ||= crypto.randomBytes(32);
    const file=path.join(path.dirname(this.store.filename),'.mfa-key');
    if(!fs.existsSync(file)){
      if(this.store.db.prepare('SELECT 1 FROM account_mfa LIMIT 1').get() || this.store.db.prepare("SELECT 1 FROM account_tokens WHERE purpose='mfa-setup' AND expires_at>? LIMIT 1").get(Date.now()))throw new AccountError(503,'二次验证密钥缺失，请恢复原密钥或联系管理员');
      try{fs.writeFileSync(file,crypto.randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
    }
    fs.chmodSync(file,0o600);const key=fs.readFileSync(file);if(key.length!==32)throw new AccountError(503,'二次验证服务配置无效');return key;
  }
  encrypt(secret) {const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key(),iv),data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
  decrypt(value) {const data=Buffer.from(value,'base64'),cipher=crypto.createDecipheriv('aes-256-gcm',this.key(),data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');}
  match(secret,code,last=-1) {
    if(typeof code!=='string'||!/^\d{6}$/.test(code))return null;
    const counter=Math.floor(Date.now()/30000);
    for(const value of [counter,counter-1,counter+1])if(value>last && crypto.timingSafeEqual(Buffer.from(code),Buffer.from(totp(secret,value))))return value;
    return null;
  }
  async primary(account,password) {
    const user=this.store.byId(account.id);
    if(user?.password_hash){if(!await passwordMatches(password,user.password_hash))throw new AccountError(401,'密码不正确');if(this.store.byId(account.id)?.password_hash!==user.password_hash)throw new AccountError(409,'登录状态已变化，请刷新页面');}
    else if(!(account.session_created_at>Date.now()-300000))throw new AccountError(401,'请重新登录后设置二次验证');
  }
  async setup(account,password,revalidate) {
    await this.primary(account,password);
    revalidate?.();
    if(this.store.db.prepare('SELECT 1 FROM account_mfa WHERE account_id=?').get(account.id) && !(account.session_mfa_at>Date.now()-12*3600000))throw new AccountError(403,'请先完成二次验证');
    const secret=generateSecret(),token=this.store.token('mfa-setup',account.id,{secret:this.encrypt(secret)},300000);
    return {secret,token,uri:`otpauth://totp/${encodeURIComponent(`Drama:${account.email}`)}?secret=${secret}&issuer=Drama&algorithm=SHA1&digits=6&period=30`};
  }
  enable(account,token,code) {
    return this.store.transaction(()=>{
      const row=typeof token==='string'&&token.length<=256&&this.store.db.prepare("SELECT * FROM account_tokens WHERE token_hash=? AND purpose='mfa-setup' AND account_id=? AND expires_at>?").get(digest(token),account.id,Date.now());
      if(!row)throw new AccountError(400,'二次验证设置已失效，请重新开始');
      const encrypted=JSON.parse(row.payload).secret,counter=this.match(this.decrypt(encrypted),code);
      if(counter===null)throw new AccountError(400,'动态码无效或已使用');
      if(this.store.db.prepare('SELECT 1 FROM account_mfa WHERE account_id=?').get(account.id) && !(account.session_mfa_at>Date.now()-12*3600000))throw new AccountError(403,'请先完成二次验证');
      const recovery=Array.from({length:10},()=>crypto.randomBytes(8).toString('hex'));
      this.store.db.prepare('INSERT INTO account_mfa VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET secret=excluded.secret,last_counter=excluded.last_counter,recovery=excluded.recovery,enabled_at=excluded.enabled_at').run(account.id,encrypted,counter,JSON.stringify(recovery.map(digest)),Date.now());
      this.store.db.prepare("DELETE FROM account_tokens WHERE account_id=? AND purpose='mfa-setup'").run(account.id);
      this.store.db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(account.id);
      return recovery;
    });
  }
  verify(account,code) {
    this.store.transaction(()=>{
      const row=this.store.db.prepare('SELECT * FROM account_mfa WHERE account_id=?').get(account.id);
      if(!row)throw new AccountError(400,'请先设置二次验证');
      const recovery=JSON.parse(row.recovery);
      if(typeof code==='string'&&/^[a-f0-9]{16}$/i.test(code)){
        const index=recovery.indexOf(digest(code.toLowerCase()));
        if(index<0)throw new AccountError(400,'动态码无效或已使用');
        recovery.splice(index,1);this.store.db.prepare('UPDATE account_mfa SET recovery=? WHERE account_id=?').run(JSON.stringify(recovery),account.id);return;
      }
      if(typeof code!=='string'||!/^\d{6}$/.test(code))throw new AccountError(400,'动态码无效或已使用');
      let decoded;try{decoded=this.decrypt(row.secret);}catch(error){if(error instanceof AccountError)throw error;throw new AccountError(503,'二次验证密钥不可用，请使用恢复码或联系管理员');}
      const counter=this.match(decoded,code,row.last_counter);
      if(counter===null)throw new AccountError(400,'动态码无效或已使用');
      this.store.db.prepare('UPDATE account_mfa SET last_counter=? WHERE account_id=?').run(counter,account.id);
    });
  }
}
