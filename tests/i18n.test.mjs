import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web-pc/package.json", import.meta.url));
const ts = require("typescript");
const localeSource = fs.readFileSync(new URL("../apps/web-pc/src/locales.ts", import.meta.url), "utf8");
const runtimeSource = fs.readFileSync(new URL("../apps/web-pc/src/i18n.ts", import.meta.url), "utf8");
const languageKey = "drama_h5_language_v1";

// 仅隔离浏览器存储和文档环境，加载实际翻译模块，不使用替代业务实现。
function loadRuntime(saved, blocked = false) {
  const storage = new Map(saved ? [[languageKey, saved]] : []);
  const listeners = new Map();
  const document = { documentElement: {}, title: "" };
  const environment = {
    Intl, document,
    localStorage: {
      getItem(key) { if (blocked) throw new Error("存储不可用"); return storage.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new Error("存储不可用"); storage.set(key, value); },
    },
    window: { addEventListener(name, callback) { listeners.set(name, callback); } },
  };
  const evaluate = (source, dependencies = {}) => {
    const exports = {};
    const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(javascript, { ...environment, exports, require: name => dependencies[name] ?? require(name) });
    return exports;
  };
  const locales = evaluate(localeSource);
  const runtime = evaluate(runtimeSource, { "./locales": locales });
  return { ...runtime, ...locales, document, storage, listeners };
}

const plain = value => value.replace(/[\u2068\u2069]/g, "");
const placeholders = value => [...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort();

test("六种语言的翻译完整，动态插值字段一致", () => {
  const { messages, chineseMessages, languages } = loadRuntime();
  assert.equal(languages.length, 6);
  for (const [key, row] of Object.entries(messages)) {
    assert.equal(row.length, 5, key);
    for (const value of row) {
      assert.ok(value.trim(), key);
      assert.deepEqual(placeholders(value), placeholders(row[0]), key);
    }
    assert.deepEqual(placeholders(chineseMessages[key] ?? key), placeholders(row[0]), `中文：${key}`);
  }
});

test("未知语言回退英语，保存的语言在再次打开时恢复", () => {
  const runtime = loadRuntime("unsupported");
  assert.equal(runtime.document.documentElement.lang, "en-US");
  assert.equal(runtime.t("首页"), "Home");
  assert.equal(runtime.setLanguage("fr-CA"), true);
  const reopened = loadRuntime(runtime.storage.get(languageKey));
  assert.equal(reopened.document.documentElement.lang, "fr-CA");
  assert.equal(reopened.t("首页"), "Accueil");
  assert.equal(reopened.setLanguage("invalid"), false);
  assert.equal(reopened.t("首页"), "Accueil");
});

test("阿拉伯语切换阅读方向，返回英语时恢复方向与页面标题", () => {
  const runtime = loadRuntime();
  runtime.setLanguage("ar");
  assert.equal(runtime.document.documentElement.dir, "rtl");
  assert.equal(runtime.document.documentElement.lang, "ar");
  assert.equal(runtime.document.title, runtime.t("红果短剧"));
  runtime.setLanguage("en");
  assert.equal(runtime.document.documentElement.dir, "ltr");
  assert.equal(runtime.document.title, "Hongguo Drama");
});

test("真实元数据保留原文，集数和已知标签可翻译且不修改输入", () => {
  const runtime = loadRuntime();
  const tags = "爱情/都市/未收录题材";
  assert.equal(runtime.localizeLabel(tags), "Romance/Modern life/未收录题材");
  assert.equal(tags, "爱情/都市/未收录题材");
  assert.equal(runtime.localizeLabel("首辅娇娘"), "首辅娇娘");
  assert.equal(plain(runtime.localizeLabel("全69集")), "69 episodes");
  assert.equal(plain(runtime.localizeLabel("热播短剧 · 排名第1")), "Trending dramas·Rank 1");
  assert.equal(runtime.localizeLabel(undefined), "");
  assert.equal(plain(runtime.t("搜索结果", { query: "首辅" })), "Results for “首辅”");
  assert.equal(plain(runtime.t("共{{count}}集", { count: 1 })), "1 episode");
  runtime.setLanguage("ar");
  assert.equal(runtime.t("共{{count}}集", { count: 2 }), "حلقتان");
  assert.equal(plain(runtime.t("共{{count}}集", { count: 5 })), "5 حلقات");
});

test("存储不可用时仍能切换界面，并报告无法持久化", () => {
  const runtime = loadRuntime(undefined, true);
  assert.equal(runtime.t("首页"), "Home");
  assert.equal(runtime.setLanguage("es"), false);
  assert.equal(runtime.t("首页"), "Inicio");
  assert.equal(runtime.document.documentElement.lang, "es-419");
});

test("其他标签页的语言修改和已存在的错误提示随语言更新", () => {
  const runtime = loadRuntime();
  const error = "远程地址无效";
  runtime.storage.set(languageKey, "fr-CA");
  runtime.listeners.get("storage")({ key: languageKey });
  assert.equal(runtime.document.documentElement.lang, "fr-CA");
  assert.equal(runtime.localizeError(error), "Entrez une adresse valide pour le service distant.");
  assert.equal(runtime.localizeError("未知服务错误"), runtime.t("操作失败，请稍后重试"));
  runtime.storage.clear();
  runtime.listeners.get("storage")({ key: null });
  assert.equal(runtime.t("首页"), "Home");
});
