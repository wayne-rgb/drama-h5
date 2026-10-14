import crypto from 'node:crypto';
import { AccountError } from './account-store.mjs';

// 本机连接不等于桌面程序；浏览器来源、Host和主进程证明必须分别核对。
export function createLocalAccess(config, origin) {
  const managed = config.HG_MANAGED === '1', token = config.HG_DESKTOP_TOKEN || '';
  const localSite = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname);
  const loopback = req => {
    const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    if (peer !== '::1' && !/^127\.\d+\.\d+\.\d+$/.test(peer)) return false;
    try {
      const host = new URL(`http://${req.headers.host}`);
      return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && Number(host.port || 80) === req.socket.localPort;
    } catch { return false; }
  };
  const desktop = req => {
    const provided = req.headers['x-desktop-token'];
    return managed && loopback(req) && /^[a-f0-9]{64}$/.test(token) && typeof provided === 'string' && /^[a-f0-9]{64}$/.test(provided) && crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(provided, 'hex'));
  };
  const allowedOrigin = req => !req.headers.origin || req.headers.origin === origin || managed && loopback(req) && req.headers.origin === `http://${req.headers.host}`;
  const forwarded = req => ['forwarded','x-forwarded-for','x-forwarded-host','x-real-ip'].some(key=>req.headers[key] !== undefined);
  const local = req => managed && loopback(req) && (desktop(req) || localSite && !forwarded(req) && req.headers['sec-fetch-site'] !== 'cross-site' && req.headers.origin !== 'null' && allowedOrigin(req));
  const sameOrigin = req => {
    if (desktop(req)) return;
    if (!allowedOrigin(req) || req.headers['sec-fetch-site'] === 'cross-site') throw new AccountError(403, '请求来源无效');
  };
  return { local, sameOrigin };
}
