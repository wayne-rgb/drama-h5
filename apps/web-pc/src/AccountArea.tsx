import React, { useEffect, useRef, useState } from "react";
import {SessionList} from './AccountSecurity';
import { ArrowRight, Camera, Check, ChevronRight, Clock, Crown, Heart, ThumbsUp, LogOut, Mail, Settings, ShieldCheck, UserRound, X } from "lucide-react";
import { Account, AccountSession, accountError, accountRequest, changeAccount } from "./account";
import { languages, MessageKey, useI18n } from "./i18n";
import { HistoryItem } from "./types";
import { teamPreview } from './team-preview';
import { accountLinkToken, clearAccountLinkToken } from './account-link';

export type AccountPanel = "login" | "register" | "recover" | "reset" | "verify" | "profile" | "membership" | null;
export function useAccountSession() {
  const [session, setSession] = useState<AccountSession | null>(null);
  const [error, setError] = useState("");
  const confirmation = useRef<Promise<void> | null>(null);
  const refreshSequence = useRef(0);
  const refresh = async () => {
    if (teamPreview) return;
    const sequence = ++refreshSequence.current;
    let data: AccountSession | null = null;
    try {
      data = await accountRequest<AccountSession>("/api/account/session");
      const sessionId = new URLSearchParams(window.location.search).get("checkout");
      if (sessionId && data.user && data.capabilities.billing) {
        if (!confirmation.current) confirmation.current = accountRequest<void>("/api/billing/confirm", { sessionId });
        await confirmation.current;
        data = await accountRequest<AccountSession>("/api/account/session");
        const url = new URL(window.location.href); url.searchParams.delete("checkout"); window.history.replaceState(null, "", url);
      }
      if (sequence === refreshSequence.current) { setSession(data); setError(""); }
    } catch (error) { confirmation.current = null; if (sequence === refreshSequence.current) { if (data) setSession(data); setError(accountError(error)); } }
  };
  useEffect(() => { void refresh(); const visible = () => { if (!document.hidden) void refresh(); }; document.addEventListener("visibilitychange", visible); return () => document.removeEventListener("visibilitychange", visible); }, []);
  return { session, error, refresh };
}
type AreaProps = { session: AccountSession | null; onPanel: (panel: AccountPanel) => void; onOverview: () => void; onFavorites: () => void; onHistory: () => void; onLikes: () => void; onSettings: () => void; favoritesCount: number; historyCount: number; likesCount: number | null };
const needsSubscriptionManagement = (user?: Account | null) => {
  const subscription = user?.membership.billingSubscription || user?.membership;
  return !!subscription?.planId && subscription.planId !== 'manual' && !["none", "canceled", "incomplete_expired"].includes(subscription.status);
};

function Avatar({ user, large = false }: { user?: Account | null; large?: boolean }) {
  const { t } = useI18n();
  return <span className={`account-avatar${large ? " account-avatar-large" : ""}`}>{user?.avatarUrl ? <img src={user.avatarUrl} alt={t("头像")} /> : user ? <span>{Array.from(user.name)[0]?.toUpperCase()}</span> : <UserRound size={large ? 30 : 21} />}</span>;
}
function VipBadge({ active, guest = false }: { active: boolean; guest?: boolean }) { const { t } = useI18n(); return <span className={`account-vip-badge${active ? " is-vip" : ""}`}>{!guest && <Crown size={12} />}{t(guest ? "游客模式" : active ? "VIP会员" : "普通账户")}</span>; }

export function AccountMenu(props: AreaProps) {
  const { t, localizeError } = useI18n();
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(""), [signingOut, setSigningOut] = useState(false);
  const user = props.session?.user;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const select = (action: () => void) => { setOpen(false); action(); };
  return <div className="account-menu" ref={root}>
    <button className="account-menu-trigger" aria-label={t("用户中心")} aria-expanded={open} onClick={() => setOpen(value => !value)}><Avatar user={user} /><span><strong>{user?.name || t("未登录")}</strong><VipBadge active={!!user?.membership.active} guest={!user} /></span><ChevronRight size={15} /></button>
    {open && <div className="account-menu-popover" role="region" aria-label={t("用户中心")}>
      <button className="account-menu-identity" onClick={() => select(() => user ? props.onOverview() : props.onPanel("login"))}><Avatar user={user} large /><span><strong>{user?.name || t("登录你的账户")}</strong><small dir="auto">{user?.email || t("登录后保存个人追剧与观看记录")}</small></span><ChevronRight size={16} /></button>
      <button className="account-menu-membership" onClick={() => select(() => props.onPanel("membership"))}><Crown size={19} /><span><strong>{t(user?.membership.active ? "VIP会员" : "会员订阅")}</strong><small>{t(needsSubscriptionManagement(user) ? "管理订阅与续费" : "查看月付与年付套餐")}</small></span><ChevronRight size={16} /></button>
      <div className="account-menu-links"><button onClick={() => select(props.onFavorites)}><Heart size={18} /><span>{t("我的追剧")}</span><small>{props.favoritesCount}</small></button><button onClick={() => select(props.onHistory)}><Clock size={18} /><span>{t("观看历史")}</span><small>{props.historyCount}</small></button></div>
      <button className="account-menu-setting" onClick={() => select(props.onLikes)}><ThumbsUp size={18}/>{t('我的点赞')}<small className="ms-auto">{props.likesCount ?? '—'}</small></button>
      <button className="account-menu-setting" onClick={() => select(props.onSettings)}><Settings size={18} />{t("设置")}<ChevronRight size={16} /></button>
      {(props.session?.capabilities.adminAccount || props.session?.capabilities.admin) && <a className="account-menu-setting" href="/admin"><ShieldCheck size={18}/>{t('内容后台')}<ChevronRight size={16}/></a>}
      {props.session?.capabilities.creator && <a className="account-menu-setting" href="/creator"><ShieldCheck size={18}/>{t('创作者工作台')}<ChevronRight size={16}/></a>}
      {error && <div role="alert" className="account-error">{localizeError(error)}</div>}
      {user && <button className="account-menu-setting" disabled={signingOut} onClick={() => { setSigningOut(true); setError(""); void changeAccount("/api/auth/logout", {}).catch(error => setError(accountError(error))).finally(() => setSigningOut(false)); }}><LogOut size={18} />{t("退出登录")}</button>}
    </div>}
  </div>;
}

export function AccountHome(props: AreaProps & { histories: HistoryItem[]; onResume: (history: HistoryItem) => void; error: string; onRetry: () => void; profileOnly?: boolean }) {
  const { t, localizeError, formatDate } = useI18n();
  const user = props.session?.user, membership = user?.membership;
  if (!props.session) return props.error ? <div role="alert" className="account-error">{localizeError(props.error)} <button onClick={props.onRetry}>{t("重试")}</button></div> : <p role="status">{t("账户加载中...")}</p>;
  return <div className="account-home">
    {props.error && <div role="alert" className="account-error">{localizeError(props.error)} <button onClick={props.onRetry}>{t("重试")}</button></div>}
    <div className="account-home-top">
      <div className="account-profile-card"><button className="account-profile-identity" onClick={() => props.onPanel(user ? "profile" : "login")}><Avatar user={user} large /><span><strong>{user?.name || t("登录你的账户")}</strong><small dir="auto">{user?.email || t("登录后保存个人追剧与观看记录")}</small><VipBadge active={!!membership?.active} guest={!user} /></span><ChevronRight size={18} /></button>{user && !user.emailVerified && <button className="account-email-note" onClick={() => props.onPanel("profile")}><Mail size={14} />{t("邮箱尚未验证")}</button>}</div>
      <button className="account-membership-card" onClick={() => props.onPanel("membership")}><div><span className="account-membership-symbol"><Crown size={24} /></span><span><strong>{t(membership?.active ? "VIP会员" : "会员订阅")}</strong><small>{membership?.active && membership.periodEnd ? t(membership.cancelAtPeriodEnd ? "会员有效至{{date}}" : "下次续费：{{date}}", { date: formatDate(membership.periodEnd, { year: "numeric", month: "short", day: "numeric" }) }) : t("月付或年付，自主管理订阅")}</small></span></div><span className="account-membership-link">{t(needsSubscriptionManagement(user) ? "管理订阅" : "查看套餐")}<ArrowRight size={16} /></span></button>
    </div>
    {!props.profileOnly && <div className="account-quick-links"><button onClick={props.onFavorites}><Heart size={21} /><strong>{props.favoritesCount}</strong><span>{t("我的追剧")}</span></button><button onClick={props.onHistory}><Clock size={21} /><strong>{props.historyCount}</strong><span>{t("观看历史")}</span></button><button onClick={props.onLikes}><ThumbsUp size={21} /><strong>{props.likesCount ?? '—'}</strong><span>{t("我的点赞")}</span></button></div>}
    {!props.profileOnly && props.histories.length > 0 && <section className="account-continue"><div className="account-section-heading"><h3>{t("继续观看")}</h3><button onClick={props.onHistory}>{t("查看全部")}<ChevronRight size={14} /></button></div><div className="account-continue-list">{props.histories.slice(0, 3).map(item => <button key={item.seriesId} onClick={() => props.onResume(item)}><img src={item.cover} alt={item.title} /><span><strong dir="auto">{item.title}</strong><small>{t("看到第{{number}}集", { number: item.episodeNumber || 1 })}</small><span className="account-progress-track"><span style={{ width: `${item.duration && item.duration > 0 ? Math.min(100, item.position / item.duration * 100) : 0}%` }} /></span></span><ArrowRight size={17} /></button>)}</div></section>}
  </div>;
}

export function AccountDialogs({ panel: requestedPanel, onPanel, session, sessionError, onRefresh, playbackReturn }: { panel: AccountPanel; onPanel: (panel: AccountPanel) => void; session: AccountSession | null; sessionError: string; onRefresh: () => Promise<void>; playbackReturn?: { seriesId: string; episodeId: string } }) {
  const { t, localizeError, formatDate, language } = useI18n();
  const panel = requestedPanel === "profile" && session && !session.user ? "login" : requestedPanel;
  const dialog = useRef<HTMLDialogElement>(null), file = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [name, setName] = useState(""), [avatar, setAvatar] = useState<string | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState<MessageKey | "">(""), [busy, setBusy] = useState(false), [planId, setPlanId] = useState(() => new URLSearchParams(window.location.search).get('plan') === 'monthly' ? 'monthly' : 'annual');
  const returnToMembership = useRef(['monthly','annual'].includes(new URLSearchParams(window.location.search).get('plan') || ''));
  const user = session?.user, capabilities = session?.capabilities;
  const manageSubscription = needsSubscriptionManagement(user);
  const subscription = manageSubscription ? user?.membership.billingSubscription || user?.membership : user?.membership;
  useEffect(() => { if (panel !== 'reset' && panel !== 'verify') clearAccountLinkToken(); }, [panel]);
  useEffect(() => {
    setError(new URLSearchParams(window.location.search).get("error")?.slice(0, 512) || ""); setNotice(""); setPassword(""); setAvatar(null); setName(current => user?.name ?? current); setEmail(current => user?.email ?? current);
    if (panel && !dialog.current?.open) dialog.current?.showModal();
    if (!panel && dialog.current?.open) dialog.current.close();
    if (!panel) returnToMembership.current = false;
  }, [panel, user?.id]);
  const returnTarget = () => {
    const current = new URL(window.location.href), target = new URL('/',window.location.href);
    const series=playbackReturn?.seriesId || current.searchParams.get('series'),episode=playbackReturn?.episodeId || current.searchParams.get('episode');
    if (/^\d{1,40}$/.test(series || '')) { target.searchParams.set('series',series!); if (/^\d{1,40}$/.test(episode || '')) target.searchParams.set('episode',episode!); }
    if(returnToMembership.current){target.searchParams.set('account','membership');target.searchParams.set('plan',planId);}
    else if(!target.searchParams.has('series'))target.searchParams.set('account','profile');
    return `${target.pathname}${target.search}`;
  };
  const perform = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); setNotice(""); try { await action(); } catch (error) { setError(accountError(error)); } finally { setBusy(false); } };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      if (panel === "login" || panel === "register") await changeAccount(`/api/auth/${panel}`, { email, password, ...(panel === "register" ? { name } : {}) },returnTarget());
      else if (panel === "profile") { await accountRequest("/api/account/profile", { name, ...(avatar ? { avatar: avatar.split(",")[1] } : {}) }); setAvatar(null); await onRefresh(); setNotice("资料已保存"); }
      else if (panel === "recover") { await accountRequest("/api/auth/recover", { email }); setNotice("如邮箱已注册，你会收到找回密码邮件"); }
      else if (panel === "reset") { await accountRequest("/api/auth/reset", { password, token: accountLinkToken('reset') }); clearAccountLinkToken(); window.location.assign("/?account=login"); }
    });
  };
  const chooseAvatar = async (selected?: File) => {
    if (!selected) return;
    if (selected.size > 1048576 || !["image/jpeg", "image/png", "image/webp"].includes(selected.type)) { setError("头像需为1MB以内的JPEG、PNG或WebP图片"); return; }
    const reader = new FileReader(); reader.onload = () => setAvatar(String(reader.result)); reader.onerror = () => setError("头像读取失败，请重试"); reader.readAsDataURL(selected);
  };
  const title = panel === "register" ? "创建账户" : panel === "profile" ? "账户资料" : panel === "membership" ? "会员订阅" : panel === "recover" ? "找回密码" : panel === "reset" ? "设置新密码" : panel === "verify" ? "验证邮箱" : "登录你的账户";
  const currency = (amount: number, currency: string) => new Intl.NumberFormat(languages.find(item => item.id === language)?.locale || "en-US", { style: "currency", currency }).format(amount / 100);
  return <dialog ref={dialog} className="account-dialog" aria-label={t(title)} onCancel={event => { event.preventDefault(); if (!busy) onPanel(null); }} onClick={event => { if (event.target !== event.currentTarget || busy) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onPanel(null); }}>
    <div className="account-dialog-heading"><strong>{t(title)}</strong><button disabled={busy} aria-label={t("关闭")} onClick={() => onPanel(null)}><X size={21} /></button></div>
    <div className="account-dialog-body">
      {(error || sessionError) && <div role="alert" className="account-error">{localizeError(error || sessionError)}</div>}{notice && <div role="status" className="account-notice">{t(notice)}</div>}
      {!session ? <p role="status">{t("账户加载中...")}<button className="account-text-button" onClick={() => void onRefresh()}>{t("重试")}</button></p> : window.location.protocol === "file:" ? <><p>{t("请在浏览器中完成账户与订阅操作")}</p><a className="account-primary account-text-button" href={session.siteUrl} target="_blank" rel="noopener noreferrer">{t("打开网页")}</a></> : panel === "membership" ? <>
        <div className="account-subscription-heading"><Crown size={35} /><h3>{t(user?.membership.active ? "VIP会员" : "选择会员套餐")}</h3><p>{t("按所选周期自动续费，可随时管理续费")}</p></div>
        {subscription && ["past_due", "unpaid", "incomplete"].includes(subscription.status) && <p className="account-subscription-status">{t("会员付款待处理，请管理订阅")}</p>}
        {subscription?.periodEnd && <p className="account-subscription-status">{t(!['active','trialing'].includes(subscription.status) || subscription.cancelAtPeriodEnd ? "会员有效至{{date}}" : "下次续费：{{date}}", { date: formatDate(subscription.periodEnd, { year: "numeric", month: "short", day: "numeric" }) })}</p>}
        {!manageSubscription && <div className="account-plan-list">{session?.plans.map(plan => <button key={plan.id} aria-pressed={planId === plan.id} className={planId === plan.id ? "selected" : ""} onClick={() => setPlanId(plan.id)}><span><strong>{t(plan.interval === "month" ? "月付会员" : "年付会员")}</strong><small>{t(plan.interval === "month" ? "每月自动续费" : "每年自动续费")}</small></span><span><strong>{currency(plan.amount, plan.currency)}</strong><small>{t(plan.interval === "month" ? "每月" : "每年")}</small></span>{planId === plan.id && <Check size={17} />}</button>)}</div>}
        {!capabilities?.billing && <p className="account-service-note">{t("订阅支付尚未配置")}</p>}
        <button className="account-primary" disabled={busy || !!user && (!capabilities?.billing || !user.emailVerified)} onClick={() => { if (!user) { returnToMembership.current=true; onPanel("login"); return; } void perform(async () => { const result = await accountRequest<{ url: string }>(manageSubscription ? "/api/billing/portal" : "/api/billing/checkout", manageSubscription ? { returnTo:returnTarget() } : { planId,returnTo:returnTarget() }); window.location.assign(result.url); }); }}>{t(manageSubscription ? "管理订阅" : user ? "订阅会员" : "登录后订阅")}</button>
        {user && !user.emailVerified && <button className="account-text-button" onClick={() => onPanel("profile")}>{t("请先验证邮箱")}<ChevronRight size={15} /></button>}
      </> : panel === "verify" ? <><ShieldCheck size={36} /><p>{t("确认邮箱验证后，链接将失效")}</p><button className="account-primary" disabled={busy} onClick={() => void perform(async () => { await accountRequest("/api/auth/verify", { token: accountLinkToken('verify') }); clearAccountLinkToken(); await onRefresh(); setNotice("邮箱验证成功"); })}>{t("验证邮箱")}</button></> : <form onSubmit={submit}>
        {panel === "profile" ? <>
          <div className="account-profile-avatar">
            {avatar ? <span className="account-avatar account-avatar-large"><img src={avatar} alt={t("头像")} /></span> : <Avatar user={user} large />}
            <button type="button" onClick={() => file.current?.click()}><Camera size={16} />{t(avatar ? "头像已选择，保存后生效" : "更换头像")}</button>
            <input hidden type="file" ref={file} accept="image/png,image/jpeg,image/webp" onChange={event => void chooseAvatar(event.target.files?.[0])} />
          </div>
          <label>{t("昵称")}<input autoComplete="nickname" required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
          <label>{t("邮箱")}<input type="email" value={user?.email || ""} readOnly /></label>
          {!user?.emailVerified && <div className="account-verification"><span>{t("邮箱尚未验证")}</span><button type="button" disabled={busy || !capabilities?.email} onClick={() => void perform(async () => { await accountRequest("/api/auth/verification", {}); setNotice("验证邮件已发送，请检查邮箱"); })}>{t("发送验证邮件")}</button></div>}
          {!capabilities?.email && <p className="account-service-note">{t("邮件服务尚未配置")}</p>}
          <button className="account-primary" type="submit" disabled={busy}>{t("保存资料")}</button>
          {capabilities?.adminAccount&&!capabilities.admin&&<a className="account-text-button" href="/admin">{t('管理员二次验证')}</a>}
          <button type="button" className="account-google" disabled={!capabilities?.google || busy || user?.googleLinked || !!capabilities?.adminAccount && !!capabilities.adminMfaEnabled && !capabilities.admin} onClick={() => window.location.assign("/api/auth/google/start?link=1")}>{t(user?.googleLinked ? "Google已绑定" : "绑定Google账号")}</button>
          <button type="button" className="account-text-button" onClick={() => void perform(() => changeAccount("/api/auth/logout", {}))}><LogOut size={16} />{t("退出登录")}</button>
          <SessionList/>
        </> : <>
          {panel === "register" && <label>{t("昵称")}<input required autoComplete="nickname" maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>}
          {panel !== "reset" && <label>{t("邮箱")}<input type="email" required autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} /></label>}
          {panel !== "recover" && <label>{t("密码")}<input type="password" aria-label={t("密码")} aria-describedby={panel === "login" ? undefined : "account-password-rule"} required minLength={panel === "login" ? undefined : 12} maxLength={256} autoComplete={panel === "login" ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} />{panel !== "login" && <small id="account-password-rule">{t("至少12个字符")}</small>}</label>}
          {panel === "recover" && !capabilities?.email && <p className="account-service-note">{t("邮件服务尚未配置")}</p>}
          <button className="account-primary" disabled={busy || panel === "recover" && !capabilities?.email} type="submit">{t(busy ? "处理中..." : panel === "register" ? "创建账户" : panel === "recover" ? "发送找回邮件" : panel === "reset" ? "保存新密码" : "登录")}</button>
          {(panel === "login" || panel === "register") && <><div className="account-auth-divider"><span>{t("或")}</span></div><button type="button" className="account-google" disabled={busy || !capabilities?.google} onClick={() => window.location.assign(`/api/auth/google/start?returnTo=${encodeURIComponent(returnTarget())}`)}><span className="account-google-mark">G</span>{t("使用Google登录")}</button>{!capabilities?.google && <p className="account-service-note">{t("Google登录尚未配置")}</p>}<button className="account-text-button" type="button" onClick={() => onPanel(panel === "login" ? "register" : "login")}>{t(panel === "login" ? "还没有账户？创建账户" : "已有账户？登录")}</button>{panel === "login" && <button className="account-text-button" type="button" onClick={() => onPanel("recover")}>{t("忘记密码")}</button>}</>}
        </>}
      </form>}
    </div>
  </dialog>;
}
