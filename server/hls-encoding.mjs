import fs from 'node:fs';
import { promises as files } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AccountError } from './account-store.mjs';

const execute = promisify(execFile);
export function renditionLevels(metadata) {
  if (![metadata?.width, metadata?.height].every(value => Number.isFinite(value) && value >= 2 && value <= 4096)) throw Error('视频显示尺寸无效');
  const short = Math.min(metadata.width, metadata.height);
  const targets = [480, 720, 1080].filter(size => size <= short);
  if (!targets.length) targets.push(Math.max(2, Math.floor(short / 2) * 2));
  return targets.map(size => {
    const ratio = size / short;
    const width = Math.max(2, Math.floor(metadata.width * ratio / 2) * 2), height = Math.max(2, Math.floor(metadata.height * ratio / 2) * 2);
    const maxrate = size <= 480 ? 1000000 : size <= 720 ? 1800000 : 3500000;
    return { key: `${size}P`, size, width, height, maxrate, bandwidth: maxrate + (metadata.audio === false ? 0 : 128000) };
  });
}

// 原片和临时目录都计入实际占用，预留按时长、各档码率上限及封装余量计算。
export function mediaUsage(root) {
  let total = 0;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, item.name);
    try {
      if (item.isFile()) total += fs.statSync(filename).size;
      else if (item.isDirectory() && /^hls-/.test(item.name)) total += mediaUsage(filename);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return total;
}
export function reserveHls(store, storage, asset, config) {
  const bytes = Math.ceil(renditionLevels(asset.metadata).reduce((sum, level) => sum + level.bandwidth, 0) * asset.metadata.duration / 8 * 1.3 + 1024 ** 2);
  const reserved = store.db.prepare("SELECT COALESCE(SUM(reserved_bytes),0) AS bytes FROM content_hls_jobs WHERE status IN ('queued','processing') AND asset_id<>?").get(asset.id).bytes;
  const uploads = store.db.prepare("SELECT COALESCE(SUM(size*2),0) AS bytes FROM content_assets WHERE status IN ('uploading','processing') AND id<>?").get(asset.id).bytes;
  const disk = fs.statfsSync(storage.root, { bigint: true });
  if (mediaUsage(storage.root) + reserved + uploads + bytes > Number(config.CONTENT_MAX_STORAGE_BYTES || 100 * 1024 ** 3) || disk.bavail * disk.bsize < BigInt(reserved + uploads + bytes + 64 * 1024 ** 2)) throw new AccountError(507, '转码空间不足，MP4仍可播放，请释放空间后重试');
  return bytes;
}

export async function encodeHls(store, storage, job, config, signal) {
  const asset = store.asset(job.asset_id);
  if (asset?.status !== 'ready') throw Error('视频尚未处理完成');
  const location = store.assetLocation(asset.id);
  storage.locate(store, asset);
  const input = storage.filePath(location.objectKey), directory = storage.renditionPath(`${job.object_key}.pending`);
  await files.rm(directory, { recursive: true, force: true });
  await files.mkdir(directory, { mode: 0o700 });
  const levels = renditionLevels(asset.metadata), environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(environment, { LANG: 'C', TMPDIR: storage.root, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' });
  const executeMedia = (binary, args, options) => process.platform === 'linux'
    ? execute(config.PRLIMIT_PATH || 'prlimit', [`--as=${Number(config.CONTENT_HLS_MEMORY_BYTES) || 1024 ** 3}`, `--cpu=${Number(config.CONTENT_HLS_CPU_SECONDS) || 21600}`, '--nofile=128', '--', binary, ...args], { ...options, env: environment })
    : execute(binary, args, { ...options, env: environment });
  let referenceDurations;
  for (const level of levels) {
    const args = ['-v', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=${level.width}:${level.height},setsar=1,fps=${asset.metadata.fps || 24}`, '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-maxrate', String(level.maxrate), '-bufsize', String(level.maxrate * 2),
      '-flags', '+cgop', '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*4)', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000', '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', `s${level.size}-%06d.ts`, '-y', `r${level.size}.m3u8`];
    await executeMedia(config.CONTENT_HLS_FFMPEG_PATH || config.FFMPEG_PATH || 'ffmpeg', args, { cwd: directory, timeout: Number(config.CONTENT_HLS_TIMEOUT_MS) || 21600000, maxBuffer: 1048576, signal });
    const playlist = await files.readFile(path.join(directory, `r${level.size}.m3u8`), 'utf8');
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1]));
    const segments = playlist.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (!playlist.includes('#EXT-X-ENDLIST') || !durations.length || segments.length !== durations.length || Math.abs(durations.reduce((sum, duration) => sum + duration, 0) - asset.metadata.duration) > 1 || segments.some(name => !new RegExp(`^s${level.size}-\\d{6}\\.ts$`).test(name))) throw Error('转码成品不完整');
    if (referenceDurations && (referenceDurations.length !== durations.length || durations.some((value, index) => Math.abs(value - referenceDurations[index]) > 0.05))) throw Error('多清晰度时间轴不一致');
    referenceDurations = durations;
    level.segmentCount = segments.length;
  }
  await files.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-INDEPENDENT-SEGMENTS\n' + levels.map(level => `#EXT-X-STREAM-INF:BANDWIDTH=${Math.ceil(level.bandwidth * 1.12)},RESOLUTION=${level.width}x${level.height}\nr${level.size}.m3u8\n`).join(''));
  const sizes = {};
  for (const name of await files.readdir(directory)) {
    storage.renditionPath(job.object_key, name);
    const stat = await files.lstat(path.join(directory, name));
    if (!stat.isFile() || stat.size <= 0) throw Error('转码成品不完整');
    sizes[name] = stat.size;
  }
  const size = Object.values(sizes).reduce((sum, value) => sum + value, 0);
  if (size > job.reserved_bytes) throw Error('转码成品超出预留空间');
  const final = storage.renditionPath(job.object_key);
  await files.rm(final, { recursive: true, force: true });
  await files.rename(directory, final);
  return { size, manifest: { levels, files: sizes } };
}
