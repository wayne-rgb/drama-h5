import test from 'node:test';
import assert from 'node:assert/strict';
import { bindPlaybackLifecycle } from '../apps/web-pc/src/playback-lifecycle.mjs';
import { toggleMediaFullscreen } from '../apps/web-pc/src/playback-fullscreen.mjs';

function fixture(paused = false) {
  const page = new EventTarget(), surface = new EventTarget(), video = new EventTarget();
  page.visibilityState = 'visible';
  Object.assign(video, { paused, ended: false, currentTime: 88, plays: 0 });
  video.pause = () => { video.paused = true; video.dispatchEvent(new Event('pause')); };
  video.play = () => { video.paused = false; video.plays++; video.dispatchEvent(new Event('play')); return Promise.resolve(); };
  const cleanup = bindPlaybackLifecycle(video, page, surface);
  return { page, surface, video, cleanup };
}
const emit = (target, name) => target.dispatchEvent(new Event(name));

test('进入后台暂停，返回前台只恢复一次并保留进度', async () => {
  const { page, surface, video, cleanup } = fixture();
  page.visibilityState = 'hidden'; emit(page, 'visibilitychange');
  assert.equal(video.paused, true); assert.equal(video.currentTime, 88);
  emit(page, 'freeze'); emit(surface, 'pagehide'); emit(page, 'resume');
  assert.equal(video.plays, 0);
  page.visibilityState = 'visible'; emit(page, 'visibilitychange'); emit(surface, 'pageshow');
  await Promise.resolve();
  assert.equal(video.paused, false); assert.equal(video.plays, 1); assert.equal(video.currentTime, 88);
  cleanup();
});

test('用户手动暂停的播放器经历挂起和页面恢复后不自动播放', () => {
  const { page, surface, video, cleanup } = fixture(true);
  emit(page, 'freeze'); emit(surface, 'pagehide'); emit(page, 'resume'); emit(surface, 'pageshow');
  assert.equal(video.paused, true); assert.equal(video.plays, 0); cleanup();
});

test('后台才完成加载的视频及时暂停，返回时可恢复且旧播放器解绑后不再续播', async () => {
  const { page, video, cleanup } = fixture(true);
  page.visibilityState = 'hidden'; emit(page, 'visibilitychange'); await video.play();
  assert.equal(video.paused, true);
  page.visibilityState = 'visible'; emit(page, 'visibilitychange'); await Promise.resolve();
  assert.equal(video.paused, false); assert.equal(video.plays, 2);
  page.visibilityState = 'hidden'; emit(page, 'visibilitychange'); cleanup();
  page.visibilityState = 'visible'; emit(page, 'visibilitychange'); emit(page, 'resume');
  assert.equal(video.paused, true); assert.equal(video.plays, 2);
});

test('Safari 视频原生全屏不因页面隐藏而暂停，结束后也不强制重新播放', () => {
  const { page, video, cleanup } = fixture();
  video.webkitDisplayingFullscreen = true;
  page.visibilityState = 'hidden'; emit(page, 'visibilitychange');
  assert.equal(video.paused, false);
  video.pause(); video.webkitDisplayingFullscreen = false;
  page.visibilityState = 'visible'; emit(page, 'visibilitychange');
  assert.equal(video.paused, true); assert.equal(video.plays, 0); cleanup();
});

test('浏览器拒绝恢复播放时不会造成未处理异常或反复自动重试', async () => {
  const { page, video, cleanup } = fixture();
  emit(page, 'freeze'); video.play = () => Promise.reject(Error('浏览器要求重新点击播放'));
  emit(page, 'resume'); await Promise.resolve(); await Promise.resolve();
  emit(page, 'visibilitychange'); assert.equal(video.paused, true); cleanup();
});

test('标准全屏进出与 Safari 原生全屏进出共用入口', async () => {
  let entered = 0, exited = 0;
  const page = { fullscreenElement: null, exitFullscreen: async () => { exited++; } };
  await toggleMediaFullscreen({ requestFullscreen: async () => { entered++; } }, null, page);
  page.fullscreenElement = {}; await toggleMediaFullscreen(null, null, page);
  assert.equal(entered, 1); assert.equal(exited, 1);
  const video = { webkitEnterFullscreen: () => { entered++; }, webkitExitFullscreen: () => { exited++; } };
  page.fullscreenElement = null; await toggleMediaFullscreen(null, video, page);
  video.webkitDisplayingFullscreen = true; await toggleMediaFullscreen(null, video, page);
  assert.equal(entered, 2); assert.equal(exited, 2);
});

test('容器全屏失败时回退原生视频全屏，无可用接口时明确失败', async () => {
  const container = { requestFullscreen: async () => { throw Error('当前浏览器不支持容器全屏'); } };
  let entered = false;
  await toggleMediaFullscreen(container, { webkitEnterFullscreen: () => { entered = true; } }, {});
  assert.equal(entered, true);
  await assert.rejects(toggleMediaFullscreen(null, null, {}), /操作失败/);
});
