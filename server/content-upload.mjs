import fs from 'node:fs';
import { promises as files } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AccountError } from './account-store.mjs';
import { readBody } from '../shared/http-json.mjs';
import { LocalMediaStorage } from './media-storage.mjs';
import { createMediaProcessor } from './media-processing.mjs';

export function createUploads(store, directory, config = process.env, storage = new LocalMediaStorage(directory, config)) {
  const media = storage.root, processor = createMediaProcessor(storage, config);
  const active = new Set();
  const processing = new Set(); let closing = false;
  const queue = [];
  const filePath = (id, suffix = '') => storage.filePath(id, suffix);
  const maximum = Math.min(10 * 1024 ** 3, Math.max(1024 ** 2, Number(config.CONTENT_MAX_VIDEO_BYTES) || 2 * 1024 ** 3));
  const storageMaximum = Number(config.CONTENT_MAX_STORAGE_BYTES || 100 * 1024 ** 3);
  if (!Number.isSafeInteger(storageMaximum) || storageMaximum <= 0) throw new Error('上传存储额度配置无效');
  const failedFiles = asset => {
    const referenced = store.db.prepare('SELECT 1 FROM content_episodes WHERE asset_id=? UNION SELECT 1 FROM content_series WHERE cover_id=?').get(asset.id, asset.id);
    return [filePath(asset.id, '.part'), filePath(asset.id, '.processing'), ...(!referenced ? [filePath(asset.id)] : [])];
  };
  const clearFailed = async asset => {
    for (const filename of failedFiles(asset)) await files.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
  };
  const checkStorage = input => {
    // 计算实际文件占用，并为未完成的视频预留上传原文件和处理副本；不删除有效素材或断点。
    const sizes = new Map(fs.readdirSync(media).map(name => {
      try { return [name, fs.statSync(path.join(media, name)).size]; }
      catch (error) { if (error.code === 'ENOENT') return [name, 0]; throw error; }
    }));
    const occupied = [...sizes.values()].reduce((total, size) => total + size, 0);
    let reserved = 0;
    for (const asset of store.db.prepare("SELECT id,kind,size FROM content_assets WHERE status IN ('uploading','processing')").all()) {
      const actual = ['', '.part', '.processing'].reduce((total, suffix) => total + (sizes.get(`${asset.id}${suffix}`) || 0), 0);
      reserved += Math.max(0, asset.size * (asset.kind === 'video' ? 2 : 1) - actual);
    }
    const requested = input.size * (input.kind === 'video' ? 2 : 1);
    if (occupied + reserved + requested > storageMaximum) throw new AccountError(507, '上传存储额度不足，请清理无用素材后重试');
    const disk = fs.statfsSync(media, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(reserved + requested + 64 * 1024 ** 2)) throw new AccountError(507, '存储空间不足，请释放空间后重试');
  };
  const finish = async (asset, metadata) => {
    await files.unlink(filePath(asset.id, '.part')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (closing) return;
    const size = (await files.stat(filePath(asset.id))).size;
    store.transaction(() => {
      store.saveAssetLocation(storage.reference(asset, size));
      store.db.prepare("UPDATE content_assets SET status='ready',size=?,metadata=?,error=NULL WHERE id=?").run(size, metadata ? JSON.stringify(metadata) : null, asset.id);
    });
  };
  const processVideo = async asset => {
    const controller = new AbortController(); processing.add(controller);
    try {
      const metadata = await processor.video(asset, controller.signal);
      await finish(asset, metadata);
    } catch (error) {
      if (closing) return;
      const message = error.code === 'ENOENT' ? '视频处理工具不可用，请配置FFmpeg和FFprobe后重新上传' : /^(请上传|上传文件不)/.test(error.message) ? error.message : '视频处理失败，请检查文件后重新上传';
      store.db.prepare("UPDATE content_assets SET status='failed',error=? WHERE id=?").run(message, asset.id);
      await clearFailed(asset).catch(() => console.warn('失败上传文件清理失败，请检查存储权限'));
    } finally { processing.delete(controller); runQueue(); }
  };
  const processImage = async asset => {
    const controller = new AbortController(); processing.add(controller);
    try {
      await processor.image(asset, controller.signal);
      await finish(asset);
    } catch (error) {
      if (closing) return;
      const message = error.code === 'ENOENT' ? '视频处理工具不可用，请配置FFmpeg和FFprobe后重新上传' : /^上传文件不/.test(error.message) ? error.message : '封面文件格式无效';
      store.db.prepare("UPDATE content_assets SET status='failed',error=? WHERE id=?").run(message, asset.id);
      await clearFailed(asset).catch(() => console.warn('失败上传文件清理失败，请检查存储权限'));
    } finally { processing.delete(controller); runQueue(); }
  };
  const runQueue = () => {
    if (closing) return;
    while (queue.length && processing.size < 2) {
      const asset = queue.shift();
      void (asset.kind === 'video' ? processVideo(asset) : processImage(asset));
    }
  };
  // 完整文件已落盘时只恢复处理；半途上传的分块位置继续保留，等浏览器正常续传。
  for (const asset of store.db.prepare("SELECT * FROM content_assets WHERE status='processing' OR (status='uploading' AND offset=size) OR (status='failed' AND error='处理被服务重启中断，请重新上传' AND offset=size)").all()) {
    const part = filePath(asset.id, '.part');
    if (fs.existsSync(part) && fs.statSync(part).size < asset.size) {
      store.db.prepare("UPDATE content_assets SET status='uploading',offset=?,error=NULL WHERE id=?").run(fs.statSync(part).size,asset.id);
      continue;
    }
    store.db.prepare("UPDATE content_assets SET status='processing',error=NULL WHERE id=?").run(asset.id);
    queue.push(asset);
  }
  // 先保留并恢复旧重启中断记录，其余失败任务只清理文件，数据库与操作记录继续保留。
  for (const asset of store.db.prepare("SELECT * FROM content_assets WHERE status='failed'").all()) {
    for (const filename of failedFiles(asset)) {
      try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') console.warn('失败上传文件清理失败，请检查存储权限'); }
    }
  }
  runQueue();
  return {
    filePath, maximum,
    close() { closing = true; queue.length = 0; for (const controller of processing) controller.abort(); },
    async cancel(admin, id) {
      const asset = store.asset(id);
      if (!asset || asset.owner_id !== admin.id) throw new AccountError(404, '上传不存在');
      if (active.has(id) || asset.status === 'processing') throw new AccountError(409, '此上传正在写入，请稍后重试');
      if (asset.status === 'uploading') {
        store.db.prepare("UPDATE content_assets SET status='failed',error='上传已取消' WHERE id=?").run(id);
      }
      if (['uploading','failed'].includes(asset.status)) {
        await clearFailed(asset);
      }
      return store.asset(id);
    },
    create(admin, input) {
      if (!['video', 'image'].includes(input.kind) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > (input.kind === 'image' ? 8 * 1024 ** 2 : maximum)) throw new AccountError(400, '上传类型或文件大小无效');
      if (input.kind === 'video' ? input.mime !== 'video/mp4' : !['image/jpeg', 'image/png', 'image/webp'].includes(input.mime)) throw new AccountError(400, '视频需为MP4，封面需为JPEG、PNG或WebP');
      if (input.seriesId!==undefined && (!/^\d{1,40}$/.test(input.seriesId) || !store.row(input.seriesId))) throw new AccountError(400,'短剧不存在');
      if (input.seriesId!==undefined && input.kind==='video' && (!Number.isInteger(input.number) || input.number<1 || input.number>10000)) throw new AccountError(400,'集数无效');
      const pending = store.db.prepare("SELECT COUNT(*) AS count FROM content_assets WHERE status IN ('uploading','processing')").get().count;
      if (pending >= 20) throw new AccountError(429, '待处理上传过多，请先完成已有上传');
      checkStorage(input);
      const id = crypto.randomUUID();
      fs.writeFileSync(filePath(id, '.part'), Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
      try {
        store.transaction(() => {
          store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,created_at) VALUES(?,?,?,?,?,?,?)').run(id, admin.id, String(input.name || '').slice(0, 200), input.kind, input.mime, input.size, Date.now());
          if (input.seriesId) store.db.prepare('UPDATE content_assets SET series_id=?,episode_number=? WHERE id=?').run(input.seriesId,input.kind==='video'?input.number:null,id);
        });
      } catch (error) { fs.unlinkSync(filePath(id, '.part')); throw error; }
      return store.asset(id);
    },
    async chunk(req, admin, id) {
      const asset = store.asset(id);
      if (!asset || asset.owner_id !== admin.id) throw new AccountError(404, '上传不存在');
      if (asset.status !== 'uploading') throw new AccountError(409, '该上传已经结束');
      if (active.has(id)) throw new AccountError(409, '此上传正在写入，请稍后重试');
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] || '');
      if (!range) throw new AccountError(400, '上传范围无效');
      const start = Number(range[1]), end = Number(range[2]), total = Number(range[3]);
      if (start !== asset.offset || total !== asset.size || end < start || end >= total || end - start + 1 > 1048576) throw new AccountError(409, '上传位置已变化，请恢复上传');
      active.add(id);
      try {
        let data;
        try { data = await readBody(req, { maximum: end - start + 1, timeoutMs: 60000 }); }
        catch (error) { if (error instanceof AccountError) throw error; throw new AccountError(error.status || 400, error.status === 408 ? '上传分块读取超时，请稍后重试' : error.status === 413 ? '上传分块过大' : '上传分块不完整'); }
        if (data.length !== end - start + 1) throw new AccountError(400, '上传分块不完整');
        const handle = await files.open(filePath(id, '.part'), 'r+');
        try { req.revalidateAccess?.(); let written = 0; while (written < data.length) written += (await handle.write(data, written, data.length - written, start + written)).bytesWritten; } finally { await handle.close(); }
        req.revalidateAccess?.();
        store.db.prepare('UPDATE content_assets SET offset=? WHERE id=?').run(end + 1, id);
        if (end + 1 === total) {
          store.db.prepare("UPDATE content_assets SET status='processing' WHERE id=?").run(id);
          queue.push(asset); runQueue();
          store.audit(admin, '完成文件上传', id, { kind: asset.kind, name: asset.name });
        }
        return store.asset(id);
      } finally { active.delete(id); }
    },
  };
}
