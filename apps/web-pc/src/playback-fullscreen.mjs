// 桌面与手机共用全屏入口，兼容仅支持视频原生全屏的 Safari。
export async function toggleMediaFullscreen(container, video, page = document) {
  if (video?.webkitDisplayingFullscreen && video.webkitExitFullscreen) {
    video.webkitExitFullscreen(); return;
  }
  if (page.fullscreenElement) { await page.exitFullscreen(); return; }
  if (container?.requestFullscreen) {
    try { await container.requestFullscreen(); return; } catch {}
  }
  if (video?.webkitEnterFullscreen) { video.webkitEnterFullscreen(); return; }
  throw new Error('操作失败，请稍后重试');
}
