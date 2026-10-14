import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RecommendationService} from '../server/recommendation-service.mjs';
const row=(type,page,i)=>({id:`${type}-${page}-${i}`,title:'剧',tags:'爱情',contentType:type});
test('自有上架内容不等待外部源，并沿用模式过滤和会话去重',async()=>{
 const local={id:'local-content',title:'自有内容',tags:'爱情',contentType:'real-drama'};
 const service=new RecommendationService({fetchPool:()=>new Promise(()=>{}),fetchLocalPool:()=>[local],readProfile:()=>({}),settleMs:1});
 const result=await service.page('session-local-content',1);
 assert.deepEqual(result.items.map(item=>item.id),[local.id]);
 assert.deepEqual((await service.page('session-local-content',1)).items,result.items);
 const otherMode=new RecommendationService({fetchPool:async()=>[],fetchLocalPool:()=>[local],readProfile:()=>({preferences:{recommendationMode:'ai-drama'}}),settleMs:1});
 assert.equal((await otherMode.page('session-local-filter',1)).items.length,0);
});
test('session pages are stable, concurrent retries do not duplicate, sessions vary',async()=>{
 const service=new RecommendationService({fetchPool:async({type,page})=>Array.from({length:24},(_,i)=>row(type,page,i)),readProfile:()=>({}),settleMs:5});
 const [a,b]=await Promise.all([service.page('session-aaaaaaaa',1),service.page('session-aaaaaaaa',1)]);
 assert.deepEqual(a,b);assert.equal(a.items.length,24);assert.equal(new Set(a.items.map(r=>r.contentType)).size,3);
 const second=await service.page('session-aaaaaaaa',2);assert.ok(!second.items.some(r=>a.items.some(old=>old.id===r.id)));
 assert.notDeepEqual(a.items.map(r=>r.id),(await service.page('session-bbbbbbbb',1)).items.map(r=>r.id));
});
test('one hung source cannot block the first page; failed sources are supplemented',async()=>{
 const service=new RecommendationService({fetchPool:({type,page})=>type==='real-drama'?Promise.resolve(Array.from({length:30},(_,i)=>row(type,page,i))):type==='comic-drama'?Promise.reject(Error('offline')):new Promise(()=>{}),readProfile:()=>({}),settleMs:10});
 const started=Date.now();const result=await service.page('session-cccccccc',1);
 assert.ok(Date.now()-started<200);assert.equal(result.items.length,24);
});
test('bad session/page rejected; mode reads local profile; exhaustion does not recycle IDs',async()=>{
 const service=new RecommendationService({fetchPool:async({type})=>[row(type,1,0)],readProfile:()=>({preferences:{recommendationMode:'ai-drama'}}),settleMs:0});
 await assert.rejects(service.page('bad',1),/session/);
 await assert.rejects(service.page('session-dddddddd',0),/page/);
 const first=await service.page('session-dddddddd',1);assert.equal(first.items[0].contentType,'ai-drama');
 assert.equal((await service.page('session-dddddddd',2)).items.length,0);
});
test('valid empty source is exhaustion, not a network error',async()=>{
 const service=new RecommendationService({fetchPool:async()=>[],readProfile:()=>({}),settleMs:0});
 assert.deepEqual((await service.page('session-eeeeeeee',1)).items,[]);
});
