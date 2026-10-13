import { useSyncExternalStore } from "react";
import { messages, chineseMessages, pluralMessages } from "./locales";

export const languages = [
  { id: "en", name: "English", locale: "en-US", direction: "ltr" },
  { id: "es", name: "Español", locale: "es-419", direction: "ltr" },
  { id: "pt-BR", name: "Português (Brasil)", locale: "pt-BR", direction: "ltr" },
  { id: "ar", name: "العربية", locale: "ar", direction: "rtl" },
  { id: "fr-CA", name: "Français (Canada)", locale: "fr-CA", direction: "ltr" },
  { id: "zh-CN", name: "简体中文", locale: "zh-CN", direction: "ltr" },
] as const;

export type Language = typeof languages[number]["id"];
export type MessageKey = keyof typeof messages;
export type MessageValues = Record<string, string | number>;
export interface LocalizedMessage { key: string; values?: MessageValues }
const storageKey = "drama_h5_language_v1";
const subscribers = new Set<() => void>();

export function isLanguage(value: unknown): value is Language {
  return languages.some(language => language.id === value);
}

function readLanguage(): Language {
  try {
    const saved = localStorage.getItem(storageKey);
    return isLanguage(saved) ? saved : "en";
  } catch { return "en"; }
}

let currentLanguage = readLanguage();

export function translate(language: Language, key: string, values: MessageValues = {}): string {
  const row = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key as MessageKey] : undefined;
  const index = languages.findIndex(item => item.id === language);
  let text = !row ? key : language === "zh-CN" ? chineseMessages[key as MessageKey] || key : row[index] || row[0];
  if (values.count !== undefined && Number.isFinite(Number(values.count))) {
    const category = new Intl.PluralRules(language).select(Number(values.count));
    text = pluralMessages[key]?.[language]?.[category] || text;
  }
  return text.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => {
    const value = values[name];
    // 隔离插值中的数字和剧名方向，防止阿拉伯语与其他文字混排错位。
    return value === undefined ? placeholder : `\u2068${value}\u2069`;
  });
}

export function t(key: MessageKey, values?: MessageValues): string {
  return translate(currentLanguage, key, values);
}

// 服务返回的真实名称按已知标签翻译，未知名称保持原值，不伪造内容。
export function localizeLabel(value: string | undefined): string {
  if (!value) return "";
  const episode = value.match(/^第\s*(\d+)\s*集$/);
  if (episode) return t("第{{number}}集", { number: episode[1] });
  const season = value.match(/^第\s*(\d+)\s*季$/);
  if (season) return t("第{{number}}季", { number: season[1] });
  const count = value.match(/^(?:全|共)?\s*(\d+)\s*集$/);
  if (count) return t("共{{count}}集", { count: count[1] });
  return value.split(/([/·])/).map(part => {
    const trimmed = part.trim();
    const rank = trimmed.match(/^排名第\s*(\d+)$/);
    if (rank) return t("排名第{{number}}", { number: rank[1] });
    return Object.prototype.hasOwnProperty.call(messages, trimmed)
      ? translate(currentLanguage, trimmed) : part;
  }).join("");
}

export function localizeError(value: string): string {
  return translate(currentLanguage, Object.prototype.hasOwnProperty.call(messages, value)
    ? value : "操作失败，请稍后重试");
}

function updateDocument() {
  const language = languages.find(item => item.id === currentLanguage)!;
  document.documentElement.lang = language.locale;
  document.documentElement.dir = language.direction;
  document.title = t("红果短剧");
}

export function setLanguage(language: Language): boolean {
  if (!isLanguage(language)) return false;
  let saved = true;
  try { localStorage.setItem(storageKey, language); } catch { saved = false; }
  currentLanguage = language;
  updateDocument();
  subscribers.forEach(notify => notify());
  return saved;
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

export function formatDate(value: number | Date, options: Intl.DateTimeFormatOptions): string {
  const language = languages.find(item => item.id === currentLanguage)!;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language.locale, options).format(date) : t("最近");
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, () => currentLanguage, () => "en" as Language);
  // 翻译函数保持稳定，切换语言只更新界面，不重新启动播放或请求副作用。
  return { language, t, localizeLabel, localizeError, setLanguage, formatDate };
}

window.addEventListener("storage", event => {
  if (event.key !== storageKey && event.key !== null) return;
  currentLanguage = readLanguage();
  updateDocument();
  subscribers.forEach(notify => notify());
});
updateDocument();
