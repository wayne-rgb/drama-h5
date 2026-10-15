import test from 'node:test';import assert from 'node:assert/strict';import { mkdtempSync } from 'node:fs';import { tmpdir } from 'node:os';import path from 'node:path';
import { LibraryStore } from '../shared/library-store.mjs';
test('local snapshot survives database reopening and obsolete sync metadata is discarded',()=>{
 const file=path.join(mkdtempSync(path.join(tmpdir(),'hongguotv-library-')),'library.sqlite');let store=new LibraryStore(file);store.write({kind:'search',key:'续播',op:'set',value:{query:'续播'}});store.setMeta('syncConfig',{url:'https://obsolete.example.test',key:'废弃'});store.close();store=new LibraryStore(file);try{assert.deepEqual(store.snapshot().searchHistory,['续播']);assert.equal(store.getMeta('syncConfig'),null);assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_ack'").get(),undefined);}finally{store.close();}
});
test('failed multi-event transaction does not expose a partially applied snapshot',()=>{
 const store=new LibraryStore(':memory:');try{
  const event={id:'a',deviceId:'d',seq:1,kind:'search',key:'q',op:'set',at:1,value:{query:'q'}};
  assert.throws(()=>store.importEvents([event,{...event,id:'different-id'}]));assert.deepEqual(store.snapshot().searchHistory,[]);assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM library_events').get().count,0);
 }finally{store.close();}
});
