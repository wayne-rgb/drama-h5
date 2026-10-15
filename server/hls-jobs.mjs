import { fork } from 'node:child_process';
import crypto from 'node:crypto';
import { AccountError } from './account-store.mjs';

export function createHlsJobs(store, directory, storage, config) {
  let child, closing = false, restart;
  const keys = ['PATH','SystemRoot','WINDIR','FFMPEG_PATH','FFPROBE_PATH','PRLIMIT_PATH','CONTENT_HLS_FFMPEG_PATH','CONTENT_HLS_MEMORY_BYTES','CONTENT_HLS_CPU_SECONDS','CONTENT_HLS_TIMEOUT_MS','CONTENT_MAX_STORAGE_BYTES'];
  const environment = Object.fromEntries(keys.map(key => [key, config[key] ?? process.env[key]]).filter(([,value]) => value !== undefined).map(([key,value]) => [key,String(value)]));
  environment.CONTENT_MEDIA_DIR = storage.root;
  const wake = () => {
    if (closing || child || !store.db.prepare("SELECT 1 FROM content_hls_jobs WHERE status IN ('queued','processing') LIMIT 1").get()) return;
    child = fork(new URL('./hls-worker.mjs', import.meta.url), [directory], { env: environment, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.once('error', () => console.warn('HLS工作进程启动失败，任务已保留'));
    child.once('exit', () => {
      child = null;
      if (!closing) { restart = setTimeout(wake, 1000); restart.unref(); }
    });
  };
  const enqueue = asset => {
    const version = crypto.randomUUID();
    store.db.prepare("INSERT OR IGNORE INTO content_hls_jobs(asset_id,status,version,storage_id,object_key,updated_at) VALUES(?,'queued',?,'local',?,?)").run(asset.id, version, `hls-${version}`, Date.now());
  };
  wake();
  return {
    enqueue, wake,
    retry(id) {
      const job = store.hlsJob(id), asset = store.asset(id);
      if (!job || asset?.status !== 'ready') throw new AccountError(404, '转码任务不存在');
      if (job.status === 'failed') store.db.prepare("UPDATE content_hls_jobs SET status='queued',error=NULL,updated_at=? WHERE asset_id=?").run(Date.now(), id);
      wake(); return store.asset(id);
    },
    close() {
      closing = true; clearTimeout(restart);
      if (!child || child.exitCode !== null) return Promise.resolve();
      const running = child;
      return new Promise(resolve => {
        const timer = setTimeout(() => running.kill('SIGKILL'), 5000); timer.unref();
        running.once('exit', () => { clearTimeout(timer); resolve(); });
        running.kill('SIGTERM');
      });
    },
  };
}
