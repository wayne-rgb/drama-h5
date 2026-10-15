import { AccountError } from './account-store.mjs';
import { isAdministrator, isAdministratorAccount } from './account-role.mjs';

// 每条对外路由都声明方法及身份边界；对象归属和VIP仍由业务处理器校验真实数据。
const rules = [
  [/^\/api\/team\/session$/, ['GET'], 'team-session'],
  [/^\/api\/team\/(bootstrap|join|login|recover|logout|mfa\/(setup|enable|verify)|sessions\/revoke)$/, ['POST'], 'team-session'],
  [/^\/api\/team\/(members|series|events)$/, ['GET'], 'team-owner'],
  [/^\/api\/team\/invites$/, ['GET','POST'], 'team-owner'],
  [/^\/api\/team\/members\/[a-f0-9-]{36}$/, ['POST'], 'team-owner'],
  [/^\/api\/team\/invites\/[a-f0-9-]{36}\/revoke$/, ['POST'], 'team-owner'],
  [/^\/api\/(banners|sections|home|search|ranks|category\/(tags|list)|rank\/(types|list|page))$/, ['GET','HEAD'], 'public'],
  [/^\/api\/series\/\d{1,40}(?:\/(related|recommend))?$/, ['GET','HEAD'], 'public'],
  [/^\/api\/episodes\/\d{1,40}\/(qualities|play|stream)$/, ['GET','HEAD'], 'public'],
  [/^\/api\/episodes\/\d{1,40}\/hls\/[a-f0-9-]{36}\/(?:master\.m3u8|r\d{2,4}\.m3u8|s\d{2,4}-\d{6}\.ts)$/, ['GET','HEAD'], 'public'],
  [/^\/api\/content\/covers\/[a-f0-9-]{36}$/, ['GET','HEAD'], 'public'],
  [/^\/api\/episodes\/\d{1,40}\/interactions$/, ['GET'], 'public'],
  [/^\/api\/episodes\/\d{1,40}\/comments$/, ['GET','POST'], 'comments'],
  [/^\/api\/episodes\/\d{1,40}\/likes$/, ['POST'], 'viewer'],
  [/^\/api\/comments\/[a-f0-9-]{36}$/, ['DELETE'], 'viewer'],
  [/^\/api\/comments\/[a-f0-9-]{36}\/report$/, ['POST'], 'viewer'],
  [/^\/api\/account\/session$/, ['GET'], 'public'],
  [/^\/api\/account\/profile$/, ['POST'], 'viewer'],
  [/^\/api\/account\/avatar$/, ['GET'], 'viewer'],
  [/^\/api\/account\/sessions$/, ['GET'], 'viewer'],
  [/^\/api\/account\/sessions\/revoke$/, ['POST'], 'viewer'],
  [/^\/api\/account\/mfa$/, ['GET'], 'admin-account'],
  [/^\/api\/account\/mfa\/(setup|enable|verify)$/, ['POST'], 'admin-account'],
  [/^\/api\/auth\/(register|login|recover|reset|verify)$/, ['POST'], 'public'],
  [/^\/api\/auth\/logout$/, ['POST'], 'public'],
  [/^\/api\/auth\/verification$/, ['POST'], 'viewer'],
  [/^\/api\/auth\/google\/(start|callback)$/, ['GET'], 'public'],
  [/^\/api\/billing\/(checkout|portal|confirm)$/, ['POST'], 'viewer'],
  [/^\/api\/billing\/webhook$/, ['POST'], 'notification'],
  [/^\/api\/me\/likes$/, ['GET'], 'viewer'],
  [/^\/api\/me\/likes\/\d{1,40}$/, ['POST'], 'viewer'],
  [/^\/api\/library$/, ['GET'], 'personal'],
  [/^\/api\/library\/sync$/, ['GET','POST'], 'personal'],
  [/^\/api\/library\/(operations|import)$/, ['POST'], 'personal'],
  [/^\/api\/history$/, ['GET','DELETE'], 'personal'],
  [/^\/api\/history\/(sessions|progress|import)$/, ['POST'], 'personal'],
  [/^\/api\/history\/[^/]+$/, ['GET','DELETE'], 'personal'],
  [/^\/api\/recommend$/, ['GET'], 'personal'],
  [/^\/api\/analytics\/(sessions|progress)$/, ['POST'], 'audience'],
  [/^\/api\/analytics\/(series|report)$/, ['GET'], 'creator'],
  [/^\/api\/admin\/(series|creators|uploads)$/, ['GET','POST'], 'admin'],
  [/^\/api\/admin\/(accounts|comment-series|comments|audit-series|audit)$/, ['GET'], 'admin'],
  [/^\/api\/admin\/membership$/, ['POST'], 'admin'],
  [/^\/api\/admin\/series\/\d{1,40}$/, ['GET','POST'], 'admin'],
  [/^\/api\/admin\/series\/\d{1,40}\/(episodes|publish|reorder|creator)$/, ['POST'], 'admin'],
  [/^\/api\/admin\/series\/\d{1,40}\/episodes\/\d{1,40}$/, ['DELETE'], 'admin'],
  [/^\/api\/admin\/uploads\/[a-f0-9-]{36}$/, ['GET','PUT','DELETE'], 'admin'],
  [/^\/api\/admin\/uploads\/[a-f0-9-]{36}\/hls\/retry$/, ['POST'], 'admin'],
  [/^\/api\/admin\/comments\/[a-f0-9-]{36}$/, ['POST'], 'admin'],
];

export function createApiPolicy(accounts, store, config = process.env, team) {
  return (req, res, url) => {
    const rule = rules.find(([pattern]) => pattern.test(url.pathname));
    if (!rule) throw new AccountError(404, '页面不存在');
    const [, methods, permission] = rule;
    if (req.method === 'OPTIONS') {
      const requested = req.headers['access-control-request-method'];
      if (requested && !methods.includes(requested)) throw new AccountError(405, '请求方式无效');
      if (!['public','comments'].includes(permission)) accounts.sameOrigin(req);
      res.setHeader('Access-Control-Allow-Origin', ['public','comments'].includes(permission) ? '*' : req.headers.origin || config.APP_ORIGIN || '');
      res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range, Content-Range, X-Library-Owner');
      res.setHeader('Vary', 'Origin');
      return;
    }
    if (!methods.includes(req.method)) { res.setHeader('Allow', methods.join(', ')); throw new AccountError(405, '请求方式无效'); }
    const check = () => {
      const writes = !['GET','HEAD'].includes(req.method);
      if (permission !== 'notification' && permission !== 'personal' && (writes || !['public','comments'].includes(permission))) accounts.sameOrigin(req);
      if (permission === 'team-session') return null;
      if (permission === 'team-owner') { if (!team) throw new AccountError(503, '团队服务暂不可用'); return team.require(req, 'owner'); }
      if (team && ['admin','creator'].includes(permission)) return team.authorize(req, url);
      if (permission === 'personal') return accounts.guardLibrary(req);
      if (permission === 'audience') {
        const user = team?.viewer(req) || accounts.audience(req);
        if (!user) throw new AccountError(401, '请刷新页面后重试');
        return user;
      }
      if (['viewer','admin','admin-account','creator'].includes(permission) || permission === 'comments' && writes) {
        const sensitive=/^\/api\/billing\/(checkout|portal|confirm)$/.test(url.pathname)||url.pathname==='/api/account/sessions/revoke';
        const user = sensitive ? accounts.requireSecurityViewer(req) : accounts.requireViewer(req);
        if (permission === 'admin' && !isAdministrator(user,config)) throw new AccountError(403, '需要管理员权限');
        if (permission === 'admin-account' && !isAdministratorAccount(user,config)) throw new AccountError(403,'需要管理员权限');
        if (permission === 'creator' && !isAdministrator(user,config) && !store.isCreator(user.id)) throw new AccountError(403, '需要创作者权限');
        return user;
      }
      return null;
    };
    const identity = check();
    if (identity || permission === 'personal') {
      // 正文读取和外部目录等待结束后，写入及私有响应都必须使用仍然有效的身份。
      req.revalidateAccess = () => {
        const current = check();
        if (identity ? !current || current.id !== identity.id || !!current.guest !== !!identity.guest : current !== null) throw new AccountError(409, '登录状态已变化，请刷新页面');
      };
    }
  };
}
