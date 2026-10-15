// 兼容旧邮件的查询参数，新邮件使用不会发送给服务器的片段；令牌仅保留在当前页面内存。
const url = new URL(window.location.href);
const purpose = url.searchParams.get('account');
const fragment = new URLSearchParams(url.hash.slice(1));
let token = purpose === 'reset' || purpose === 'verify' ? fragment.get('token') || url.searchParams.get('token') : null;
if (url.searchParams.has('token') || fragment.has('token')) {
  url.searchParams.delete('token');
  if (fragment.has('token')) { fragment.delete('token'); url.hash = fragment.toString(); }
  window.history.replaceState(null, '', url);
}

export function accountLinkToken(expectedPurpose: 'reset' | 'verify') { return purpose === expectedPurpose ? token : null; }
export function clearAccountLinkToken() { token = null; }
