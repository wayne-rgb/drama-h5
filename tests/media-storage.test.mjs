import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountStore } from '../server/account-store.mjs';
import { createAccountService } from '../server/account-routes.mjs';
import { ContentStore } from '../server/content-store.mjs';
import { createContentService } from '../server/content-service.mjs';
import { LocalMediaStorage } from '../server/media-storage.mjs';

test('本地媒体目录拒绝越界标识及实际或悬空符号链接，不创建目录外文件', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-media-path-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = new LocalMediaStorage(directory, {});
  const outside = path.join(directory, 'outside');
  await fs.writeFile(outside, '已有数据');
  await fs.symlink(outside, path.join(storage.root, 'existing'));
  await fs.symlink(path.join(directory, 'absent'), path.join(storage.root, 'dangling.part'));
  assert.throws(() => storage.filePath('../outside'), error => error.status === 400);
  assert.throws(() => storage.filePath('existing'), error => error.status === 503);
  assert.throws(() => storage.filePath('dangling', '.part'), error => error.status === 503);
  assert.equal(await fs.readFile(outside, 'utf8'), '已有数据');
  await assert.rejects(fs.stat(path.join(directory, 'absent')), error => error.code === 'ENOENT');
});

test('旧剧库登记存储位置后可独立迁移目录和文件名，保持播放协议与权限兼容', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-media-migration-'));
  const media = path.join(directory, 'media'), relocated = path.join(directory, 'relocated');
  await fs.mkdir(media);
  const assetId = crypto.randomUUID(), coverId = crypto.randomUUID();
  const videoPath = path.join(media, assetId);
  await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x240:r=24:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4', videoPath]);
  const bytes = await fs.readFile(videoPath);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(path.join(media, coverId), image);
  const accounts = new AccountStore(path.join(directory, 'accounts.sqlite'));
  const admin = accounts.create({ email: 'migration-admin@example.invalid', name: '迁移管理员' });
  const viewer = accounts.create({ email: 'migration-viewer@example.invalid', name: '迁移观众' });
  const cookie = `hg_account_session=${accounts.session(viewer.id)}`;
  const config = { APP_ORIGIN: 'http://127.0.0.1:4318', ADMIN_ACCOUNT_IDS: admin.id };
  const legacy = new ContentStore(directory);
  for (const [id, kind, mime, size, metadata] of [[assetId, 'video', 'video/mp4', bytes.length, { duration: 2, width: 160, height: 240 }], [coverId, 'image', 'image/png', image.length, null]]) {
    legacy.db.prepare("INSERT INTO content_assets(id,owner_id,name,kind,mime,size,status,metadata,created_at) VALUES(?,?,?,?,?,?,'ready',?,?)").run(id, admin.id, '历史真实素材', kind, mime, size, metadata ? JSON.stringify(metadata) : null, Date.now());
  }
  const series = legacy.saveSeries(admin, { title: '迁移验收短剧', description: '', tags: '', contentType: 'real-drama', language: 'en', coverId });
  for (let number = 1; number <= 4; number++) legacy.saveEpisode(admin, series.id, { number, assetId });
  legacy.publish(admin, series.id, 'published');
  const episodes = legacy.detail(series.id).episodes;
  legacy.db.exec('DROP TABLE content_asset_locations');
  legacy.close();

  const accountService = createAccountService(accounts, config);
  let content, server, base;
  const start = async settings => {
    content = createContentService(directory, accounts, accountService, { detail: async () => { throw Error('本地验收不应访问外部内容源'); } }, settings);
    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, config.APP_ORIGIN);
        const match = /^\/api\/episodes\/(\d+)\/(qualities|play|stream)$/.exec(url.pathname);
        if (match) {
          const resolved = await content.resolveEpisode(req, url.searchParams.get('seriesId'), match[1]);
          await content.ownPlayback(req, res, match[2], resolved);
        } else if (!await content.handle(req, res, url)) { res.writeHead(404); res.end(); }
      } catch (error) { res.writeHead(error.status || 500); res.end(error.message); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => { if (server) await new Promise(resolve => server.close(resolve)); server = null; content?.close(); content = null; };
  t.after(async () => { await stop(); accounts.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const route = (episode, action) => `/api/episodes/${episode.id}/${action}?seriesId=${series.id}`;
  const request = (url, options = {}) => fetch(`${base}${url}`, options);

  await start(config);
  assert.equal(content.store.assetLocation(assetId).objectKey, assetId);
  const first = await request(route(episodes[0], 'play'));
  assert.equal(first.status, 200);
  const source = await first.json();
  assert.equal(source.path, source.url);
  assert.equal(source.format, 'mp4');
  assert.equal(source.contentType, 'video/mp4');
  assert.equal(source.version, assetId);
  assert.equal(source.expiresAt, null);
  assert.equal(JSON.stringify(source).includes(directory), false);
  const originalRange = await request(source.url, { headers: { Range: 'bytes=12-127' } });
  assert.equal(originalRange.status, 206);
  assert.deepEqual(Buffer.from(await originalRange.arrayBuffer()), bytes.subarray(12, 128));
  assert.equal((await request(source.url, { method: 'HEAD' })).headers.get('content-length'), String(bytes.length));
  assert.equal((await request(source.url, { headers: { Range: 'bytes=999999999-' } })).status, 416);

  for (const action of ['play', 'stream']) assert.equal((await request(route(episodes[3], action), { headers: { Cookie: cookie, Range: 'bytes=0-127' } })).status, 403);
  accounts.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?)').run(viewer.id, Date.now() + 60000, admin.id, '真实会员权限验收', Date.now());
  assert.equal((await request(route(episodes[3], 'play'), { headers: { Cookie: cookie } })).status, 200);
  accounts.db.prepare('UPDATE account_manual_vip SET period_end=0 WHERE account_id=?').run(viewer.id);
  assert.equal((await request(route(episodes[3], 'stream'), { method: 'HEAD', headers: { Cookie: cookie } })).status, 403);

  await stop();
  await fs.cp(media, relocated, { recursive: true });
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(relocated, assetId))).digest('hex'), crypto.createHash('sha256').update(bytes).digest('hex'));
  // 原目录仍可回退，但暂时改名，确保新实例没有从旧位置偷偷读取。
  await fs.rename(media, `${media}-retained`);
  await start({ ...config, CONTENT_MEDIA_DIR: relocated });
  assert.deepEqual(content.store.detail(series.id).episodes, episodes);
  const afterMove = await request(source.url);
  assert.equal(afterMove.status, 200);
  assert.deepEqual(Buffer.from(await afterMove.arrayBuffer()), bytes);
  const cover = await request(`/api/content/covers/${coverId}`);
  assert.equal(cover.status, 200);
  assert.deepEqual(Buffer.from(await cover.arrayBuffer()), image);

  const newKey = crypto.randomUUID();
  await fs.rename(path.join(relocated, assetId), path.join(relocated, newKey));
  content.store.saveAssetLocation({ ...content.store.assetLocation(assetId), objectKey: newKey });
  await stop();
  await start({ ...config, CONTENT_MEDIA_DIR: relocated });
  assert.equal(content.store.assetLocation(assetId).objectKey, newKey);
  assert.equal(content.store.detail(series.id).episodes[0].assetId, assetId);
  const renamed = await request(source.url, { headers: { Range: 'bytes=-128' } });
  assert.equal(renamed.status, 206);
  assert.deepEqual(Buffer.from(await renamed.arrayBuffer()), bytes.subarray(-128));
  assert.equal((await (await request(route(episodes[0], 'play'))).json()).version, source.version);
});
