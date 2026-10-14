import { LibraryError } from './library-store.mjs';
// 超限后先返回业务错误，再关闭连接；不能销毁读取迭代器而丢掉正常的错误响应。
export function protectRequestBody(req, res) {
  req.once('body-rejected', () => {
    res.shouldKeepAlive = false;
    if (!res.headersSent) res.setHeader('Connection', 'close');
    res.once('finish', () => req.destroy());
  });
}
export async function readBody(req, { maximum = 2097152, timeoutMs = 30000 } = {}) {
  const reject = (status, message) => {
    req.pause?.(); req.emit?.('body-rejected');
    throw new LibraryError(status, message);
  };
  const declared = req.headers?.['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(String(declared)) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) reject(413, 'request too large');
  const iterator = req.iterator ? req.iterator({ destroyOnReturn: false }) : req[Symbol.asyncIterator]();
  const chunks = []; let size = 0, completed = false;
  let timer;
  const deadline = new Promise((_, fail) => { timer = setTimeout(() => fail(new LibraryError(408, 'request body timed out')), timeoutMs); });
  try {
    while (true) {
      const { value, done } = await Promise.race([iterator.next(), deadline]);
      if (done) { completed = true; break; }
      size += value.length;
      if (size > maximum) reject(413, 'request too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error.status === 408) reject(408, error.message);
    throw error;
  } finally {
    clearTimeout(timer);
    if (!completed) Promise.resolve(iterator.return?.()).catch(() => {});
  }
}
export async function readJson(req) {
  const data = await readBody(req);
  try {
    const value = JSON.parse(data.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new LibraryError(400, 'invalid JSON'); }
}
export function sendJson(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS'});res.end(JSON.stringify(value));}
