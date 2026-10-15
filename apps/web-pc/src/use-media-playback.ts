import { RefObject, useEffect, useRef } from 'react';
import type Hls from 'hls.js';
import workerPath from 'hls.js/dist/hls.worker.js?url';
import { PlaybackSource } from './api';

// 推荐流和详情页复用同一装载逻辑，切走时销毁实例并取消分片请求。
export function useMediaPlayback(ref: RefObject<HTMLVideoElement>, source: PlaybackSource | undefined, quality: string, onError: (message: string) => void) {
  const current = useRef<{ hls?: Hls; native?: boolean; change?: (quality: string) => void }>({});
  const options = useRef({ quality, onError }); options.current = { quality, onError };
  useEffect(() => {
    const video = ref.current;
    if (!video || !source) return;
    let disposed = false, hls: Hls | undefined, recovered = false, pausedLoad = false, frozen = false;
    let cancelRestore = () => {};
    current.current = {};
    const changeNative = (selected: string, restore = true) => {
      const url = selected === 'auto' ? source.url : source.variants?.find(variant => variant.key === selected)?.url || source.url;
      if (video.getAttribute('src') === url) return;
      const position = video.currentTime, paused = video.paused, rate = video.playbackRate, muted = video.muted, volume = video.volume;
      cancelRestore();
      if (restore) {
        const loaded = () => queueMicrotask(() => {
          if (disposed) return;
          if (position > 0) video.currentTime = position;
          video.playbackRate = rate; video.muted = muted; video.volume = volume;
          if (paused) video.pause(); else void video.play().catch(() => {});
        });
        video.addEventListener('loadedmetadata', loaded, { once: true });
        cancelRestore = () => video.removeEventListener('loadedmetadata', loaded);
      }
      video.src = url; video.load();
    };
    const visibility = () => {
      if (!hls || (video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen) return;
      if (frozen || document.visibilityState === 'hidden') { pausedLoad = true; hls.stopLoad(); }
      else if (pausedLoad) { pausedLoad = false; hls.startLoad(video.currentTime); }
    };
    const freeze = () => { frozen = true; visibility(); };
    const resume = () => { frozen = false; visibility(); };
    const configure = async () => {
      if (source.format === 'mp4') { video.src = source.url; return; }
      const native = /Apple/.test(navigator.vendor) && video.canPlayType('application/vnd.apple.mpegurl');
      if (native) { current.current = { native: true, change: value => changeNative(value) }; changeNative(options.current.quality, false); return; }
      const { default: HlsPlayer } = await import('hls.js');
      if (disposed) return;
      if (!HlsPlayer.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { current.current = { native: true, change: value => changeNative(value) }; changeNative(options.current.quality, false); }
        else if (source.fallback) video.src = source.fallback.url;
        else options.current.onError('无法播放媒体');
        return;
      }
      hls = new HlsPlayer({ workerPath, maxBufferLength: 16, maxMaxBufferLength: 20, backBufferLength: 8, maxBufferSize: 12 * 1024 ** 2, startLevel: -1, lowLatencyMode: false, xhrSetup: xhr => { xhr.withCredentials = true; } });
      const change = (selected: string) => {
        if (!hls || !hls.levels.length) return;
        const index = source.variants?.findIndex(variant => variant.key === selected) ?? -1;
        // 下一分片切档，保留已缓冲画面、当前时间和暂停状态。
        hls.nextLevel = selected === 'auto' ? -1 : index;
      };
      current.current = { hls, change };
      hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => { change(options.current.quality); visibility(); });
      hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
        const status = data.response?.code;
        if (status === 401 || status === 403) { hls?.stopLoad(); video.pause(); options.current.onError(status === 403 ? 'VIP_REQUIRED' : '请刷新页面后重试'); return; }
        if (!data.fatal) return;
        if (data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls?.recoverMediaError(); }
        else { hls?.stopLoad(); options.current.onError('无法播放媒体'); }
      });
      hls.attachMedia(video); hls.loadSource(source.url);
      document.addEventListener('visibilitychange', visibility);
      document.addEventListener('freeze', freeze); document.addEventListener('resume', resume);
      window.addEventListener('pagehide', freeze); window.addEventListener('pageshow', resume);
    };
    void configure().catch(() => { if (!disposed) options.current.onError('无法播放媒体'); });
    return () => {
      disposed = true; cancelRestore(); document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('freeze', freeze); document.removeEventListener('resume', resume);
      window.removeEventListener('pagehide', freeze); window.removeEventListener('pageshow', resume);
      hls?.destroy(); current.current = {}; video.pause(); video.removeAttribute('src'); video.load();
    };
  }, [ref, source]);
  useEffect(() => { current.current.change?.(quality); }, [quality]);
}
