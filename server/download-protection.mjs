import {Transform} from 'node:stream';
import {positiveLimit} from './request-guard.mjs';

// 持续传输按短周期平滑速度，首屏和正常预缓冲保留突发空间，不累计每日观看硬额度。
export class DownloadProtection {
  constructor(config={},clock=Date.now){
    this.clock=clock;this.viewerRate=positiveLimit(config,'DOWNLOAD_VIEWER_BYTES_PER_SECOND',8*1024**2);
    this.globalRate=positiveLimit(config,'DOWNLOAD_GLOBAL_BYTES_PER_SECOND',64*1024**2);
    this.viewerBurst=positiveLimit(config,'DOWNLOAD_VIEWER_BURST_BYTES',32*1024**2);
    this.globalBurst=positiveLimit(config,'DOWNLOAD_GLOBAL_BURST_BYTES',128*1024**2);
    this.rows=new Map();this.prunedAt=0;
  }
  delay(viewer,size,rate=this.viewerRate){
    const now=this.clock();
    if(now-this.prunedAt>=60000){for(const [key,row] of this.rows)if(key!=='global'&&now-row.at>300000)this.rows.delete(key);this.prunedAt=now;}
    const entries=[['global',this.globalRate,this.globalBurst],[`viewer:${viewer}`,Math.max(this.viewerRate,rate||0),this.viewerBurst]];
    let delay=0;
    for(const [key,speed,burst] of entries){
      let row=this.rows.get(key);
      if(!row){if(this.rows.size>=10000){const oldest=[...this.rows.keys()].find(key=>key!=='global');this.rows.delete(oldest);}row={tokens:burst,at:now};this.rows.set(key,row);}
      row.tokens=Math.min(burst,row.tokens+Math.max(0,now-row.at)*speed/1000)-size;row.at=now;
      delay=Math.max(delay,Math.ceil(-row.tokens*1000/speed));
    }
    return Math.max(0,delay);
  }
  async wait(req,res,viewer,size){
    if(req.aborted||res.destroyed)throw Error('传输已结束');
    const delay=this.delay(viewer,size,req.downloadRate);if(!delay)return;
    await new Promise((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{clearTimeout(timer);res.off('close',cancel);req.off('aborted',cancel);};
      const cancel=()=>{
        if(settled)return;settled=true;cleanup();
        // 尚未发送的等待字节退回突发空间，取消下载不能耗尽其他观众的传输预留。
        for(const [key,burst] of [['global',this.globalBurst],[`viewer:${viewer}`,this.viewerBurst]]){const row=this.rows.get(key);if(row)row.tokens=Math.min(burst,row.tokens+size);}
        reject(Error('传输已结束'));
      };
      const timer=setTimeout(()=>{if(settled)return;settled=true;cleanup();resolve();},delay);timer.unref();res.once('close',cancel);req.once('aborted',cancel);
      if(req.aborted||res.destroyed)cancel();
    });
  }
  pipe(req,res,source,viewer){
    const limiter=new Transform({transform:(chunk,encoding,done)=>{this.wait(req,res,viewer,chunk.length).then(()=>done(null,chunk),done);}});
    const stop=()=>{source.destroy();limiter.destroy();};res.once('close',stop);
    source.once('error',()=>res.destroy());limiter.once('error',()=>res.destroy());
    limiter.once('close',()=>res.off('close',stop));source.pipe(limiter).pipe(res);
  }
}

export function cacheMatches(req,etag){return String(req.headers['if-none-match']||'').split(',').some(value=>['*',etag,`W/${etag}`].includes(value.trim()));}

// 外部高清流也按真实MP4时长计算码率，不能让默认下载速度误伤倍速或多设备观看。
export function mp4TransferRate(total,header){
  if(!Buffer.isBuffer(header)||!Number.isSafeInteger(total)||total<=0)return undefined;
  const find=(start,end,type)=>{
    for(let offset=start;offset+8<=end;){
      let size=header.readUInt32BE(offset),head=8;
      if(size===1){if(offset+16>end)return null;size=Number(header.readBigUInt64BE(offset+8));head=16;}else if(!size)size=end-offset;
      if(!Number.isSafeInteger(size)||size<head||offset+size>end)return null;
      if(header.toString('ascii',offset+4,offset+8)===type)return {start:offset+head,end:offset+size};offset+=size;
    }
    return null;
  };
  const moov=find(0,header.length,'moov'),mvhd=moov&&find(moov.start,moov.end,'mvhd');if(!mvhd)return undefined;
  const version=header[mvhd.start],scaleOffset=mvhd.start+(version===1?20:12),durationOffset=scaleOffset+4;
  if(![0,1].includes(version)||durationOffset+(version===1?8:4)>mvhd.end)return undefined;
  const scale=header.readUInt32BE(scaleOffset),duration=version===1?Number(header.readBigUInt64BE(durationOffset)):header.readUInt32BE(durationOffset);
  return scale>0&&Number.isSafeInteger(duration)&&duration>0?24*total*scale/duration:undefined;
}
