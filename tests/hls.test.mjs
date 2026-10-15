import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ContentStore } from '../server/content-store.mjs';
import { createUploads } from '../server/content-upload.mjs';
import { createHlsJobs } from '../server/hls-jobs.mjs';
import { LocalMediaStorage } from '../server/media-storage.mjs';
import { renditionLevels, mediaUsage } from '../server/hls-encoding.mjs';
import { AccountStore, passwordHash } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { createContentService } from '../server/content-service.mjs';
import { PlaybackGuard } from '../server/playback-guard.mjs';

const execute = promisify(execFile), admin = { id: '转码管理员', name: '转码管理员' };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg==', 'base64');
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(check(), '后台任务未在期限内达到预期状态');
}

test('新上传真实转码失败保留MP4，重试恢复后多档成品完整且时间轴对齐，重启不转旧素材', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-hls-job-'));
  const store = new ContentStore(directory), storage = new LocalMediaStorage(directory, {});
  let uploads = createUploads(store, directory, { CONTENT_HLS_FFMPEG_PATH: '/不存在的转码工具' }, storage), jobs;
  t.after(async () => { await uploads.close(); await jobs?.close(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const source = path.join(directory, '真实源.mp4');
  await execute('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=s=720x1280:r=24:d=8','-an','-c:v','libx264','-threads','1','-preset','ultrafast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',source]);
  const bytes = await fs.readFile(source);
  const asset = uploads.create(admin, { kind: 'video', mime: 'video/mp4', name: '第1集.mp4', size: bytes.length });
  for (let start = 0; start < bytes.length; start += 1048576) {
    const end = Math.min(start + 1048576, bytes.length);
    await uploads.chunk({ headers: { 'content-range': `bytes ${start}-${end - 1}/${bytes.length}` }, async *[Symbol.asyncIterator]() { yield bytes.subarray(start, end); } }, admin, asset.id);
  }
  await until(() => store.hlsJob(asset.id)?.status === 'failed');
  assert.equal(store.asset(asset.id).status, 'ready');
  assert.equal(store.asset(asset.id).metadata.audio, false);
  assert.equal((await fs.readFile(storage.filePath(asset.id))).toString('ascii', 4, 8), 'ftyp');
  assert.match(store.hlsJob(asset.id).error, /转码工具不可用/);
  await uploads.close();
  jobs = createHlsJobs(store, directory, storage, {});
  jobs.retry(asset.id); jobs.retry(asset.id);
  await until(() => store.hlsJob(asset.id)?.status === 'processing');
  await jobs.close();
  assert.equal(store.hlsJob(asset.id).status, 'processing');
  jobs = createHlsJobs(store, directory, storage, {});
  await until(() => store.hlsJob(asset.id)?.status === 'ready');
  const job = store.hlsJob(asset.id);
  assert.deepEqual(job.manifest.levels.map(level => level.key), ['480P', '720P']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM content_hls_jobs').get().count, 1);
  assert.equal(job.reserved_bytes, 0);
  assert.equal(Object.values(job.manifest.files).reduce((sum, size) => sum + size, 0), job.size);
  const timelines = [];
  for (const level of job.manifest.levels) {
    const playlist = await fs.readFile(storage.renditionPath(job.object_key, `r${level.size}.m3u8`), 'utf8');
    assert.match(playlist, /#EXT-X-ENDLIST/);
    timelines.push([...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1])));
    const segment = storage.renditionPath(job.object_key, `s${level.size}-000000.ts`);
    const { stdout } = await execute('ffprobe', ['-v','error','-show_streams','-of','json',segment]);
    const streams = JSON.parse(stdout).streams;
    assert.equal(streams[0].codec_name, 'h264'); assert.equal(streams[0].width, level.width); assert.equal(streams[0].height, level.height);
    assert.equal(streams.some(stream => stream.codec_type === 'audio'), false);
  }
  assert.deepEqual(timelines[0], timelines[1]);
  assert.deepEqual(timelines[0], [4, 4]);
  assert.ok(mediaUsage(storage.root) >= job.size + store.asset(asset.id).size);
  await assert.rejects(fs.stat(storage.renditionPath(`${job.object_key}.pending`)), error => error.code === 'ENOENT');
  await jobs.close(); jobs = null;
  // 只登记已有MP4，不创建任何新转码任务；启动恢复限于明确登记的任务。
  store.db.prepare('DELETE FROM content_hls_jobs WHERE asset_id=?').run(asset.id);
  uploads = createUploads(store, directory, {}, storage);
  assert.equal(store.hlsJob(asset.id), null);
});

test('HLS主清单、子清单与分片统一鉴权并计量实际字节，拒绝跨剧、失效版本和符号链接', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-hls-http-'));
  const accounts = new AccountStore(path.join(directory, 'accounts.sqlite'));
  const owner = accounts.create({ email: 'hls-admin@example.invalid', name: '权限管理员' });
  const viewer = accounts.create({ email: 'hls-viewer@example.invalid', name: '观看者' });
  const config = { APP_ORIGIN: 'http://127.0.0.1:4318', ADMIN_ACCOUNT_IDS: owner.id };
  const content = createContentService(directory, accounts, createAccountService(accounts, config), { detail: async () => { throw Error('不应访问外站'); } }, config);
  const store = content.store, storage = new LocalMediaStorage(directory, {});
  let counted = 0;
  const guard = new PlaybackGuard({}, { check() {}, meter: () => ({ consume(size) { counted += size; }, close() {} }) });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, config.APP_ORIGIN), match = /^\/api\/episodes\/(\d+)\/(play|qualities|stream|hls\/[^/]+\/[^/]+)$/.exec(url.pathname);
      if (!match) { res.writeHead(404); return res.end(); }
      guard.acquire(req, res, '验收观众');
      await content.ownPlayback(req, res, match[2].startsWith('hls/') ? 'hls' : match[2], await content.resolveEpisode(req, url.searchParams.get('seriesId'), match[1]));
    } catch (error) { res.writeHead(error.status || 500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); content.close(); accounts.close(); await fs.rm(directory, { recursive: true, force: true }); });
  // 使用真实FFmpeg成品，不以占位字符串冒充可播放媒体。
  const id = '12345678-1234-1234-1234-123456789012', cover = '12345678-1234-1234-1234-123456789013';
  await execute('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=blue:s=160x240:r=24:d=4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart','-f','mp4',storage.filePath(id)]);
  const size = (await fs.stat(storage.filePath(id))).size;
  await fs.writeFile(storage.filePath(cover), image);
  for (const [assetId, kind, mime, length, metadata] of [[id,'video','video/mp4',size,{width:160,height:240,duration:4}], [cover,'image','image/png',image.length,null]]) store.db.prepare("INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at) VALUES(?,?,?,?,?,?,'ready',?,?)").run(assetId, owner.id, '真实素材', kind, mime, length, metadata ? JSON.stringify(metadata) : null, Date.now());
  store.saveAssetLocation({ assetId: id, storageId: 'local', objectKey: id, version: id, size });
  const series = store.saveSeries(owner, { title: 'HLS权限测试', contentType: 'real-drama', language: 'en', coverId: cover });
  for (let number = 1; number <= 4; number++) store.saveEpisode(owner, series.id, { number, assetId: id });
  store.publish(owner, series.id, 'published');
  const version = '12345678-1234-1234-1234-123456789014', key = `hls-${version}`, folder = storage.renditionPath(key);
  await fs.mkdir(folder);
  await execute('ffmpeg', ['-v','error','-i',storage.filePath(id),'-c','copy','-f','hls','-hls_time','4','-hls_list_size','0','-hls_playlist_type','vod','-hls_segment_filename',path.join(folder,'s160-%06d.ts'),path.join(folder,'r160.m3u8')]);
  await fs.writeFile(path.join(folder, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=160x240\nr160.m3u8\n');
  const files = {}; for (const name of await fs.readdir(folder)) files[name] = (await fs.stat(path.join(folder, name))).size;
  store.db.prepare("INSERT INTO content_hls_jobs(asset_id,status,version,storage_id,object_key,size,manifest,updated_at) VALUES(?,'ready',?,'local',?,?,?,?)").run(id,version,key,Object.values(files).reduce((sum,size)=>sum+size,0),JSON.stringify({levels:[{key:'160P',size:160,width:160,height:240}],files}),Date.now());
  const base = `http://127.0.0.1:${server.address().port}`, episodes = store.detail(series.id).episodes;
  const team = content.team, editor = team.create(await passwordHash('转码运营权限测试2026'), ['editor'], [series.id]);
  const moderator = team.create(editor.password_hash, ['moderator'], [series.id]);
  const retryUrl = new URL(`/api/admin/uploads/${id}/hls/retry`, config.APP_ORIGIN);
  const editorRequest = { method: 'POST', headers: { cookie: `drama_team_session=${team.session(editor, true)}` } };
  store.db.prepare('UPDATE content_assets SET owner_id=?,series_id=? WHERE id=?').run(editor.id,series.id,id);
  assert.equal(team.authorize(editorRequest,retryUrl).id,editor.id);
  assert.throws(() => team.authorize({ method: 'POST', headers: { cookie: `drama_team_session=${team.session(moderator,true)}` } },retryUrl), error => error.status === 403);
  team.db.prepare('DELETE FROM team_series_members WHERE member_id=?').run(editor.id);
  assert.throws(() => team.authorize(editorRequest,retryUrl), error => error.status === 403);
  const cookie = `hg_account_session=${accounts.session(viewer.id)}`;
  const get = (episode, resource, options = {}) => fetch(`${base}/api/episodes/${episode.id}/${resource}?seriesId=${series.id}`, { ...options, headers: { Cookie: cookie, ...options.headers } });
  const source = await (await get(episodes[0], 'play')).json();
  assert.equal(source.format, 'hls'); assert.equal(source.fallback.format, 'mp4');
  assert.equal((await (await get(episodes[0], 'qualities')).json()).defaultQuality, 'auto');
  for (const name of Object.keys(files)) {
    const before = counted, response = await get(episodes[0], `hls/${version}/${name}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(counted - before, bytes.length);
    if (name.endsWith('.m3u8')) assert.match(bytes.toString(), new RegExp(`seriesId=${series.id}`));
    assert.equal((await get(episodes[3], `hls/${version}/${name}`)).status, 403);
  }
  accounts.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?)').run(viewer.id,Date.now()+60000,owner.id,'转码权限验收',Date.now());
  assert.equal((await get(episodes[3], `hls/${version}/s160-000000.ts`, { method: 'HEAD' })).status, 200);
  accounts.db.prepare('UPDATE account_manual_vip SET period_end=0 WHERE account_id=?').run(viewer.id);
  assert.equal((await get(episodes[3], `hls/${version}/s160-000000.ts`)).status, 403);
  assert.equal((await get(episodes[0], `hls/${cover}/master.m3u8`)).status, 404);
  const wrong = await fetch(`${base}/api/episodes/${episodes[0].id}/hls/${version}/master.m3u8?seriesId=999`, { headers: { Cookie: cookie } });
  assert.ok(wrong.status >= 400);
  const segment = storage.renditionPath(key, 's160-000000.ts');
  await fs.rename(segment, `${segment}.retained`); await fs.symlink(storage.filePath(id), segment);
  assert.equal((await get(episodes[0], `hls/${version}/s160-000000.ts`)).status, 503);
  store.publish(owner,series.id,'draft');
  assert.equal((await get(episodes[0], `hls/${version}/master.m3u8`)).status, 404);
});

test('清晰度不放大小片源，横竖比例保持且分辨率为偶数，HLS路径拒绝越界', async t => {
  for (const metadata of [{width:320,height:568},{width:1920,height:1080},{width:1080,height:1920},{width:854,height:480}]) {
    for (const level of renditionLevels(metadata)) {
      assert.ok(level.width <= metadata.width && level.height <= metadata.height);
      assert.equal(level.width % 2, 0); assert.equal(level.height % 2, 0);
      assert.ok(Math.abs(level.width / level.height - metadata.width / metadata.height) < 0.01);
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-hls-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = new LocalMediaStorage(directory, {}), key = 'hls-12345678-1234-1234-1234-123456789012';
  for (const name of ['../content.sqlite','%2e%2e','/tmp/source','master.m3u8.tmp','s480-000000.ts/../x']) assert.throws(() => storage.renditionPath(key,name), error => error.status === 400);
});
