import { AccountError } from './account-store.mjs';
import { AuthenticationLimits } from './auth-limits.mjs';
import { readJson } from '../shared/http-json.mjs';

export function createTeamService(team, accounts, config = process.env) {
  const rates = new AuthenticationLimits(config);
  const secure = new URL(config.APP_ORIGIN || `http://127.0.0.1:${config.PORT || 8788}`).protocol === 'https:';
  const reply = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const setCookie = (res, token, verified = false) => res.setHeader('Set-Cookie', `drama_team_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? verified ? 28800 : 600 : 0}${secure ? '; Secure' : ''}`);
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/team/')) return false;
    accounts.sameOrigin(req);
    const route = url.pathname;
    if (route === '/api/team/session' && req.method === 'GET') {
      const member = team.viewer(req, false);
      reply(res, { initialized: team.initialized(), bootstrapAvailable: !team.initialized() && String(config.TEAM_BOOTSTRAP_TOKEN || '').length >= 32,
        member: member ? team.publicMember(member) : null, verified: !!member?.verified,
        mfaEnabled: !!member && !!team.db.prepare('SELECT 1 FROM team_mfa WHERE member_id=?').get(member.id) }); return true;
    }
    if (req.method === 'POST') {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AccountError(415, '请求格式无效');
      rates.request(req, 'team', 90);
    }
    const input = async () => {
      try { const data=await readJson(req);req.revalidateAccess?.();if(/^\/api\/team\/(members|invites)(\/|$)/.test(route))team.business?.writable();return data; } catch (error) { throw new AccountError(error.status || 400, error.status === 408 ? '请求读取超时，请稍后重试' : error instanceof AccountError ? error.message : '请求格式无效'); }
    };
    if (['/api/team/bootstrap', '/api/team/join', '/api/team/login', '/api/team/recover', '/api/team/mfa/verify', '/api/team/mfa/enable'].includes(route) && req.method === 'POST') {
      const data = await input(), scope = route === '/api/team/login' || route === '/api/team/recover' ? `team:${String(data.code || '').slice(0, 80).toUpperCase()}` : route;
      rates.checkLogin(req, scope);
      try {
        if (route === '/api/team/mfa/verify') { const token = team.verify(req, data.code); setCookie(res, token, true); reply(res, { ok: true }); }
        else if (route === '/api/team/mfa/enable') { const result = team.enable(req, data); setCookie(res, result.token, true); reply(res, { recoveryCodes: result.recoveryCodes }); }
        else {
          const member = route === '/api/team/bootstrap' ? await team.bootstrap(data.token, data.password)
            : route === '/api/team/join' ? await team.join(data.token, data.password)
            : route === '/api/team/recover' ? await team.recover(data.code, data.recoveryCode, data.password) : await team.login(data.code, data.password);
          if (route === '/api/team/login') team.logout(req);
          setCookie(res, team.session(member)); reply(res, { member: team.publicMember(member) });
        }
        rates.successfulLogin(req, scope);
      } catch (error) { if ([400, 401, 403].includes(error.status)) rates.failedLogin(req, scope); throw error; }
      return true;
    }
    if (route === '/api/team/logout' && req.method === 'POST') { await input(); team.logout(req); setCookie(res, ''); reply(res, { ok: true }); return true; }
    if (route === '/api/team/mfa/setup' && req.method === 'POST') { await input(); reply(res, team.setup(req)); return true; }
    if (route === '/api/team/sessions/revoke' && req.method === 'POST') {
      await input(); const member = team.require(req);
      team.transaction(() => { team.db.prepare('DELETE FROM team_sessions WHERE member_id=?').run(member.id); team.event(member, '退出全部团队会话', member.id); });
      setCookie(res, ''); reply(res, { ok: true }); return true;
    }
    const owner = team.require(req, 'owner');
    const business=team.business;
    if(route==='/api/team/maintenance/preview'&&req.method==='GET'){reply(res,business.preview());return true;}
    if(route.startsWith('/api/team/maintenance/')&&req.method==='POST') {
      const data=await input();team.require(req,'owner');
      const action=route.split('/').at(-1);
      const result=action==='pause'?business.pause(owner):action==='resume'?business.resume(owner):action==='migrate'?await business.migrate(owner,data,()=>{req.revalidateAccess?.();team.require(req,'owner');}):action==='restore'?business.restore(owner,data.id):null;
      if(!result)throw new AccountError(404,'团队接口不存在');reply(res,result);return true;
    }
    if(req.method==='POST')business?.writable();
    if (route === '/api/team/members' && req.method === 'GET') {
      const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
      const query=(url.searchParams.get('q')||'').trim().slice(0,80);
      const items = team.db.prepare('SELECT * FROM team_members WHERE (?=\'\' OR code LIKE ?) ORDER BY created_at,id LIMIT 101 OFFSET ?').all(query,`%${query}%`,(Math.floor(page) - 1) * 100);
      reply(res, { items: items.slice(0, 100).map(member => team.publicMember(member)), hasMore: items.length > 100 });
    } else if (route === '/api/team/series' && req.method === 'GET') reply(res, { items: team.content.list({ preview: true, query: url.searchParams.get('q') || '', page: url.searchParams.get('page') }) });
    else if (route === '/api/team/invites' && req.method === 'GET') reply(res, { items: team.db.prepare('SELECT id,roles,series_ids,expires_at FROM team_invites WHERE used_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 100').all(Date.now()).map(row => ({ id: row.id, roles: JSON.parse(row.roles), seriesIds: JSON.parse(row.series_ids), expiresAt: row.expires_at })) });
    else if (route === '/api/team/invites' && req.method === 'POST') reply(res, team.invite(req, await input()));
    else if (/^\/api\/team\/members\/[a-f0-9-]{36}$/.test(route) && req.method === 'POST') reply(res, team.update(req, route.split('/').at(-1), await input()));
    else if (/^\/api\/team\/invites\/[a-f0-9-]{36}\/revoke$/.test(route) && req.method === 'POST') {
      await input(); const id = route.split('/').at(-2);
      team.transaction(() => { team.db.prepare('DELETE FROM team_invites WHERE id=? AND used_at IS NULL').run(id); team.event(owner, '撤销团队邀请', id); }); reply(res, { ok: true });
    } else if (route === '/api/team/events' && req.method === 'GET') {
      const page = Math.max(1, Math.min(1000, Math.floor(Number(url.searchParams.get('page')) || 1)));
      const rows = team.db.prepare('SELECT e.*,m.code FROM team_events e JOIN team_members m ON m.id=e.member_id ORDER BY e.created_at DESC,e.rowid DESC LIMIT 101 OFFSET ?').all((page - 1) * 100);
      reply(res, { items: rows.slice(0, 100).map(row => ({ id: row.id, code: row.code, action: row.action, targetId: row.target_id, detail: JSON.parse(row.detail), createdAt: row.created_at })), hasMore: rows.length > 100 });
    } else throw new AccountError(404, '团队接口不存在');
    return true;
  };
}
