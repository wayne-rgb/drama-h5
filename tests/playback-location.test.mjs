import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web-pc/package.json", import.meta.url));
const ts = require("typescript");
const source = fs.readFileSync(new URL("../apps/web-pc/src/playback-location.ts", import.meta.url), "utf8");
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports, URL });
const { readPlaybackLocation, playbackLocation } = exports;

test("刷新播放地址保留大整数标识，不发生数值精度损失", () => {
  const href = playbackLocation("https://example.com/", "7527125460430375961", "7527274085433232446");
  const location = readPlaybackLocation(href);
  assert.equal(location.seriesId, "7527125460430375961");
  assert.equal(location.episodeId, "7527274085433232446");
});

test("退出播放只移除播放标识，保留其他参数与锚点", () => {
  const href = "https://example.com/?campaign=summer&series=123&episode=456#main";
  assert.equal(playbackLocation(href), "https://example.com/?campaign=summer#main");
  assert.equal(playbackLocation(href, "789", "101"), "https://example.com/?campaign=summer&series=789&episode=101#main");
});

test("无效标识不用于打开剧集，也不写入播放地址", () => {
  const location = readPlaybackLocation("https://example.com/?series=NaN&episode=-123");
  assert.equal(location.seriesId, "");
  assert.equal(location.episodeId, "");
  assert.equal(playbackLocation("https://example.com/?series=123&episode=456", "bad", "456"), "https://example.com/");
  assert.equal(playbackLocation("https://example.com/", "123", "bad"), "https://example.com/?series=123");
});
