// 证明仅保留在主进程，外站请求不能经自定义协议取得本地资料权限。
module.exports = function desktopProxy(backendOrigin, desktopToken, fetcher) {
 return async request => {
  const source = new URL(request.url), origin = request.headers.get('Origin');
  if (source.protocol !== 'hongguotv:' || source.hostname !== 'app' || source.port || source.username || source.password || origin && origin !== 'hongguotv://app' || request.headers.get('Sec-Fetch-Site') === 'cross-site') return new Response('', {status:403});
  const headers = new Headers(request.headers);
  headers.set('X-Desktop-Token', desktopToken);
  // Host由网络层按固定后端地址产生，不能沿用自定义协议或外部传入的主机名。
  headers.delete('Host');
  return fetcher(backendOrigin + source.pathname + source.search, {
   method:request.method, headers,
   body:['GET','HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
   bypassCustomProtocolHandlers:true,
  });
 };
};
