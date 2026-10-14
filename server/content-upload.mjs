import fs from 'node:fs';
import { promises as files } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountError } from './account-store.mjs';
const execute = promisify(execFile);

export function createUploads(store, directory, config = process.env) {
  const media = path.join(directory, 'media'); fs.mkdirSync(media, { recursive: true, mode: 0o700 });
  const active = new Set();
  const processing = new Set(); let closing = false;
  const filePath = (id, suffix = '') => path.join(media, `${id}${suffix}`);
  const maximum = Math.min(10 * 1024 ** 3, Math.max(1024 ** 2, Number(config.CONTENT_MAX_VIDEO_BYTES) || 2 * 1024 ** 3));
  const processVideo = async asset => {
    const controller = new AbortController(); processing.add(controller);
    try {
      const header = Buffer.alloc(12), handle = await files.open(filePath(asset.id, '.part'), 'r');
      try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
      if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('请上传有效的MP4视频');
      const { stdout } = await execute(config.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', filePath(asset.id, '.part')], { timeout: 120000, maxBuffer: 1048576, signal: controller.signal });
      const info = JSON.parse(stdout), video = info.streams?.find(row => row.codec_type === 'video'), audio = info.streams?.filter(row => row.codec_type === 'audio') || [];
      if (!video || video.codec_name !== 'h264' || !(video.width>0 && video.height>0) || !['yuv420p','yuvj420p'].includes(video.pix_fmt) || audio.some(row => row.codec_name !== 'aac') || !Number.isFinite(Number(info.format?.duration)) || Number(info.format.duration) <= 0 || video.width > 4096 || video.height > 4096) throw new Error('请上传8位H.264视频及AAC音轨的MP4文件，分辨率不超过4096像素');
      await execute(config.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', filePath(asset.id, '.part'), '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', filePath(asset.id, '.processing')], { timeout: 1800000, maxBuffer: 1048576, signal: controller.signal });
      await files.rename(filePath(asset.id, '.processing'), filePath(asset.id));
      await files.unlink(filePath(asset.id, '.part'));
      const size = (await files.stat(filePath(asset.id))).size;
      if (closing) return;
      store.db.prepare("UPDATE content_assets SET status='ready',size=?,metadata=? WHERE id=?").run(size, JSON.stringify({ duration: Number(info.format.duration), width: video.width, height: video.height }), asset.id);
    } catch (error) {
      if (closing) return;
      const message = error.code === 'ENOENT' ? '视频处理工具不可用，请配置FFmpeg和FFprobe后重新上传' : /^请上传/.test(error.message) ? error.message : '视频处理失败，请检查文件后重新上传';
      store.db.prepare("UPDATE content_assets SET status='failed',error=? WHERE id=?").run(message, asset.id);
      await files.unlink(filePath(asset.id, '.processing')).catch(() => {});
    } finally { processing.delete(controller); }
  };
  return {
    filePath, maximum,
    close() { closing = true; for (const controller of processing) controller.abort(); },
    async cancel(admin, id) {
      const asset = store.asset(id);
      if (!asset || asset.owner_id !== admin.id) throw new AccountError(404, '上传不存在');
      if (active.has(id) || asset.status === 'processing') throw new AccountError(409, '此上传正在写入，请稍后重试');
      if (asset.status === 'uploading') {
        store.db.prepare("UPDATE content_assets SET status='failed',error='上传已取消' WHERE id=?").run(id);
      }
      if (['uploading','failed'].includes(asset.status)) {
        await files.unlink(filePath(id, '.part')).catch(() => {});
        await files.unlink(filePath(id, '.processing')).catch(() => {});
      }
      return store.asset(id);
    },
    create(admin, input) {
      if (!['video', 'image'].includes(input.kind) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > (input.kind === 'image' ? 8 * 1024 ** 2 : maximum)) throw new AccountError(400, '上传类型或文件大小无效');
      if (input.kind === 'video' ? input.mime !== 'video/mp4' : !['image/jpeg', 'image/png', 'image/webp'].includes(input.mime)) throw new AccountError(400, '视频需为MP4，封面需为JPEG、PNG或WebP');
      const pending = store.db.prepare("SELECT COUNT(*) AS count FROM content_assets WHERE status IN ('uploading','processing')").get().count;
      if (pending >= 20) throw new AccountError(429, '待处理上传过多，请先完成已有上传');
      const id = crypto.randomUUID();
      store.db.prepare('INSERT INTO content_assets(id,owner_id,name,kind,mime,size,created_at) VALUES(?,?,?,?,?,?,?)').run(id, admin.id, String(input.name || '').slice(0, 200), input.kind, input.mime, input.size, Date.now());
      fs.writeFileSync(filePath(id, '.part'), Buffer.alloc(0), { mode: 0o600, flag: 'wx' });
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
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > end - start + 1) throw new AccountError(413, '上传分块过大'); chunks.push(chunk); }
        if (size !== end - start + 1) throw new AccountError(400, '上传分块不完整');
        const handle = await files.open(filePath(id, '.part'), 'r+');
        try { const data = Buffer.concat(chunks); let written = 0; while (written < data.length) written += (await handle.write(data, written, data.length - written, start + written)).bytesWritten; } finally { await handle.close(); }
        store.db.prepare('UPDATE content_assets SET offset=? WHERE id=?').run(end + 1, id);
        if (end + 1 === total) {
          if (asset.kind === 'image') {
            const image = await files.readFile(filePath(id, '.part'));
            const mime = image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : image[0] === 255 && image[1] === 216 && image[2] === 255 ? 'image/jpeg' : image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
            if (mime !== asset.mime) { store.db.prepare("UPDATE content_assets SET status='failed',error='封面文件格式无效' WHERE id=?").run(id); throw new AccountError(400, '封面文件格式无效'); }
            try {
              const {stdout}=await execute(config.FFPROBE_PATH || 'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','stream=codec_name,width,height','-of','json',filePath(id,'.part')],{timeout:15000,maxBuffer:1048576});
              const info=JSON.parse(stdout).streams?.[0];
              if(!info || !['png','mjpeg','webp'].includes(info.codec_name) || !(info.width>0 && info.height>0) || info.width>4096 || info.height>4096)throw Error('封面文件格式无效');
            }catch(error){const message=error.code==='ENOENT'?'视频处理工具不可用，请配置FFmpeg和FFprobe后重新上传':'封面文件格式无效';store.db.prepare("UPDATE content_assets SET status='failed',error=? WHERE id=?").run(message,id);throw new AccountError(400,message);}
            await files.rename(filePath(id, '.part'), filePath(id)); store.db.prepare("UPDATE content_assets SET status='ready' WHERE id=?").run(id);
          } else { store.db.prepare("UPDATE content_assets SET status='processing' WHERE id=?").run(id); void processVideo(asset); }
          store.audit(admin, '完成文件上传', id, { kind: asset.kind, name: asset.name });
        }
        return store.asset(id);
      } finally { active.delete(id); }
    },
  };
}
