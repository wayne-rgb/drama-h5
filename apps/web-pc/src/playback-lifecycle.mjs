// 后台暂停并保留播放意图，返回时只恢复此前正在播放的同一个播放器。
export function bindPlaybackLifecycle(video, page = document, surface = window) {
  let resumePending = false, frozen = false, disposed = false;
  let playingIntent = !video.paused && !video.ended, pauseTimer = null;
  const defer = surface.setTimeout?.bind(surface) || setTimeout;
  const cancel = surface.clearTimeout?.bind(surface) || clearTimeout;
  const clearPauseTimer = () => { if (pauseTimer !== null) cancel(pauseTimer); pauseTimer = null; };
  const stopIntent = () => { clearPauseTimer(); playingIntent = false; resumePending = false; };
  const nativeFullscreen = () => !!video.webkitDisplayingFullscreen;
  const suspend = () => {
    if (nativeFullscreen()) return;
    clearPauseTimer();
    resumePending = resumePending || playingIntent || (!video.paused && !video.ended);
    video.pause();
  };
  const resume = () => {
    if (disposed || frozen || page.visibilityState === 'hidden' || !resumePending || video.ended) return;
    resumePending = false;
    Promise.resolve(video.play()).then(() => {
      if (disposed || frozen || page.visibilityState === 'hidden' && !nativeFullscreen()) video.pause();
    }).catch(() => { playingIntent = false; });
  };
  const visibility = () => page.visibilityState === 'hidden' ? suspend() : resume();
  const freeze = () => { frozen = true; suspend(); };
  const thaw = () => { frozen = false; resume(); };
  const play = () => {
    clearPauseTimer(); playingIntent = !video.ended;
    if (frozen || page.visibilityState === 'hidden') suspend();
  };
  const pause = () => {
    if (disposed) return;
    if (video.ended || nativeFullscreen()) { stopIntent(); return; }
    if (resumePending || frozen || page.visibilityState === 'hidden') return;
    // iOS 会先暂停媒体，再通知页面进入后台，不能立即丢弃此前的播放意图。
    clearPauseTimer();
    pauseTimer = defer(() => {
      pauseTimer = null;
      if (!disposed && video.paused && !resumePending && !frozen && page.visibilityState !== 'hidden') playingIntent = false;
    }, 250);
  };
  const input = () => {
    const wasPlaying = !video.paused && !video.ended;
    // 页面控件在同一次输入处理中暂停视频时，立即保留用户的暂停意图。
    queueMicrotask(() => {
      if (!disposed && wasPlaying && video.paused && !resumePending && !frozen && page.visibilityState !== 'hidden') stopIntent();
    });
  };
  page.addEventListener('visibilitychange', visibility);
  page.addEventListener('freeze', freeze);
  page.addEventListener('resume', thaw);
  surface.addEventListener('pagehide', suspend);
  surface.addEventListener('pageshow', thaw);
  video.addEventListener('play', play);
  video.addEventListener('pause', pause);
  video.addEventListener('ended', stopIntent);
  for (const event of ['pointerup', 'click', 'keydown']) page.addEventListener(event, input, true);
  visibility();
  return () => {
    disposed = true; stopIntent();
    page.removeEventListener('visibilitychange', visibility);
    page.removeEventListener('freeze', freeze);
    page.removeEventListener('resume', thaw);
    surface.removeEventListener('pagehide', suspend);
    surface.removeEventListener('pageshow', thaw);
    video.removeEventListener('play', play);
    video.removeEventListener('pause', pause);
    video.removeEventListener('ended', stopIntent);
    for (const event of ['pointerup', 'click', 'keydown']) page.removeEventListener(event, input, true);
  };
}
