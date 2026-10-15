import { ContentStore } from './content-store.mjs';
import { LocalMediaStorage } from './media-storage.mjs';
import { encodeHls, reserveHls } from './hls-encoding.mjs';
import { promises as files } from 'node:fs';

const store = new ContentStore(process.argv[2]), storage = new LocalMediaStorage(process.argv[2]), controller = new AbortController();
let closing = false;
const stop = () => { closing = true; controller.abort(); };
process.on('disconnect', stop); process.on('SIGTERM', stop);
// 每个站点仅由父进程启动一个工作进程，单任务顺序编码；中断任务下次启动重新生成。
try {
  store.db.prepare("UPDATE content_hls_jobs SET status='queued' WHERE status='processing'").run();
  while (!closing) {
    const job = store.hlsJob(store.db.prepare("SELECT asset_id FROM content_hls_jobs WHERE status='queued' ORDER BY updated_at,asset_id LIMIT 1").get()?.asset_id || '');
    if (!job) break;
    try {
      for (const key of [job.object_key, `${job.object_key}.pending`]) await files.rm(storage.renditionPath(key), { recursive: true, force: true });
      const bytes = reserveHls(store, storage, store.asset(job.asset_id), process.env);
      store.db.prepare("UPDATE content_hls_jobs SET status='processing',reserved_bytes=?,error=NULL,updated_at=? WHERE asset_id=?").run(bytes, Date.now(), job.asset_id);
      const result = await encodeHls(store, storage, { ...job, reserved_bytes: bytes }, process.env, controller.signal);
      if (closing) break;
      store.db.prepare("UPDATE content_hls_jobs SET status='ready',size=?,manifest=?,reserved_bytes=0,error=NULL,updated_at=? WHERE asset_id=?").run(result.size, JSON.stringify(result.manifest), Date.now(), job.asset_id);
    } catch (error) {
      await files.rm(storage.renditionPath(`${job.object_key}.pending`), { recursive: true, force: true }).catch(() => {});
      if (closing) break;
      const message = error.status === 507 ? error.message : error.code === 'ENOENT' ? '转码工具不可用，MP4仍可播放，请配置FFmpeg后重试' : 'HLS转码失败，MP4仍可播放，请重试';
      store.db.prepare("UPDATE content_hls_jobs SET status='failed',reserved_bytes=0,error=?,updated_at=? WHERE asset_id=?").run(message, Date.now(), job.asset_id);
    }
  }
} finally { store.close(); if (process.connected) process.disconnect(); }
