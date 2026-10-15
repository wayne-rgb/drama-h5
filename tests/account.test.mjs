import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, digest, passwordHash, passwordMatches } from '../server/account-store.mjs';

test('按编号和邮箱精确删除确认账号及凭证，其他账号与会话保持原值',()=>{
  const store=new AccountStore(':memory:');
  try {
    const first=store.create({email:'retired-first@example.invalid',name:'已确认测试账号一'}),second=store.create({email:'retired-second@example.invalid',name:'已确认测试账号二'}),kept=store.create({email:'retained@example.invalid',name:'保留观众'});
    const sessions=[first,second,kept].map(row=>store.session(row.id)),tokens=[first,second,kept].map(row=>store.token('reset',row.id));
    for(const row of [first,second,kept])store.db.prepare('INSERT INTO account_mfa VALUES(?,?,?,?,?)').run(row.id,'测试凭证',0,'[]',Date.now());
    const before=store.byId(kept.id),keptSession=store.db.prepare('SELECT * FROM account_sessions WHERE account_id=?').get(kept.id),keptMfa=store.db.prepare('SELECT * FROM account_mfa WHERE account_id=?').get(kept.id);
    const confirmed=[first,second].map(row=>({id:row.id,email:row.email})),result=store.retireConfirmedAccounts(confirmed);
    assert.deepEqual(result.deleted,[first.id,second.id]);assert.equal(store.byId(first.id),null);assert.equal(store.byId(second.id),null);
    for(const token of sessions.slice(0,2))assert.equal(store.viewer(token),null);
    for(const token of tokens.slice(0,2))assert.throws(()=>store.consumeToken(token,'reset'));
    assert.deepEqual(store.byId(kept.id),before);assert.deepEqual(store.db.prepare('SELECT * FROM account_sessions WHERE account_id=?').get(kept.id),keptSession);assert.deepEqual(store.db.prepare('SELECT * FROM account_mfa WHERE account_id=?').get(kept.id),keptMfa);
    assert.equal(store.viewer(sessions[2]).id,kept.id);assert.equal(store.consumeToken(tokens[2],'reset').accountId,kept.id);
    assert.deepEqual(store.retireConfirmedAccounts(confirmed),{deleted:[],alreadyAbsent:[first.id,second.id]});
  }finally{store.close();}
});

test('清单不符或关联会员支付时整批拒绝，不删除已校验账号或业务记录',()=>{
  const store=new AccountStore(':memory:');
  try {
    const first=store.create({email:'confirmed@example.invalid',name:'已确认账号'}),paid=store.create({email:'paid@example.invalid',name:'付费观众'}),manual=store.create({email:'manual@example.invalid',name:'历史赠送观众'});
    const session=store.session(first.id);
    store.saveSubscription('保留的支付事件',{id:'保留的订阅',accountId:paid.id,planId:'monthly',status:'canceled',periodEnd:0,cancelAtPeriodEnd:true},Date.now());
    store.db.prepare('INSERT INTO account_manual_vip VALUES(?,?,?,?,?)').run(manual.id,0,'历史操作者','保留历史赠送原因',Date.now());
    for(const other of [paid,manual])assert.throws(()=>store.retireConfirmedAccounts([{id:first.id,email:first.email},{id:other.id,email:other.email}]),error=>error.status===409);
    assert.throws(()=>store.retireConfirmedAccounts([{id:first.id,email:'wrong@example.invalid'}]),error=>error.status===409);
    assert.throws(()=>store.retireConfirmedAccounts([{id:'错误编号',email:first.email}]),error=>error.status===409);
    assert.throws(()=>store.retireConfirmedAccounts([{id:first.id,email:first.email},{id:first.id,email:first.email}]),error=>error.status===400);
    assert.equal(store.viewer(session).id,first.id);assert.ok(store.byId(paid.id));assert.ok(store.byId(manual.id));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM account_billing_events').get().n,1);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM account_manual_vip').get().n,1);
  }finally{store.close();}
});

test('密码有独立盐且错误密码与不存在账户不能通过验证', async () => {
  const password = '仅限本地测试的密码-2026';
  const first = await passwordHash(password), second = await passwordHash(password);
  assert.notEqual(first, second); assert.ok(!first.includes(password));
  assert.equal(await passwordMatches(password, first), true);
  assert.equal(await passwordMatches('错误密码', first), false);
  assert.equal(await passwordMatches(password, null), false);
  await assert.rejects(passwordHash('短密码'), /12至256/);
});

test('会话仅保存令牌摘要，退出和密码重置会撤销旧会话', async () => {
  const store = new AccountStore(':memory:');
  try {
    const account = store.create({ email: 'first@example.invalid', name: '会话测试', hash: await passwordHash('测试会话的安全密码-2026') });
    const first = store.session(account.id), second = store.session(account.id);
    assert.equal(store.viewer(first).id, account.id);
    assert.equal(store.db.prepare('SELECT token_hash FROM account_sessions WHERE token_hash=?').get(digest(first)).token_hash, digest(first));
    store.logout(first); assert.equal(store.viewer(first), null); assert.ok(store.viewer(second));
    store.resetPassword(account.id, await passwordHash('重置后的安全密码-2026'));
    assert.equal(store.viewer(second), null);
    assert.equal(store.publicAccount(store.byId(account.id)).emailVerified, true);
    assert.equal('password_hash' in store.publicAccount(account), false);
  } finally { store.close(); }
});

test('验证与重置令牌限目的、限有效期且只能使用一次', () => {
  const store = new AccountStore(':memory:');
  try {
    const account = store.create({ email: 'tokens@example.invalid', name: '令牌测试' });
    const token = store.token('verify', account.id);
    assert.throws(() => store.consumeToken(token, 'reset'), /链接已失效/);
    assert.equal(store.consumeToken(token, 'verify').accountId, account.id);
    assert.throws(() => store.consumeToken(token, 'verify'), /链接已失效/);
    assert.throws(() => store.consumeToken(store.token('reset', account.id, {}, -1), 'reset'), /链接已失效/);
  } finally { store.close(); }
});

test('游客签名不能伪造、修改或跨服务使用',()=>{
  const first=new AccountStore(':memory:'),second=new AccountStore(':memory:');
  try {
    const guest=first.guestSession();
    assert.equal(first.guest(guest.token).id,guest.id);
    assert.equal(first.guest(guest.token).guest,true);
    assert.equal(second.guest(guest.token),null);
    assert.equal(first.guest(guest.token.slice(0,-1)+(guest.token.endsWith('a')?'b':'a')),null);
    assert.equal(first.guest(guest.token.replace(guest.id,'00000000-0000-0000-0000-000000000000')),null);
    assert.equal(first.guest('任意游客编号'),null);
  } finally {first.close();second.close();}
});

test('会员取消续费后保留有效期，过期与其他账号没有权益', () => {
  const store = new AccountStore(':memory:');
  try {
    const first = store.create({ email: 'vip1@example.invalid', name: '会员一' }), second = store.create({ email: 'vip2@example.invalid', name: '会员二' });
    const subscription = { id: 'sub_test', accountId: first.id, planId: 'annual', status: 'active', periodEnd: Date.now() + 86400000, cancelAtPeriodEnd: true };
    store.saveSubscription('evt_first', subscription, 10);
    assert.equal(store.membership(first.id).active, true); assert.equal(store.membership(first.id).cancelAtPeriodEnd, true);
    assert.equal(store.membership(second.id).active, false);
    assert.equal(store.saveSubscription('evt_first', { ...subscription, status: 'canceled' }, 20), false);
    store.saveSubscription('evt_old', { ...subscription, status: 'canceled' }, 5);
    assert.equal(store.membership(first.id).active, true);
    store.saveSubscription('evt_expired', { ...subscription, periodEnd: Date.now() - 1000 }, 20);
    assert.equal(store.membership(first.id).active, false);
    store.saveSubscription('evt_cancelled', { ...subscription, status: 'canceled' }, 30);
    assert.equal(store.membership(first.id).active, false);
    store.saveSubscription('evt_new', { ...subscription, id: 'sub_current', planId: 'monthly', periodEnd: Date.now() + 60000, cancelAtPeriodEnd: false }, 40);
    assert.equal(store.membership(first.id).planId, 'monthly'); assert.equal(store.membership(first.id).active, true);
  } finally { store.close(); }
});

test('头像接口拒绝可执行格式并且资料更新不泄露密码', () => {
  const store = new AccountStore(':memory:');
  try {
    const account = store.create({ email: 'avatar@example.invalid', name: '头像测试' });
    assert.throws(() => store.updateProfile(account.id, { avatar: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64') }), /头像需为/);
    const updated = store.updateProfile(account.id, { name: '新的昵称' });
    assert.equal(store.publicAccount(updated).name, '新的昵称');
    assert.deepEqual(Object.keys(store.publicAccount(updated)).sort(), ['avatarUrl', 'creator', 'email', 'emailVerified', 'googleLinked', 'id', 'membership', 'name'].sort());
    assert.equal(store.publicAccount(updated).creator, false);
  } finally { store.close(); }
});

test('真实账号接口隔离个人资料，拒绝跨来源修改和未配置的订阅', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-account-'));
  const origin = 'http://127.0.0.1:4318';
  const child = fork(new URL('../server/index.mjs', import.meta.url), [], { env: { ...process.env, HG_HOST: '127.0.0.1', PORT: '0', HG_DATA_DIR: directory, HISTORY_DB_PATH: path.join(directory, 'history.sqlite'), HG_ENV_FILE: path.join(directory, 'absent.env'), APP_ORIGIN: origin, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', SMTP_HOST: '', SMTP_FROM: '', BILLING_PROVIDER: 'none', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr.on('data', value => { diagnostics += value.toString(); });
  t.after(async () => { if (child.exitCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.send({ type: 'shutdown' }); await exit; } await fs.rm(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('账号测试服务启动超时')), 10000); child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(Error(diagnostics)); }); child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); } }); });
  const request = async (route, body, actor = {}, requestOrigin = origin) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: requestOrigin }), ...(actor.cookie ? { Cookie: actor.cookie } : {}), ...(actor.owner ? { 'X-Library-Owner': actor.owner } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cookieHeader: response.headers.get('set-cookie') };
  };
  const guestA=await request('/api/account/session'),guestB=await request('/api/account/session');
  assert.notEqual(guestA.data.libraryOwner,guestB.data.libraryOwner);
  assert.match(guestA.cookieHeader,/hg_guest_session=.*HttpOnly.*SameSite=Lax/);
  const anonymousA={cookie:guestA.cookie,owner:guestA.data.libraryOwner},anonymousB={cookie:guestB.cookie,owner:guestB.data.libraryOwner};
  const guestFavorite={id:'7503745441910017049',title:'游客隔离验收',cover:''};
  const guestOperation={id:'guest-isolation',kind:'favorite',key:guestFavorite.id,op:'set',at:Date.now(),value:guestFavorite};
  assert.equal((await request('/api/library/operations',guestOperation,anonymousA)).status,200);
  assert.equal((await request('/api/library',undefined,anonymousA)).data.favorites.length,1);
  assert.equal((await request('/api/library',undefined,anonymousB)).data.favorites.length,0);
  assert.equal((await request('/api/library')).status,409);
  assert.equal((await request('/api/library',undefined,{...anonymousB,owner:anonymousA.owner})).status,409);
  assert.equal((await request('/api/library',undefined,{cookie:anonymousA.cookie})).status,409);
  assert.equal((await request('/api/library/operations',{...guestOperation,id:'cross-guest'},anonymousA,'https://untrusted.example')).status,403);
  assert.equal((await request('/api/library/operations',{...guestOperation,id:'null-origin'},anonymousA,'null')).status,403);
  assert.equal((await request('/api/library/sync',{url:'http://127.0.0.1:9',key:'测试不能触发服务器访问'},anonymousA)).status,403);
  const first = await request('/api/auth/register', { email: 'a@example.invalid', name: '测试账户一', password: '测试账户一的独立密码-2026' });
  assert.equal(first.status, 200); assert.match(first.cookieHeader, /HttpOnly/); assert.match(first.cookieHeader, /SameSite=Lax/);
  const actorA = { cookie: first.cookie, owner: first.data.user.id };
  assert.equal((await request('/api/library/sync',{url:'http://127.0.0.1:9',key:'测试不能触发服务器访问'},actorA)).status,403);
  const second = await request('/api/auth/register', { email: 'b@example.invalid', name: '测试账户二', password: '测试账户二的独立密码-2026' });
  const actorB = { cookie: second.cookie, owner: second.data.user.id };
  assert.equal(second.status, 200); assert.notEqual(actorA.owner, actorB.owner);
  const series = { id: '7527125460430375961', title: '一品布衣', cover: '', badge: '', tags: '', description: '' };
  const favorite = await request('/api/library/operations', { id: 'fixture-favorite', kind: 'favorite', key: series.id, op: 'set', at: Date.now(), value: series }, actorA);
  assert.equal(favorite.status, 200);
  assert.equal((await request('/api/library', undefined, actorA)).data.favorites.length, 1);
  assert.equal((await request('/api/library', undefined, actorB)).data.favorites.length, 0);
  assert.equal((await request('/api/library', undefined, { cookie: actorA.cookie, owner: actorB.owner })).status, 409);
  assert.equal((await request('/api/library', undefined, { cookie: actorA.cookie })).status, 409);
  assert.equal((await request('/api/account/profile', { name: '越权修改' }, actorA, 'https://untrusted.example')).status, 403);
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg==';
  const saved = await request('/api/account/profile', { name: '已保存的资料', avatar: image, membership: { active: true } }, actorA);
  assert.equal(saved.status, 200); assert.equal(saved.data.user.name, '已保存的资料'); assert.equal(saved.data.user.membership.active, false);
  const avatar = await fetch(`http://127.0.0.1:${port}/api/account/avatar`, { headers: { Cookie: actorA.cookie } });
  assert.equal(avatar.status, 200); assert.equal(avatar.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await avatar.arrayBuffer()), Buffer.from(image, 'base64'));
  assert.equal((await request('/api/account/avatar', undefined, actorB)).status, 404);
  assert.equal((await request('/api/auth/login', { email: 'a@example.invalid', password: '错误密码' })).status, 401);
  assert.equal((await request('/api/billing/checkout', { planId: 'monthly' }, actorA)).status, 503);
  const session = await request('/api/account/session', undefined, actorA);
  assert.equal(session.data.user.membership.active, false); assert.deepEqual(session.data.plans.map(row => row.amount), [2999, 19999]);
  assert.equal(session.data.capabilities.google, false); assert.equal(session.data.capabilities.email, false); assert.equal(session.data.capabilities.billing, false);
  assert.equal((await request('/api/auth/google/start')).status, 503);
  assert.equal((await request('/api/auth/recover', { email: 'a@example.invalid' })).status, 503);
  assert.equal((await request('/api/auth/logout', {}, actorA)).status, 200);
  assert.equal((await request('/api/account/session', undefined, actorA)).data.user, null);
  assert.equal((await request('/api/library/operations', { id: 'stale-write', kind: 'favorite', key: series.id, op: 'set', at: Date.now(), value: series }, actorA)).status, 409);
  const login = await request('/api/auth/login', { email: 'a@example.invalid', password: '测试账户一的独立密码-2026' });
  assert.equal(login.status, 200); assert.equal(login.data.user.id, actorA.owner);
  const recovered = await request('/api/library', undefined, { owner: actorA.owner, cookie: login.cookie });
  assert.equal(recovered.data.favorites.length, 1);
  assert.equal((await request('/api/library',undefined,anonymousA)).data.favorites.length,1);
  const health=await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.headers.get('x-content-type-options'),'nosniff');
  assert.equal(health.headers.get('x-frame-options'),'DENY');
  assert.match(health.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
