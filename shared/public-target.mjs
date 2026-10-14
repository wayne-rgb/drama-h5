import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const denied = new BlockList();
for (const [network, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['100.64.0.0',10],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(network,prefix,'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
for (const [network, prefix] of [['2001:db8::',32],['2001::',32],['2002::',16]]) denied.addSubnet(network,prefix,'ipv6');

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !denied.check(address,'ipv4') : family === 6 && globalV6.check(address,'ipv6') && !denied.check(address,'ipv6');
}
export function assertPublicTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('内容源地址无效'); }
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (isIP(hostname) ? !isPublicAddress(hostname) : /(^|\.)(localhost|local|internal)$/i.test(hostname))) throw new Error('内容源地址不允许访问');
  return url;
}
// 在实际连接时校验 DNS，重定向也使用同一解析器，避免先校验后换地址。
export function publicLookup(hostname, options, callback) {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) return callback(new Error('内容源地址不允许访问'));
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}
