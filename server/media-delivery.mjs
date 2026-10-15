// 返回稳定的业务播放入口，不把文件路径、存储凭据交给浏览器。
export function mp4PlaybackSource(episodeId, seriesId, quality = 'auto', version = null) {
  const params = new URLSearchParams({ quality });
  if (seriesId) params.set('seriesId', seriesId);
  const url = `/api/episodes/${encodeURIComponent(episodeId)}/stream?${params}`;
  return { url, path: url, contentType: 'video/mp4', format: 'mp4', quality, version, expiresAt: null };
}

export function hlsPlaybackSource(episodeId, seriesId, quality, job) {
  const base = `/api/episodes/${encodeURIComponent(episodeId)}/hls/${encodeURIComponent(job.version)}/`;
  const suffix = `?${new URLSearchParams({ seriesId })}`;
  return { url: `${base}master.m3u8${suffix}`, contentType: 'application/vnd.apple.mpegurl', format: 'hls', quality, version: job.version, expiresAt: null,
    variants: job.manifest.levels.map(level => ({ key: level.key, url: `${base}r${level.size}.m3u8${suffix}` })),
    fallback: mp4PlaybackSource(episodeId, seriesId, 'auto') };
}

// 传输层只读取已定位的资源；权限、限速和流量计量仍由请求上下文提供。
export function sendMedia(req, res, resource, asset, { quality, cover = false, publicCover = false, revalidateCover } = {}) {
  const { stat, location } = resource;
  if (!cover && asset.metadata?.duration > 0) req.downloadRate = 24 * stat.size / asset.metadata.duration;
  if (cover && publicCover) {
    const etag = `"${location.version}-${stat.size}-${stat.mtimeMs}"`;
    res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'private, max-age=300');
    // 命中封面缓存前已经校验访问资格，不扣减媒体字节。
    if ((req.headers['if-none-match'] || '').split(',').some(value => value.trim() === etag || value.trim() === `W/${etag}` || value.trim() === '*')) {
      res.writeHead(304); return res.end();
    }
  }
  if (cover) {
    req.guardPublicAsset?.();
    const previous = req.revalidatePlayback;
    req.revalidatePlayback = force => { previous?.(force); revalidateCover?.(force); };
  }
  let start = 0, end = stat.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || !match[1] && !match[2]) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end();
    }
    status = 206;
  }
  req.revalidatePlayback?.(true);
  // 计量器通过 getHeader 读取媒体类型，先显式登记，避免 writeHead 的原始头绕过字节统计。
  res.setHeader('Content-Type', asset.mime);
  res.writeHead(status, {
    'Content-Type': asset.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'Cache-Control': publicCover ? 'private, max-age=300' : 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    ...(quality ? { 'X-Video-Quality': quality } : {}),
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  const stream = resource.open({ start, end });
  res.once('close', () => stream.destroy()); stream.once('error', () => res.destroy());
  if (req.sendDownload) req.sendDownload(stream); else stream.pipe(res);
}
