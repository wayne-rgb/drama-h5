// 登录和支付只返回本站已知页面；不接收任意跳转地址或令牌参数。
export function safeAccountReturn(value, origin, fallback = '/?account=profile') {
  try {
    const url = new URL(typeof value === 'string' ? value : fallback, origin);
    if (url.origin !== origin || url.pathname !== '/') return fallback;
    const params = new URLSearchParams();
    const series = url.searchParams.get('series'), episode = url.searchParams.get('episode');
    if (/^\d{1,40}$/.test(series || '')) { params.set('series', series); if (/^\d{1,40}$/.test(episode || '')) params.set('episode', episode); }
    const panel = url.searchParams.get('account');
    if (['profile','membership'].includes(panel)) params.set('account',panel);
    if (panel === 'membership' && ['monthly','annual'].includes(url.searchParams.get('plan'))) params.set('plan',url.searchParams.get('plan'));
    if (!params.has('series') && !params.has('account')) return fallback;
    return `/?${params}`;
  } catch { return fallback; }
}
