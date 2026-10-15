import { useEffect, useState } from 'react';
import { api, PlaybackSource } from './api';

// 两种播放界面共用请求取消与结果归属校验，快速切集不能装载旧视频。
export function usePlaybackSource(seriesId: string | undefined, episodeId: string | undefined, quality: string, enabled: boolean, retry: number, identity: string | undefined) {
  const key = enabled && seriesId && episodeId ? JSON.stringify([seriesId, episodeId, quality, retry, identity]) : '';
  const [result, setResult] = useState<{ key: string; source?: PlaybackSource; error?: unknown }>({ key: '' });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    api.getPlaybackSource(episodeId!, quality, seriesId!, controller.signal)
      .then(source => { if (!controller.signal.aborted) setResult({ key, source }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, error }); });
    return () => controller.abort();
  }, [key]);
  const current = key && result.key === key ? result : null;
  return { source: current?.source, error: current?.error, loading: !!key && !current };
}
