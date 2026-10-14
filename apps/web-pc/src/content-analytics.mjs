// 独立于续播历史采集真实播放区间；重试始终提交累计快照，服务端按序号去重。
export function unionRanges(ranges) {
  const result = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else result.push([...range]);
  }
  return result;
}

export class PlaybackAnalytics {
  constructor(send, durationMs, clock = () => performance.now()) {
    this.send = send; this.durationMs = durationMs; this.clock = clock;
    this.watchMs = 0; this.ranges = []; this.errors = 0; this.sequence = 0;
    this.anchor = null; this.blocked = false;
  }
  sample(video, visible = true, stopping = false) {
    const now = this.clock(), position = video.currentTime * 1000;
    const eligible = visible && !video.seeking && video.readyState >= 3 && !this.blocked && (stopping || !video.paused && !video.ended);
    if (this.anchor && eligible) {
      const elapsed = now - this.anchor.time, advanced = position - this.anchor.position;
      // 大跨度、倒退和缺失心跳都视为跳转，不能补成已观看内容。
      if (elapsed > 0 && elapsed <= 1500 && advanced > 0 && advanced <= elapsed * video.playbackRate + 350) {
        const lower = Math.max(0, Math.round(this.anchor.position)), upper = Math.min(this.durationMs, Math.round(position));
        if (upper > lower) {
          this.watchMs += Math.min(elapsed, advanced / video.playbackRate);
          this.ranges = unionRanges([...this.ranges, [lower, upper]]);
        }
      }
    }
    this.anchor = eligible && !stopping ? { time: now, position } : null;
  }
  flush() {
    this.send({ sequence: ++this.sequence, watchMs: Math.round(this.watchMs), ranges: this.ranges.map(range => [...range]), errors: this.errors });
  }
  bind(video, env = globalThis) {
    const doc = env.document, win = env.window || env;
    const sample = () => this.sample(video, !doc.hidden);
    const playing = () => { this.blocked = false; this.anchor = null; sample(); };
    const stop = () => { this.sample(video, !doc.hidden, true); this.anchor = null; };
    const block = () => { stop(); this.blocked = true; };
    const seek = () => { this.anchor = null; this.blocked = true; };
    const seeked = () => { this.blocked = false; this.anchor = null; sample(); };
    const error = () => { block(); this.errors = Math.min(100, this.errors + 1); this.flush(); };
    const hidden = () => { if (doc.hidden) { this.anchor = null; this.flush(); } else sample(); };
    const pagehide = () => { stop(); this.flush(); };
    const listeners = { playing, pause: stop, ended: pagehide, waiting: block, stalled: block, seeking: seek, seeked, error, timeupdate: sample, ratechange: seeked };
    this.blocked = video.seeking || video.readyState < 3; this.anchor = null;
    for (const [event, callback] of Object.entries(listeners)) video.addEventListener(event, callback);
    doc.addEventListener('visibilitychange', hidden); win.addEventListener('pagehide', pagehide);
    const sampleTimer = env.setInterval(sample, 250), flushTimer = env.setInterval(() => this.flush(), 5000);
    sample();
    // 监听挂载前已经发生的媒体错误仍需记入，普通加载状态不算错误。
    if (video.error) error();
    return () => {
      stop(); this.flush(); env.clearInterval(sampleTimer); env.clearInterval(flushTimer);
      for (const [event, callback] of Object.entries(listeners)) video.removeEventListener(event, callback);
      doc.removeEventListener('visibilitychange', hidden); win.removeEventListener('pagehide', pagehide);
    };
  }
}
