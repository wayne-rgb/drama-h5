import axios from "axios";
import { flushPersonalLibrary, getSettings } from "./api";
import { previewHeaders } from './team-preview';

export type Membership = { active: boolean; status: string; planId: string | null; periodEnd: number | null; cancelAtPeriodEnd: boolean; billingSubscription?: { status: string; planId: string; periodEnd: number; cancelAtPeriodEnd: boolean } | null };
export type Account = { id: string; name: string; email: string; creator?: boolean; emailVerified: boolean; googleLinked: boolean; avatarUrl: string | null; membership: Membership };
export type AccountSession = { user: Account | null; libraryOwner?: string; capabilities: { google: boolean; email: boolean; billing: boolean; billingProvider: string | null; admin?: boolean; adminAccount?: boolean; adminMfaEnabled?: boolean; adminMfaRequired?: boolean; creator?: boolean }; plans: { id: string; currency: string; amount: number; interval: string }[]; siteUrl: string };
let sessionRequest: Promise<any> | null = null;

export async function accountRequest<T = any>(path: string, body?: unknown): Promise<T> {
  // 同一页面同时加载资料和登录状态时合并请求，避免首次进入签发两个不同游客身份。
  if(path==='/api/account/session'&&body===undefined) {
    if(sessionRequest)return sessionRequest;
    sessionRequest=requestAccount<T>(path).finally(()=>{sessionRequest=null;});return sessionRequest;
  }
  return requestAccount<T>(path,body);
}
async function requestAccount<T = any>(path: string, body?: unknown): Promise<T> {
  const base = window.location.protocol === "file:" ? getSettings().baseUrl : "";
  const response = await axios.request({ url: `${base}${path}`, method: body === undefined ? "GET" : "POST", data: body, headers: previewHeaders, withCredentials: window.location.protocol !== "file:", timeout: 20000 }).catch(error=>{
    if(error.response?.status===401 && /^\/api\/(admin\/|analytics\/(series|report))/.test(path))window.dispatchEvent(new Event('team-session-changed'));
    throw error;
  });
  return response.data;
}
export function accountError(error: any) { return error?.response?.data?.error || "账户服务暂不可用，请稍后重试"; }
export async function changeAccount(path: string, body: unknown, destination = '/?account=profile') {
  // 切换前尝试提交原账户的队列；失败时队列仍归原账户保留，不交给新账户。
  await flushPersonalLibrary().catch(() => {});
  await accountRequest(path, body);
  window.location.assign(destination);
}
