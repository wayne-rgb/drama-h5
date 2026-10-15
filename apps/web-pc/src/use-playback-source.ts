import { useEffect, useState } from 'react';
import { api, PlaybackSource } from './api';

// 两种播放界面共用请求取消与结果归属校验，快速切集不能装载旧视频。
export function usePlaybackSource(seriesId: string | undefined, episodeId: string | undefined, quality: string, enabled: boolean, retry: number, identity: string | undefined) {
  const context = enabled && seriesId && episodeId ? JSON.stringify([seriesId, episodeId, retry, identity]) : '';
  const [result, setResult] = useState<{ key: string; context?: string; source?: PlaybackSource; error?: unknown }>({ key: '' });
  const hls = result.context === context && result.source?.format === 'hls';
  const key = context ? `${context}:${hls ? 'hls' : quality}` : '';
  useEffect(() => {
    if (!key || hls) return;
    const controller = new AbortController();
    api.getPlaybackSource(episodeId!, quality, seriesId!, controller.signal)
      .then(source => { if (!controller.signal.aborted) setResult({ key, context, source }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, context, error }); });
    return () => controller.abort();
  }, [key]);
  const current = key && (result.key === key || hls) ? result : null;
  return { source: current?.source, error: current?.error, loading: !!key && !current };
}
