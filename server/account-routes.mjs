import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import { AccountError, digest, emailAddress, membershipPlans, passwordHash, passwordMatches, secret } from './account-store.mjs';
import { createBilling } from './account-billing.mjs';
import { isAdministrator } from './account-role.mjs';
import { safeAccountReturn } from './account-return.mjs';
import { readJson as readInput, readBody } from '../shared/http-json.mjs';
import { AuthenticationLimits, clientAddress } from './auth-limits.mjs';
import { createLocalAccess } from './local-access.mjs';

async function readJson(req) {
  try { return await readInput(req); }
  catch (error) { if (error instanceof AccountError) throw error; throw new AccountError(error.status || 400, error.status === 408 ? '请求读取超时，请稍后重试' : '请求格式无效'); }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => { const index = part.indexOf('='); return index < 0 ? [] : [part.slice(0, index).trim(), part.slice(index + 1).trim()]; }).filter(row => row.length));
}
function reply(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
export function createAccountService(store, config = process.env) {
  const origin = new URL(config.APP_ORIGIN || `http://127.0.0.1:${config.PORT || 8788}`).origin;
  if (!origin.startsWith('https:') && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('非本机账号服务必须配置HTTPS站点地址');
  const secure = origin.startsWith('https:');
  const oauth = config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET ? new OAuth2Client(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, `${origin}/api/auth/google/callback`) : null;
  const mail = config.SMTP_HOST && config.SMTP_FROM ? nodemailer.createTransport({ host: config.SMTP_HOST, port: Number(config.SMTP_PORT || 587), secure: config.SMTP_SECURE === 'true', requireTLS: config.SMTP_SECURE !== 'true', auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined, connectionTimeout: 15000, socketTimeout: 20000, disableFileAccess: true, disableUrlAccess: true }) : null;
  const billing = createBilling(store, config, origin);
  const rates = new AuthenticationLimits(config);
  const viewer = req => store.viewer(cookies(req).hg_account_session);
  const localAccess = createLocalAccess(config, origin);
  const requireViewer = req => { const account = viewer(req); if (!account) throw new AccountError(401, '请先登录'); return account; };
  const setCookie = (res, name, value, maxAge) => res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  const login = (res, account) => { setCookie(res, 'hg_account_session', store.session(account.id), 2592000); reply(res, { user: store.publicAccount(account) }); };
  const sameOrigin = localAccess.sameOrigin;
  const rateLimit = (req, scope, limit = 20) => {
    rates.request(req, scope, limit);
  };
  const sendToken = async (account, purpose) => {
    if (!mail) throw new AccountError(503, '邮件服务尚未配置');
    const token = store.token(purpose, account.id);
    const url = `${origin}/?account=${purpose}&token=${encodeURIComponent(token)}`;
    await mail.sendMail({ from: config.SMTP_FROM, to: { address: account.email }, subject: purpose === 'reset' ? 'Reset your password' : 'Verify your email', text: `${purpose === 'reset' ? 'Reset your password' : 'Verify your email'}: ${url}\nThis link expires in 30 minutes.` });
  };
  const capabilities = { google: !!oauth, email: !!mail, billing: billing.ready, billingProvider: billing.provider };
  return {
    viewer, sameOrigin, requireViewer,
    address: req => clientAddress(req, rates.trusted),
    audience: req => viewer(req) || store.guest(cookies(req).hg_guest_session),
    canConfigureSync: (account, req) => !!req && localAccess.local(req) || isAdministrator(account,config),
    guardLibrary(req) {
      const local = localAccess.local(req), account = viewer(req), guest = !account && !local ? store.guest(cookies(req).hg_guest_session) : null;
      const owner = account?.id || (guest ? `guest:${guest.id}` : 'guest');
      const requested = req.headers['x-library-owner'];
      if (!account && !local && !guest) throw new AccountError(409, '登录状态已变化，请刷新页面');
      if (account || guest ? requested !== owner : requested && requested !== owner) throw new AccountError(409, '登录状态已变化，请刷新页面');
      // 本地资料只给核实来源的本机访问；普通账户与游客资料始终绑定真实会话。
      sameOrigin(req);
      if (req.method === 'POST' && new URL(req.url,origin).pathname === '/api/library/sync' && !local && !isAdministrator(account,config)) throw new AccountError(403,'需要管理员权限');
      return account || guest;
    },
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/api/auth/') && !url.pathname.startsWith('/api/account/') && !url.pathname.startsWith('/api/billing/')) return false;
      let callbackReturn = '/?account=profile';
      try {
        const route = url.pathname;
        if (route === '/api/billing/webhook' && req.method === 'POST') {
          let body;
          try { body = await readBody(req, { maximum: 262144 }); }
          catch (error) { throw new AccountError(error.status || 400, '请求格式无效'); }
          reply(res, await billing.webhook(body, req.headers['stripe-signature']));
          return true;
        }
        if (req.method === 'POST') {
          sameOrigin(req);
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AccountError(415, '请求格式无效');
        }
        if (route === '/api/account/session' && req.method === 'GET') {
          sameOrigin(req);
          const account = viewer(req), local = localAccess.local(req);
          let guest = !account && !local ? store.guest(cookies(req).hg_guest_session) : null;
          if (!account && !local && !guest) {
            sameOrigin(req); rateLimit(req,'guest',120);
            const session = store.guestSession();guest={id:session.id,guest:true};setCookie(res,'hg_guest_session',session.token,31536000);
          }
          if (!account && local) res.setHeader('Access-Control-Allow-Origin', '*');
          reply(res, { user: store.publicAccount(account), libraryOwner: account?.id || (guest ? `guest:${guest.id}` : 'guest'), capabilities: { ...capabilities, admin: isAdministrator(account, config), creator: store.isCreator(account?.id), librarySync: local || isAdministrator(account,config) }, plans: membershipPlans, siteUrl: origin });
        }
        else if (route === '/api/auth/register' && req.method === 'POST') {
          rateLimit(req, 'register', 10);
          const input = await readJson(req), email = emailAddress(input.email), hash = await passwordHash(input.password);
          const account = store.create({ email, name: input.name || email.split('@')[0], hash });
          login(res, account);
        } else if (route === '/api/auth/login' && req.method === 'POST') {
          // 请求总量保护允许正常成功登录；失败次数分别按账户、地址及两者组合计算。
          rateLimit(req, 'login', 300);
          const input = await readJson(req), email = emailAddress(input.email), account = store.byEmail(email);
          rates.checkLogin(req, email);
          if (!await passwordMatches(input.password, account?.password_hash)) { rates.failedLogin(req, email); throw new AccountError(401, '邮箱或密码不正确'); }
          const current = store.byId(account.id);
          if (!current || current.password_hash !== account.password_hash) { rates.failedLogin(req,email); throw new AccountError(401,'邮箱或密码不正确'); }
          rates.successfulLogin(req, email);
          store.logout(cookies(req).hg_account_session);
          login(res, current);
        } else if (route === '/api/auth/logout' && req.method === 'POST') {
          store.logout(cookies(req).hg_account_session); setCookie(res, 'hg_account_session', '', 0); reply(res, { ok: true });
        } else if (route === '/api/account/profile' && req.method === 'POST') reply(res, { user: store.publicAccount(store.updateProfile(requireViewer(req).id, await readJson(req))) });
        else if (route === '/api/account/avatar' && req.method === 'GET') {
          const account = requireViewer(req);
          if (!account.avatar_mime) throw new AccountError(404, '头像不存在');
          res.writeHead(200, { 'Content-Type': account.avatar_mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(Buffer.from(account.avatar_data));
        } else if (route === '/api/auth/recover' && req.method === 'POST') {
          rateLimit(req, 'recover', 5);
          if (!mail) throw new AccountError(503, '邮件服务尚未配置');
          const account = store.byEmail(emailAddress((await readJson(req)).email));
          if (account) await sendToken(account, 'reset');
          reply(res, { ok: true });
        } else if (route === '/api/auth/reset' && req.method === 'POST') {
          rateLimit(req, 'reset', 10);
          const input = await readJson(req), hash = await passwordHash(input.password), token = store.consumeToken(input.token, 'reset');
          store.resetPassword(token.accountId, hash); setCookie(res, 'hg_account_session', '', 0); reply(res, { ok: true });
        } else if (route === '/api/auth/verification' && req.method === 'POST') {
          rateLimit(req, 'verification', 5); await sendToken(requireViewer(req), 'verify'); reply(res, { ok: true });
        } else if (route === '/api/auth/verify' && req.method === 'POST') {
          const token = store.consumeToken((await readJson(req)).token, 'verify'); store.verifyEmail(token.accountId); reply(res, { ok: true });
        } else if (route === '/api/auth/google/start' && req.method === 'GET') {
          rateLimit(req, 'google', 300);
          if (!oauth) throw new AccountError(503, 'Google登录尚未配置');
          const linking = url.searchParams.get('link') === '1', account = linking ? requireViewer(req) : null;
          const nonce = secret(), codeVerifier = secret(), state = store.token('google', account?.id || null, { nonce, codeVerifier, returnTo: safeAccountReturn(url.searchParams.get('returnTo'),origin) }, 600000);
          setCookie(res, 'hg_google_state', state, 600);
          res.writeHead(302, { Location: oauth.generateAuthUrl({ scope: ['openid', 'email', 'profile'], state, nonce, code_challenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256' }), 'Cache-Control': 'no-store' }); res.end();
        } else if (route === '/api/auth/google/callback' && req.method === 'GET') {
          if (!oauth) throw new AccountError(503, 'Google登录尚未配置');
          const state = url.searchParams.get('state');
          if (!state || digest(state) !== digest(cookies(req).hg_google_state || '')) throw new AccountError(403, 'Google登录验证失败，请重试');
          const token = store.consumeToken(state, 'google');
          callbackReturn = safeAccountReturn(token.payload.returnTo, origin);
          if (!url.searchParams.get('code')) throw new AccountError(400, 'Google登录已取消');
          const { tokens } = await oauth.getToken({ code: url.searchParams.get('code'), codeVerifier: token.payload.codeVerifier });
          const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: config.GOOGLE_CLIENT_ID });
          const payload = ticket.getPayload();
          if (!payload?.sub || !payload.email_verified || payload.nonce !== token.payload.nonce) throw new AccountError(403, 'Google登录验证失败，请重试');
          let account = store.googleAccount(payload.sub);
          if (token.accountId) {
            const current = requireViewer(req);
            if (current.id !== token.accountId || current.email !== emailAddress(payload.email)) throw new AccountError(403, '请选择与账户邮箱一致的Google账号');
            store.linkGoogle(current.id, payload.sub); account = store.byId(current.id);
          } else if (!account) account = store.create({ email: payload.email, name: payload.name || payload.email.split('@')[0], googleSub: payload.sub, avatar: typeof payload.picture === 'string' && /^https:\/\/[^/]+\.googleusercontent\.com\//.test(payload.picture) ? payload.picture : null, verified: true });
          store.logout(cookies(req).hg_account_session); setCookie(res, 'hg_account_session', store.session(account.id), 2592000);
          res.writeHead(302, { Location: `${origin}${callbackReturn}`, 'Cache-Control': 'no-store' }); res.end();
        } else if (route === '/api/billing/checkout' && req.method === 'POST') { const input=await readJson(req), result=await billing.checkout(requireViewer(req),input.planId,input.returnTo); req.revalidateAccess?.(); reply(res,result); }
        else if (route === '/api/billing/portal' && req.method === 'POST') { const result=await billing.portal(requireViewer(req),(await readJson(req)).returnTo); req.revalidateAccess?.(); reply(res,result); }
        else if (route === '/api/billing/confirm' && req.method === 'POST') { await billing.confirm(requireViewer(req), (await readJson(req)).sessionId); req.revalidateAccess?.(); reply(res, { ok: true }); }
        else throw new AccountError(404, '页面不存在');
      } catch (error) {
        if (url.pathname === '/api/auth/google/callback') {
          const destination = new URL(callbackReturn,origin); destination.searchParams.set('account','login'); destination.searchParams.set('error',error instanceof AccountError ? error.message : 'Google登录验证失败，请重试');
          res.writeHead(302, { Location: destination.href, 'Cache-Control': 'no-store' }); res.end();
        } else reply(res, { error: error instanceof AccountError ? error.message : '账户服务暂不可用，请稍后重试' }, error instanceof AccountError ? error.status : 503);
      }
      return true;
    },
  };
}
