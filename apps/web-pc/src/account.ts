import axios from "axios";
import { flushPersonalLibrary, getSettings } from "./api";

export type Membership = { active: boolean; status: string; planId: string | null; periodEnd: number | null; cancelAtPeriodEnd: boolean; billingSubscription?: { status: string; planId: string; periodEnd: number; cancelAtPeriodEnd: boolean } | null };
export type Account = { id: string; name: string; email: string; emailVerified: boolean; googleLinked: boolean; avatarUrl: string | null; membership: Membership };
export type AccountSession = { user: Account | null; capabilities: { google: boolean; email: boolean; billing: boolean; billingProvider: string | null; admin?: boolean }; plans: { id: string; currency: string; amount: number; interval: string }[]; siteUrl: string };

export async function accountRequest<T = any>(path: string, body?: unknown): Promise<T> {
  const base = window.location.protocol === "file:" ? getSettings().baseUrl : "";
  const response = await axios.request({ url: `${base}${path}`, method: body === undefined ? "GET" : "POST", data: body, withCredentials: window.location.protocol !== "file:", timeout: 20000 });
  return response.data;
}
export function accountError(error: any) { return error?.response?.data?.error || "账户服务暂不可用，请稍后重试"; }
export async function changeAccount(path: string, body: unknown, destination = '/?account=profile') {
  // 切换前尝试提交原账户的队列；失败时队列仍归原账户保留，不交给新账户。
  await flushPersonalLibrary().catch(() => {});
  await accountRequest(path, body);
  window.location.assign(destination);
}
