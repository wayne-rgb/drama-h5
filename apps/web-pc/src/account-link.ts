// 兼容旧邮件的查询参数，新邮件使用不会发送给服务器的片段；令牌仅保留在当前页面内存。
type LinkPurpose = 'reset' | 'verify';
let purpose: LinkPurpose | null = null, token: string | null = null, revision = 0;
const listeners = new Set<() => void>();
function captureAccountLink() {
  const url = new URL(window.location.href), panel = url.searchParams.get('account');
  const nextPurpose = panel === 'reset' || panel === 'verify' ? panel : null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!url.searchParams.has('token') && !fragment.has('token')) {
    purpose = nextPurpose; token = null;
  } else {
    purpose = nextPurpose;
    token = purpose ? fragment.get('token') || url.searchParams.get('token') : null;
    url.searchParams.delete('token');
    if (fragment.has('token')) { fragment.delete('token'); url.hash = fragment.toString(); }
    window.history.replaceState(window.history.state, '', url);
  }
  revision++;
  for (const listener of listeners) listener();
}
captureAccountLink();
window.addEventListener('hashchange', captureAccountLink);

export function accountLinkToken(expectedPurpose: LinkPurpose) { return purpose === expectedPurpose ? token : null; }
export function accountLinkPurpose() { return purpose; }
export function accountLinkRevision() { return revision; }
export function subscribeAccountLink(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function clearAccountLinkToken(expectedRevision = revision) { if (revision === expectedRevision) token = null; }
