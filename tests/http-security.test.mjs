import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { LibraryStore } from '../shared/library-store.mjs';
import { AccountError } from '../server/account-store.mjs';
import { publicFailure } from '../server/http-error.mjs';

test('内部错误不向浏览器暴露文件路径、数据库信息或服务凭据', () => {
  for (const error of [new Error('ENOENT /srv/private/accounts.sqlite'), new Error('SQLITE_ERROR: private_table'), new Error('Authorization: Bearer 测试凭据'), null]) {
    const response = publicFailure(error);
    assert.equal(response.status, 500);
    assert.equal(response.message, '操作失败，请稍后重试');
  }
});

test('登录、会员与上传等业务错误继续保留原状态和可操作提示', () => {
  for (const [status, message] of [[401, '请先登录'], [403, 'VIP_REQUIRED'], [409, '上传位置已变化，请恢复上传']]) {
    assert.deepEqual(publicFailure(new AccountError(status, message)), { status, message });
  }
});

for (const localMode of [false, true]) {
  test(localMode ? '桌面本地模式清除旧共享配置且接口不可用' : 'H5清除旧共享配置且静态页面正常', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-http-security-'));
    const library = new LibraryStore(path.join(directory, 'library.sqlite'));
    library.setMeta('syncConfig', { url: 'https://obsolete.example.test', key: '已废弃密钥' });
    library.close();
    const web = path.join(directory, 'web');
    await fs.mkdir(web);
    const html = '<!doctype html><html lang="zh-CN"><title>安全回归页面</title><body>正常页面</body></html>';
    await fs.writeFile(path.join(web, 'index.html'), html);
    const child = fork(new URL('../server/index.mjs', import.meta.url), [], { env: { ...process.env, HG_HOST: '127.0.0.1', PORT: '0', HG_DATA_DIR: directory, HG_WEB_DIR: web, HG_MANAGED: localMode ? '1' : '', HG_ENV_FILE: path.join(directory, 'absent.env'), APP_ORIGIN: 'http://127.0.0.1:4318', ADMIN_ACCOUNT_IDS: '', ADMIN_EMAILS: '', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', BILLING_PROVIDER: 'none' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr.on('data', data => { diagnostics += data.toString(); });
    t.after(async () => {
      if (child.exitCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.send({ type: 'shutdown' }); await exit; }
      await fs.rm(directory, { recursive: true, force: true });
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('安全回归服务启动超时')), 10000);
      child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(diagnostics)); });
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); } });
    });
    const base = `http://127.0.0.1:${port}`;
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(html));
    assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await (await fetch(`${base}/admin`)).text(), html);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/library/sync`)).status, 404);
    assert.equal((await fetch(`${base}/api/library/sync`, { method: 'POST', headers: { Origin: 'http://127.0.0.1:4318', 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
    const saved = new LibraryStore(path.join(directory, 'library.sqlite'));
    try {
      assert.equal(saved.snapshot().favorites.length, 0);
      assert.equal(saved.getMeta('syncConfig'), null);
    } finally { saved.close(); }
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
}
