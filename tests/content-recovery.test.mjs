import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContentStore } from '../server/content-store.mjs';
import { createUploads } from '../server/content-upload.mjs';

let sampleDirectory, video;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg==','base64');
const admin = {id:'回归管理员',name:'回归管理员'};
before(async () => {
  sampleDirectory = await fs.mkdtemp(path.join(os.tmpdir(),'drama-media-sample-'));
  const target = path.join(sampleDirectory,'sample.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=160x240:r=24:d=1','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',target]);
  video = await fs.readFile(target);
});
after(async () => { if (sampleDirectory) await fs.rm(sampleDirectory,{recursive:true,force:true}); });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'drama-recovery-'));
  let store = new ContentStore(directory), uploads = createUploads(store,directory);
  t.after(async () => { uploads.close(); store.close(); await fs.rm(directory,{recursive:true,force:true}); });
  return {
    directory,
    get store() {return store;}, get uploads() {return uploads;},
    reopen() { uploads.close(); store.close(); store = new ContentStore(directory); uploads = createUploads(store,directory); },
    async add(bytes,kind='video',state='processing',final=false) {
      const asset = uploads.create(admin,{name:kind==='video'?'验收.mp4':'验收.png',kind,mime:kind==='video'?'video/mp4':'image/png',size:bytes.length});
      if (final) await fs.unlink(uploads.filePath(asset.id,'.part'));
      await fs.writeFile(uploads.filePath(asset.id,final?'':'.part'),bytes);
      store.db.prepare('UPDATE content_assets SET offset=size,status=?,error=? WHERE id=?').run(state,state==='failed'?'处理被服务重启中断，请重新上传':null,asset.id);
      return asset.id;
    },
  };
}
async function waitFor(fixture, ids, state='ready') {
  const deadline = Date.now()+10000;
  while (ids.some(id=>fixture.store.asset(id).status!==state) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
  for (const id of ids) assert.equal(fixture.store.asset(id).status,state,fixture.store.asset(id).error || '处理状态未完成');
}

test('重启恢复完整视频、已重命名文件、旧中断记录与完成上传的封面，素材标识不变', async t => {
  const saved = await fixture(t);
  const ids = [await saved.add(video),await saved.add(video,'video','processing',true),await saved.add(video,'video','failed'),await saved.add(image,'image','uploading')];
  saved.reopen();
  await waitFor(saved,ids);
  for (const id of ids) {
    const asset = saved.store.asset(id);
    assert.equal(asset.error,null);
    assert.equal((await fs.stat(saved.uploads.filePath(id))).size,asset.size);
    await assert.rejects(fs.stat(saved.uploads.filePath(id,'.part')),error=>error.code==='ENOENT');
  }
  assert.equal(saved.store.asset(ids[0]).metadata.width,160);
  assert.equal((await fs.readFile(saved.uploads.filePath(ids[0]))).toString('ascii',4,8),'ftyp');
});

test('重启发现磁盘尾部不完整时按实际长度继续上传，不重复创建素材', async t => {
  const saved = await fixture(t), id = await saved.add(video);
  const offset = Math.floor(video.length/2);
  await fs.truncate(saved.uploads.filePath(id,'.part'),offset);
  saved.reopen();
  assert.equal(saved.store.asset(id).status,'uploading');
  assert.equal(saved.store.asset(id).offset,offset);
  const req = {headers:{'content-range':`bytes ${offset}-${video.length-1}/${video.length}`},async *[Symbol.asyncIterator](){yield video.subarray(offset);}};
  await saved.uploads.chunk(req,admin,id);
  await waitFor(saved,[id]);
  assert.equal(saved.store.db.prepare('SELECT COUNT(*) AS count FROM content_assets').get().count,1);
});

test('缺失文件明确失败并释放待处理额度，不误报为处理工具缺失', async t => {
  const saved = await fixture(t), id = await saved.add(video);
  await fs.unlink(saved.uploads.filePath(id,'.part'));
  saved.reopen(); await waitFor(saved,[id],'failed');
  assert.equal(saved.store.asset(id).error,'上传文件不存在，请重新上传');
  assert.equal(saved.store.db.prepare("SELECT COUNT(*) AS count FROM content_assets WHERE status IN ('processing','uploading')").get().count,0);
});

test('创建上传的数据库写入失败不会留下无记录的文件或占用上传额度', async t => {
  const saved = await fixture(t);
  saved.store.db.exec('PRAGMA query_only=ON');
  assert.throws(()=>saved.uploads.create(admin,{name:'验收.png',kind:'image',mime:'image/png',size:image.length}));
  assert.equal(saved.store.db.prepare('SELECT COUNT(*) AS count FROM content_assets').get().count,0);
  assert.deepEqual(await fs.readdir(path.join(saved.directory,'media')),[]);
  saved.store.db.exec('PRAGMA query_only=OFF');
});

test('自有分类分页统计真实上架数量，筛选和题材按内容类型隔离', async t => {
  const saved = await fixture(t), cover = await saved.add(image,'image'), clip = await saved.add(video);
  saved.reopen(); await waitFor(saved,[cover,clip]);
  for (let index=0;index<28;index++) {
    const real = index<26;
    const series=saved.store.saveSeries(admin,{title:`正常分类回归${index}`,description:'真实上传素材的分类测试',contentType:real?'real-drama':'ai-drama',language:'en',categoryIds:[real?'romance':'horror'],coverId:cover});
    saved.store.saveEpisode(admin,series.id,{number:1,assetId:clip});
    saved.store.publish(admin,series.id,'published');
  }
  saved.store.saveSeries(admin,{title:'未发布的草稿',contentType:'real-drama',language:'en',categoryIds:['romance']});
  const first=saved.store.listPage({type:'real-drama',tag:'romance',page:1}),second=saved.store.listPage({type:'real-drama',tag:'romance',page:2});
  assert.equal(first.items.length,24); assert.equal(second.items.length,2);
  assert.equal(first.pagination.total,26); assert.equal(first.pagination.totalPages,2);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,26);
  assert.deepEqual(saved.store.categoryTags('real-drama',[{id:'romance',name:'爱情'}]),[{id:'romance',name:'爱情'}]);
  assert.equal(saved.store.listPage({type:'real-drama',tag:'horror'}).pagination.total,0);
});
