import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {TrafficBudget} from '../server/traffic-budget.mjs';
import {PlaybackGuard} from '../server/playback-guard.mjs';

const tinyLimits={CONTENT_DAILY_BYTES:1,CONTENT_VIEWER_DAILY_BYTES:1,CONTENT_IP_DAILY_BYTES:1,CONTENT_VIP_RESERVED_BYTES:1};

test('默认监测模式兼容旧日额度配置，超过全站、观众和IP阈值仍能继续观看',t=>{
  const budget=new TrafficBudget(':memory:',tinyLimits,()=>86400000);t.after(()=>budget.close());
  const day=budget.currentDay(),keys=budget.keys('观众','网络');
  for(const key of keys)budget.add.run(day,key,10);
  assert.equal(budget.enforce,false);assert.equal(keys.length,3);assert.doesNotThrow(()=>budget.check('观众','网络'));
  const meter=budget.meter('观众','网络');meter.consume(4);meter.setPrivileged(true);meter.consume(4);meter.close();
  for(const key of keys)assert.equal(budget.read.get(day,key).bytes,18);
  assert.doesNotThrow(()=>budget.check('观众','网络',true));assert.equal(budget.available(day,keys),Infinity);
});

test('同一网络下不同观众不会因累计日流量互相阻断，监测记录保留实际发送字节',t=>{
  const budget=new TrafficBudget(':memory:',tinyLimits);t.after(()=>budget.close());
  for(const viewer of ['甲','乙','丙']){const meter=budget.meter(viewer,'共享网络');meter.consume(8);meter.close();assert.doesNotThrow(()=>budget.check(viewer,'共享网络'));}
  const day=budget.currentDay();assert.equal(budget.read.get(day,'global').bytes,24);assert.equal(budget.read.get(day,budget.keys('甲','共享网络')[2]).bytes,24);
});

test('每日身份明细满额后新观众仍能播放，只保留有界明细和准确全站汇总',t=>{
  const budget=new TrafficBudget(':memory:',tinyLimits,()=>86400000);t.after(()=>budget.close());
  const day=budget.currentDay();budget.db.exec('BEGIN IMMEDIATE');
  budget.add.run(day,'global',0);for(let index=1;index<10000;index++)budget.add.run(day,`已有明细:${index}`,0);budget.db.exec('COMMIT');
  const meter=budget.meter('新观众','新网络');meter.consume(2);meter.setPrivileged(false);meter.consume(3);meter.close();
  assert.equal(budget.count.get(day).count,10000);assert.equal(budget.read.get(day,'global').bytes,5);assert.equal(budget.read.get(day,budget.keys('新观众','新网络')[1]),undefined);
});

test('监测写入故障不会抛给播放器，也不会留下部分事务记录',t=>{
  let now=86400000;const budget=new TrafficBudget(':memory:',tinyLimits,()=>now);t.after(()=>budget.close());
  budget.db.exec("CREATE TRIGGER monitoring_failure BEFORE INSERT ON traffic_budget BEGIN SELECT RAISE(FAIL,'独立回归模拟统计写入故障'); END;");
  const meter=budget.meter('观众','网络');assert.doesNotThrow(()=>meter.consume(4));assert.doesNotThrow(()=>meter.consume(4));assert.doesNotThrow(()=>meter.close());
  assert.equal(budget.count.get(budget.currentDay()).count,0);assert.doesNotThrow(()=>budget.check('观众','网络'));
  assert.equal(budget.meter('另一观众','网络'),null);
  now+=60001;budget.db.exec('DROP TRIGGER monitoring_failure');const recovered=budget.meter('恢复后的观众','网络');recovered.consume(4);recovered.close();
  assert.equal(budget.read.get(budget.currentDay(),'global').bytes,4);
});

test('监测账本不可用时HTTP视频仍可传输，VIP权限复核仍能中断后续字节',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'drama-monitor-failure-')),file=path.join(directory,'resource-usage.sqlite');
  await fs.writeFile(file,'独立测试的无效统计账本');
  const budget=new TrafficBudget(file,tinyLimits),guard=new PlaybackGuard({},budget);let revoked=false,continueStream;
  assert.equal(budget.db,null);assert.doesNotThrow(()=>budget.check('观众','网络'));assert.equal(budget.meter('观众','网络'),null);
  const server=http.createServer((req,res)=>{
    req.revalidatePlayback=()=>{if(revoked)throw Error('独立回归模拟VIP失效');};guard.acquire(req,res,'观众','网络');
    res.setHeader('Content-Type','video/mp4');res.write(Buffer.from('1234'));continueStream=()=>res.end(Buffer.from('5678'));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});budget.close();await fs.rm(directory,{recursive:true,force:true});});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/video`),reader=response.body.getReader();assert.equal(response.status,200);assert.equal(Buffer.from((await reader.read()).value).toString(),'1234');
  revoked=true;continueStream();await assert.rejects(reader.read());assert.equal(guard.active,0);
});

test('明确开启紧急日额度时才拒绝播放，监测故障也不会绕过显式硬限制',t=>{
  const budget=new TrafficBudget(':memory:',{...tinyLimits,CONTENT_VIP_RESERVED_BYTES:0,CONTENT_ENFORCE_DAILY_LIMITS:'1'});t.after(()=>budget.close());
  const meter=budget.meter('观众','网络');meter.consume(1);meter.close();assert.throws(()=>budget.check('观众','网络'),error=>error.status===429);
  assert.throws(()=>new TrafficBudget('/dev/null/不可用账本',{...tinyLimits,CONTENT_ENFORCE_DAILY_LIMITS:'1'}));
});
