import { RefObject, useEffect, useRef, useState } from 'react';
import { accountRequest } from './account';
import { PlaybackAnalytics } from './content-analytics.mjs';

const queueKey = 'drama_content_analytics_v1';
type Snapshot = { id: string; sequence: number; watchMs: number; ranges: number[][]; errors: number };
type Pending = { owner: string; at: number; snapshot: Snapshot };
let queue: Pending[] = [];
try {
  const saved = JSON.parse(localStorage.getItem(queueKey) || '[]');
  if (Array.isArray(saved)) queue = saved.filter(item => typeof item?.owner === 'string' && Number.isFinite(item.at) && typeof item.snapshot?.id === 'string' && Number.isSafeInteger(item.snapshot.sequence) && Array.isArray(item.snapshot.ranges)).slice(-100);
} catch { queue = []; }
let sending = false;
function persist() { try { localStorage.setItem(queueKey, JSON.stringify(queue)); } catch { /* 浏览器禁用存储时保留内存队列。 */ } }
function enqueue(owner: string, snapshot: Snapshot) {
  queue = queue.filter(item => item.snapshot.id !== snapshot.id && Date.now() - item.at < 6 * 3600000);
  queue.push({ owner, snapshot, at: Date.now() }); queue = queue.slice(-100); persist();
  void flush(owner);
}
async function flush(owner: string) {
  if (sending) return;
  sending = true;
  try {
    for (const item of [...queue].filter(item => item.owner === owner)) {
      if (Date.now() - item.at >= 6 * 3600000) { queue = queue.filter(row => row !== item); persist(); continue; }
      try {
        const response = await fetch('/api/analytics/progress', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.snapshot), keepalive: true });
        if (!response.ok && ![400, 404, 409].includes(response.status)) break;
        queue = queue.filter(row => row.snapshot.id !== item.snapshot.id || row.snapshot.sequence > item.snapshot.sequence); persist();
      } catch { break; }
    }
  } finally { sending = false; }
}
export function useContentAnalytics(video: RefObject<HTMLVideoElement>, seriesId: string | undefined, episodeId: string | undefined, enabled: boolean, generation: string, entry: 'detail' | 'feed', identity: string | undefined, locked: boolean, playbackError: string) {
  const tracker = useRef<any>(null), [ready, setReady] = useState(0);
  useEffect(() => {
    if (!enabled || !seriesId || !episodeId || !identity || window.location.protocol === 'file:') return;
    let active = true, opening = false, finished = false;
    const requestId = crypto.randomUUID();
    const start = async () => {
      if (opening || finished) return;
      opening = true;
      try {
        const session = await accountRequest('/api/account/session');
        if (!active || session.libraryOwner !== identity) return;
        void flush(identity);
        const data = await accountRequest('/api/analytics/sessions', { requestId, seriesId, episodeId, entry });
        if(data.deferred)return;
        finished = true;
        if (!active || data.excluded || data.gate) return;
        tracker.current = new PlaybackAnalytics((snapshot: Omit<Snapshot, 'id'>) => enqueue(identity, { ...snapshot, id: data.id }), data.durationMs);
        setReady(value => value + 1);
      } catch { /* 采集失败不能阻断观看；网络恢复后重试相同会话。 */ }
      finally { opening = false; }
    };
    void start();
    const timer = setInterval(() => { void start(); void flush(identity); }, 5000);
    const online = () => { void start(); void flush(identity); };
    window.addEventListener('online', online);
    return () => { active = false; clearInterval(timer); window.removeEventListener('online', online); tracker.current?.flush(); tracker.current = null; };
  }, [seriesId, episodeId, enabled, entry, identity, locked]);
  useEffect(() => {
    if (!tracker.current || !video.current || !enabled) return;
    return tracker.current.bind(video.current);
  }, [ready, generation, enabled, seriesId, episodeId, identity, locked]);
  useEffect(() => {
    if (!tracker.current || !playbackError || playbackError === 'VIP_REQUIRED' || video.current) return;
    tracker.current.errors = Math.min(100, tracker.current.errors + 1); tracker.current.flush();
  }, [ready, playbackError]);
}
