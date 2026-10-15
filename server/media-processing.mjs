import fs from 'node:fs';
import { promises as files } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { positiveLimit } from './request-guard.mjs';

const execute = promisify(execFile);

// 文件上传与处理分开，保留原有媒体校验、超时和资源限制。
export function createMediaProcessor(storage, config = process.env) {
  const filePath = (id, suffix = '') => storage.filePath(id, suffix);
  const memory = positiveLimit(config, 'CONTENT_MEDIA_MEMORY_BYTES', 512 * 1024 ** 2);
  const cpuSeconds = positiveLimit(config, 'CONTENT_MEDIA_CPU_SECONDS', 180, 1800);
  // 子进程不继承账号、邮件、支付和未来存储服务的密钥。
  const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR'].filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  Object.assign(environment, { LANG: 'C', TMPDIR: storage.root, TMP: storage.root, TEMP: storage.root, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' });
  const executeMedia = (binary, args, options) => process.platform === 'linux'
    ? execute(config.PRLIMIT_PATH || 'prlimit', [`--as=${memory}`, `--cpu=${cpuSeconds}`, '--nofile=64', '--', binary, ...args], { ...options, env: environment })
    : execute(binary, args, { ...options, env: environment });
  const sourcePath = asset => {
    const part = filePath(asset.id, '.part');
    const source = fs.existsSync(part) ? part : filePath(asset.id);
    if (!fs.existsSync(source)) throw new Error('上传文件不存在，请重新上传');
    if (source === part && fs.statSync(source).size !== asset.size) throw new Error('上传文件不完整，请重新上传');
    return source;
  };

  return {
    async video(asset, signal) {
      const source = sourcePath(asset);
      const header = Buffer.alloc(12), handle = await files.open(source, 'r');
      try { await handle.read(header, 0, 12, 0); } finally { await handle.close(); }
      if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('请上传有效的MP4视频');
      const { stdout } = await executeMedia(config.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', source], { timeout: 120000, maxBuffer: 1048576, signal });
      const info = JSON.parse(stdout), video = info.streams?.find(row => row.codec_type === 'video'), audio = info.streams?.filter(row => row.codec_type === 'audio') || [];
      if (!video || video.codec_name !== 'h264' || !(video.width > 0 && video.height > 0) || !['yuv420p', 'yuvj420p'].includes(video.pix_fmt) || audio.some(row => row.codec_name !== 'aac') || !Number.isFinite(Number(info.format?.duration)) || Number(info.format.duration) <= 0 || video.width > 4096 || video.height > 4096) throw new Error('请上传8位H.264视频及AAC音轨的MP4文件，分辨率不超过4096像素');
      await executeMedia(config.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', '-y', filePath(asset.id, '.processing')], { timeout: 1800000, maxBuffer: 1048576, signal });
      await files.rename(filePath(asset.id, '.processing'), filePath(asset.id));
      const rotation = Math.abs(Number(video.side_data_list?.find(row => row.rotation !== undefined)?.rotation || video.tags?.rotate || 0)) % 180;
      const [sarWidth, sarHeight] = String(video.sample_aspect_ratio || '1:1').split(':').map(Number);
      const displayWidth = Math.round(video.width * (sarWidth > 0 && sarHeight > 0 ? sarWidth / sarHeight : 1));
      const [numerator, denominator] = String(video.avg_frame_rate || '24/1').split('/').map(Number);
      return { duration: Number(info.format.duration), width: rotation === 90 ? video.height : displayWidth, height: rotation === 90 ? displayWidth : video.height, fps: Math.min(30, numerator / denominator || 24), audio: audio.length > 0 };
    },
    async image(asset, signal) {
      const source = sourcePath(asset), image = await files.readFile(source);
      const mime = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : image[0] === 255 && image[1] === 216 && image[2] === 255 ? 'image/jpeg' : image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : null;
      if (mime !== asset.mime) throw new Error('封面文件格式无效');
      const { stdout } = await executeMedia(config.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', source], { timeout: 15000, maxBuffer: 1048576, signal });
      const info = JSON.parse(stdout).streams?.[0];
      if (!info || !['png', 'mjpeg', 'webp'].includes(info.codec_name) || !(info.width > 0 && info.height > 0) || info.width > 4096 || info.height > 4096) throw new Error('封面文件格式无效');
      if (source !== filePath(asset.id)) await files.rename(source, filePath(asset.id));
      return null;
    },
  };
}
