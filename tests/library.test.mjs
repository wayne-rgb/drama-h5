import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryStore } from '../shared/library-store.mjs';

const event = (id, at, value, extra = {}) => ({ id, deviceId: 'device-a', seq: Number(id.replace(/\D/g,'')) || 1, kind: 'history', key: '9007199254740993', op: 'set', at, value, ...extra });
const progress = positionMs => ({ seriesId:'9007199254740993',title:'剧',episodeId:'9007199254740995',episodeNumber:2,positionMs,durationMs:90000,completed:false });

test('import preserves equal-time deletion ordering and does not change the local snapshot',()=>{
 const store=new LibraryStore(':memory:');try{
  store.setMeta('deviceId','c');
  store.importEvents([{id:'clear',deviceId:'b',seq:1,kind:'favorite',key:'*',op:'clear',at:100,value:null},{id:'set',deviceId:'a',seq:1,kind:'favorite',key:'s',op:'set',at:100,value:{id:'s',title:'剧'}}]);
  assert.equal(store.snapshot().favorites.length,0);
 }finally{store.close();}
});

test('library accepts newer backward seeks, ignores delayed events, and deduplicates retries', () => {
  const store = new LibraryStore(':memory:');
  try {
    store.importEvents([event('e1',100,progress(50000)),event('e2',200,progress(2000)),event('e3',150,progress(40000))]);
    assert.equal(store.snapshot().history[0].positionMs,2000);
    const first = store.db.prepare('SELECT COUNT(*) AS count FROM library_events').get().count;
    store.importEvents([event('e2',200,progress(2000))]);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM library_events').get().count,first);
  } finally { store.close(); }
});
test('clear and per-record deletion cannot be undone by older offline events', () => {
  const store = new LibraryStore(':memory:');
  try {
    store.importEvents([event('e1',100,progress(5000)),event('e2',200,null,{op:'clear',key:'*'}),event('e3',150,progress(9000))]);
    assert.equal(store.snapshot().history.length,0);
    store.importEvents([event('e4',300,progress(1000)),event('e5',400,null,{op:'delete'}),event('e6',350,progress(2000))]);
    assert.equal(store.snapshot().history.length,0);
    store.importEvents([event('e7',500,progress(3000))]);
    assert.equal(store.snapshot().history[0].positionMs,3000);
  } finally { store.close(); }
});
