// 后台暂停并保留播放意图，返回时只恢复此前正在播放的同一个播放器。
export function bindPlaybackLifecycle(video, page = document, surface = window) {
  let resumePending = false, frozen = false, disposed = false;
  const nativeFullscreen = () => !!video.webkitDisplayingFullscreen;
  const suspend = () => {
    if (nativeFullscreen()) return;
    resumePending = resumePending || (!video.paused && !video.ended);
    video.pause();
  };
  const resume = () => {
    if (disposed || frozen || page.visibilityState === 'hidden' || !resumePending || video.ended) return;
    resumePending = false;
    Promise.resolve(video.play()).then(() => {
      if (disposed || frozen || page.visibilityState === 'hidden' && !nativeFullscreen()) video.pause();
    }).catch(() => {});
  };
  const visibility = () => page.visibilityState === 'hidden' ? suspend() : resume();
  const freeze = () => { frozen = true; suspend(); };
  const thaw = () => { frozen = false; resume(); };
  const play = () => { if (frozen || page.visibilityState === 'hidden') suspend(); };
  page.addEventListener('visibilitychange', visibility);
  page.addEventListener('freeze', freeze);
  page.addEventListener('resume', thaw);
  surface.addEventListener('pagehide', suspend);
  surface.addEventListener('pageshow', thaw);
  video.addEventListener('play', play);
  visibility();
  return () => {
    disposed = true; resumePending = false;
    page.removeEventListener('visibilitychange', visibility);
    page.removeEventListener('freeze', freeze);
    page.removeEventListener('resume', thaw);
    surface.removeEventListener('pagehide', suspend);
    surface.removeEventListener('pageshow', thaw);
    video.removeEventListener('play', play);
  };
}
