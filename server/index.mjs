import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { HistoryStore } from "./history-store.mjs";
import { createHistoryHandler } from "./history-routes.mjs";
import { provider as coreProvider } from "../shared/content-provider.mjs";
import { LibraryStore } from "../shared/library-store.mjs";
import { LibrarySync } from "./library-sync.mjs";
import { createLibraryHandler } from "./library-routes.mjs";
import { RecommendationService, RecommendationError } from "./recommendation-service.mjs";
import { AccountStore, AccountError } from "./account-store.mjs";
import { createAccountService } from "./account-routes.mjs";
import { createContentService } from "./content-service.mjs";
import { publicFailure } from "./http-error.mjs";
import { CatalogCache } from './catalog-cache.mjs';
import { PlaybackGuard } from './playback-guard.mjs';
import { createContentClient, withContentSignal, ContentCache } from '../shared/content-request.mjs';
import { protectRequestBody } from '../shared/http-json.mjs';
import { RequestGuard, positiveLimit } from './request-guard.mjs';
import { TrafficBudget } from './traffic-budget.mjs';
import { createApiPolicy } from './api-policy.mjs';
import { PersonalStorage } from './personal-storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const environmentFile = process.env.HG_ENV_FILE || path.resolve(__dirname, "../.env");
if (fs.existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const DIST_DIR = process.env.HG_WEB_DIR || path.resolve(__dirname, "../apps/web-pc/dist");
const axios = createContentClient({ maxContentLength: 16 * 1024 * 1024, maxBodyLength: 1024 * 1024 });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  if (!fs.existsSync(DIST_DIR)) return false;
  try { pathname = decodeURIComponent(pathname); } catch { throw new AccountError(400, '请求格式无效'); }
  // 只提供构建产物；隐藏文件、源码映射和越出构建目录的符号链接不能被读取。
  if (pathname.split(/[\\/]/).some(part => part.startsWith('.')) || (path.extname(pathname) && !Object.hasOwn(MIME_TYPES, path.extname(pathname).toLowerCase()))) throw new AccountError(404, '页面不存在');
  let targetFile = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = path.join(DIST_DIR, targetFile);

  const relative = path.relative(DIST_DIR, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AccountError(404, '页面不存在');

  // SPA 回退
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (path.extname(pathname)) throw new AccountError(404, '页面不存在');
    filePath = path.join(DIST_DIR, "index.html");
  }
  if (!fs.existsSync(filePath)) return false;
  const actual = path.relative(fs.realpathSync(DIST_DIR), fs.realpathSync(filePath));
  if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) throw new AccountError(404, '页面不存在');

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  const stream = fs.createReadStream(filePath);
  res.once('close', () => stream.destroy());
  stream.once('error', error => { console.error('[静态文件读取失败]:', error.message); res.destroy(); });
  stream.pipe(res);
  return true;
}

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.HG_DATA_DIR || path.join(__dirname, "data");
const accountStore = new AccountStore(path.join(DATA_DIR, "accounts.sqlite"));
const accounts = createAccountService(accountStore);
const authorizeApi = createApiPolicy(accounts, accountStore);
const personalStorage = new PersonalStorage(DATA_DIR,process.env);
const content = createContentService(DATA_DIR, accountStore, accounts, coreProvider);
const catalog = new CatalogCache();
const trafficBudget = new TrafficBudget(path.join(DATA_DIR, 'resource-usage.sqlite'), process.env);
const playbackGuard = new PlaybackGuard(process.env, trafficBudget);
const requestGuard = new RequestGuard(process.env);
const historyStore = new HistoryStore(process.env.HISTORY_DB_PATH || path.join(DATA_DIR, "history.sqlite"));
const libraryStore = new LibraryStore(path.join(DATA_DIR, "library.sqlite"));
const librarySync = new LibrarySync(libraryStore,{allowPrivateTargets:process.env.HG_MANAGED==='1',guardWrite:()=>personalStorage.ensureFree()});
const handleLibrary = createLibraryHandler(libraryStore, librarySync);
if (!libraryStore.getMeta("legacyBackendMigrated")) {
  for (const item of historyStore.list()) libraryStore.write({kind:"history", key:item.seriesId, op:"set", at:item.updatedAt, value:item});
  libraryStore.setMeta("legacyBackendMigrated", true);
}
function legacyLibraryHistory(historyStore, libraryStore) { return {
 registerSession: value => historyStore.registerSession(value),
 saveProgress: value => { const result=historyStore.saveProgress(value); if(result.accepted) libraryStore.write({id:`legacy:${value.sessionId}:${value.sequence}`,kind:"history",key:result.item.seriesId,op:"set",at:result.item.updatedAt,value:result.item}); return result; },
 list: () => libraryStore.snapshot().history,
 get: id => libraryStore.snapshot().history.find(item=>item.seriesId===id)||null,
 remove: id => { historyStore.remove(id); libraryStore.write({kind:"history",key:id,op:"delete"}); return {ok:true}; },
 clear: () => { historyStore.clear(); libraryStore.write({kind:"history",key:"*",op:"clear"}); return {ok:true}; },
 importLegacy: value => { const result=historyStore.importLegacy(value); for(const item of historyStore.list()) if(!libraryStore.snapshot().history.some(row=>row.seriesId===item.seriesId)) libraryStore.write({id:`legacy-import:${value.clientId}:${item.seriesId}`,kind:"history",key:item.seriesId,op:"set",at:item.updatedAt,value:item}); return result; }
}; }
const legacyHistory = legacyLibraryHistory(historyStore, libraryStore);
const handleHistory = createHistoryHandler(legacyHistory);
// H5不再使用共享游客库；旧同步配置只能由桌面本地模式继续运行。
if (process.env.HG_MANAGED === '1') librarySync.start();

// 初始化官方视频解密与画质引擎
let hgEngine = null;
try {
  const sharedEngine = new URL("../shared/content-core/hongguo.js", import.meta.url);
  const cjsPath = fs.existsSync(sharedEngine) ? sharedEngine : new URL("../shared/content-core/vendor/hongguo.cjs", import.meta.url);
  if (fs.existsSync(cjsPath)) {
    const source = fs.readFileSync(cjsPath, "utf8");
    const context = vm.createContext({
      require: (name) => {
        if (name === "node:crypto") return crypto;
        throw new Error("Unsupported module: " + name);
      },
      Buffer,
      URL,
      URLSearchParams,
      Map: ContentCache,
      axios: createContentClient({
        maxContentLength: 16 * 1024 * 1024,
        maxBodyLength: 1024 * 1024,
      }),
    });
    vm.runInContext(
      source + "\nthis.api = {fetchVideoInfo, resolveStream, qualityLabel, qualityNumber, prepareHeader, remoteRange, decryptPartial};",
      context,
      { timeout: 5000 }
    );
    hgEngine = context.api;
    console.log("✅ 共享内容与解密引擎加载成功!");
  }
} catch (e) {
  console.error("⚠️ 加载 hongguo.cjs 失败:", e.message);
}

function byteRange(value, total) {
  if (!value) return [0, total - 1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
  const end = m[1]
    ? m[2]
      ? Math.min(Number(m[2]), total - 1)
      : total - 1
    : total - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < total
    ? [start, end]
    : null;
}

// 官方 24 个题材标签映射池
const OFFICIAL_TAGS = [
  { id: "romance", name: "爱情", categoryId: "5000" },
  { id: "period", name: "年代", categoryId: "5021" },
  { id: "comeback", name: "逆袭", categoryId: "5031" },
  { id: "legend", name: "传奇", categoryId: "5011" },
  { id: "growth", name: "成长", categoryId: "5010" },
  { id: "family", name: "家庭", categoryId: "5001" },
  { id: "clan", name: "家族", categoryId: "5002" },
  { id: "cute-kids", name: "萌宝", categoryId: "5003" },
  { id: "suspense", name: "悬疑", categoryId: "5004" },
  { id: "thriller", name: "惊悚", categoryId: "5132" },
  { id: "horror", name: "恐怖", categoryId: "5133" },
  { id: "supernatural", name: "志怪", categoryId: "5006" },
  { id: "costume", name: "古装", categoryId: "5007" },
  { id: "fantasy", name: "玄幻", categoryId: "5008" },
  { id: "wonder", name: "奇幻", categoryId: "5009" },
  { id: "urban", name: "都市", categoryId: "5022" },
  { id: "youth", name: "青春", categoryId: "5023" },
  { id: "comedy", name: "喜剧", categoryId: "5024" },
  { id: "sci-fi", name: "科幻", categoryId: "5025" },
  { id: "disaster", name: "灾难", categoryId: "5026" },
  { id: "action-adventure", name: "动作冒险", categoryId: "5027" },
  { id: "war", name: "战争", categoryId: "5028" },
  { id: "variety", name: "综艺", categoryId: "5029" },
  { id: "drama", name: "剧情", categoryId: "5030" }
];

const OFFICIAL_TYPES = [
  { id: "real-drama", name: "真人剧" },
  { id: "comic-drama", name: "漫剧" },
  { id: "ai-drama", name: "AI剧" }
];

function createRecommendations(libraryStore) { return new RecommendationService({
  fetchLocalPool: ({mode,page}) => {
    const options={type:mode==='mixed'?'':mode};
    return [...content.list({...options,page:1}),...(page===1?[]:content.list({...options,page}))];
  },
  fetchPool: async ({type,tag,page}) => {
    if(tag){const metadata=await coreProvider.categoryMetadata(type);if(!metadata.tags.some(row=>row.id===tag))return [];}
    let items;
    try { items = await coreProvider.category(type,tag,page); }
    catch (error) { if (!content.list({ type, page }).length) throw error; items = []; }
    return content.merge(items, { type, tag, tagLabel: OFFICIAL_TAGS.find(item => item.id === tag)?.name || tag, page });
  },
  readProfile: () => libraryStore.snapshot(),
  now: () => Math.round(Date.now()+(libraryStore.getMeta('clockOffset')||0)),
  topics: OFFICIAL_TAGS,
}); }
const recommendations = createRecommendations(libraryStore);
const personalLibraries = new Map();
function personalServices(account, res, req) {
  if (!account) return { handleLibrary, handleHistory, recommendations };
  const previous=personalLibraries.get(account.id);
  if(previous?.ephemeral && !['GET','HEAD'].includes(req.method)){
    personalStorage.open(previous.directory,!!account.guest);
    personalLibraries.delete(account.id);previous.retired=true;
    if(!previous.active){previous.sync.stop();previous.library.close();previous.history.close();}
  }
  if (!personalLibraries.has(account.id)) {
    // 缓存只限制同时打开的数据库；关闭空闲连接不删除用户资料。
    if (personalLibraries.size >= 128) {
      const idle = [...personalLibraries.entries()].find(([,service])=>!service.active && !service.sync.running);
      if (!idle) throw new AccountError(429,'操作过于频繁，请稍后重试');
      idle[1].sync.stop();idle[1].library.close();idle[1].history.close();personalLibraries.delete(idle[0]);
    }
    const directory = path.join(DATA_DIR, account.guest ? 'guests' : 'accounts', account.id);
    // 空资料的读取仅用内存；首次实际写入才创建磁盘库，访问页面不会积累游客文件。
    const ephemeral=['GET','HEAD'].includes(req.method) && !fs.existsSync(directory);
    if(!ephemeral)personalStorage.open(directory,!!account.guest);
    const library = new LibraryStore(ephemeral?':memory:':path.join(directory, 'library.sqlite'));
    const history = new HistoryStore(ephemeral?':memory:':path.join(directory, 'history.sqlite'));
    if(!ephemeral){fs.chmodSync(directory,0o700);for(const name of ['library.sqlite','history.sqlite'])fs.chmodSync(path.join(directory,name),0o600);}
    const sync = new LibrarySync(library,{allowPrivateTargets:accounts.isLocal(req),guardWrite:bytes=>{personalStorage.check(directory,!!account.guest,bytes);return()=>personalStorage.refresh(directory);}});
    if (!account.guest && accounts.canConfigureSync(account,req)) sync.start();
    personalLibraries.set(account.id, { active:0, directory, ephemeral, library, history, sync, handleLibrary: createLibraryHandler(library, sync), handleHistory: createHistoryHandler(legacyLibraryHistory(history, library)), recommendations: createRecommendations(library) });
    if(!ephemeral)personalStorage.refresh(directory);
  }
  const service = personalLibraries.get(account.id);
  personalStorage.attach(req,res,service.directory,!!account.guest,[service.library.db,service.history.db]);
  personalLibraries.delete(account.id);personalLibraries.set(account.id,service);service.active++;
  let released=false;const release=()=>{if(!released){released=true;service.active--;if(service.retired&&!service.active){service.sync.stop();service.library.close();service.history.close();}}};
  res.once('finish',release);res.once('close',release);
  return service;
}

// 官方四大排行榜类别定义
const OFFICIAL_RANK_TYPES = [
  { slug: "hot-drama", name: "红果热播榜", key: "all" },
  { slug: "hot-real-drama", name: "真人剧热播榜", key: "real" },
  { slug: "hot-ai-drama", name: "AI剧热播榜", key: "ai" },
  { slug: "hot-comic-drama", name: "漫剧热播榜", key: "comic" },
];

let cacheHome = { timestamp: 0, banners: [], sections: [] };
let categoryCache = new Map();
let rankPageCache = new Map();
const vidToSeriesMap = new Map();
const webStreamCache = new Map();

// 读取官方播放页提供的公开媒体，校验剧集与分集对应关系。
async function getOfficialWebPlayback(seriesId, vid) {
  if (!/^\d+$/.test(String(seriesId)) || !/^\d+$/.test(String(vid))) return null;
  const cacheKey = `${seriesId}_${vid}`;
  const cached = webStreamCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 3 * 60 * 1000) {
    return cached.value;
  }
  const data = await coreProvider.playbackMetadata(seriesId, vid);
  const player = data?.loaderData?.["player_(series_id)/(vid)/page"] || data?.loaderData?.["player_(series_id)/page"];
  const publicVideo = player?.publicVideoSeo;
  let value = null;
  if (publicVideo?.available === true && String(publicVideo.seriesId) === String(seriesId) && String(publicVideo.itemId) === String(vid)) {
    value = { url: `https://hongguoduanju.com/video/public/${vid}/360p.mp4`, key: "360P", qualityNum: 360, codec: "H.264", label: "360P 流畅" };
  } else if (!player?.protectedPlayback && /^https:\/\//.test(player?.video_player_info?.main_url || "")) {
    value = { url: player.video_player_info.main_url, key: "720P", qualityNum: 720, codec: "H.264", label: "720P 高清" };
  }
  if (value) {
    while (webStreamCache.size >= 100) webStreamCache.delete(webStreamCache.keys().next().value);
    webStreamCache.set(cacheKey, { time: Date.now(), value });
  }
  return value;
}

// 原样代理字节范围，避免转发源站 Cookie 和逐跳头；浏览器中断时释放上游连接。
async function proxyWebVideo(req, res, playback) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const headers = { "Referer": "https://hongguoduanju.com/", "Accept-Encoding": "identity" };
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await axios({
      method: req.method === "HEAD" ? "HEAD" : "GET", url: playback.url,
      responseType: "stream", headers, signal: controller.signal,
      timeout: 20000, validateStatus: () => true,
    });
    if (res.destroyed) { upstream.data.destroy(); return; }
    if (![200, 206, 416].includes(upstream.status)) {
      upstream.data.destroy();
      webStreamCache.clear();
      return json(res, { error: "视频源暂不可用，请重试" }, 502);
    }
    if (upstream.status !== 416 && !/^video\//i.test(upstream.headers["content-type"] || "")) {
      upstream.data.destroy();
      return json(res, { error: "视频源未返回有效媒体" }, 502);
    }
    const responseHeaders = {
      "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, X-Video-Quality",
      "X-Video-Quality": playback.key,
    };
    for (const name of ["content-range", "content-length"]) {
      if (upstream.headers[name] !== undefined) responseHeaders[name] = upstream.headers[name];
    }
    if (upstream.status === 416) responseHeaders["content-length"] = "0";
    req.revalidatePlayback?.(true);
    res.writeHead(upstream.status, responseHeaders);
    if (req.method === "HEAD" || upstream.status === 416) { upstream.data.destroy(); res.end(); return; }
    upstream.data.once("error", () => res.destroy());
    upstream.data.pipe(res);
  } catch (error) {
    if (res.destroyed || controller.signal.aborted) return;
    if (res.headersSent) res.destroy();
    else if (error instanceof AccountError) json(res, { error: error.message }, error.status);
    else json(res, { error: "视频加载超时或连接中断，请重试" }, 502);
  }
}


// 1. 获取官方首页数据 (含 Banner + 四大排行榜基础池)
async function fetchOfficialHome() {
  const now = Date.now();
  if (cacheHome.timestamp && now - cacheHome.timestamp < 10 * 60 * 1000) {
    return cacheHome;
  }

  try {
    const res = await axios.get("https://hongguoduanju.com", {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
    });

    const match = res.data.match(/_ROUTER_DATA\s*=\s*(\{.*?\});/s);
    if (match) {
      const data = JSON.parse(match[1]);
      const page = data?.loaderData?.page || {};
      cacheHome = {
        timestamp: now,
        banners: (page.bannerList || []).map((b) => ({
          id: String(b.series_id),
          title: b.series_name,
          cover: b.series_cover,
          backgroundCover: b.background_cover_pc,
          titleImage: b.title_link_pc,
          description: b.series_intro,
          tags: (b.tags || []).join("/"),
        })),
        sections: (page.homeSections || []).map((s) => ({
          type: s.tab_type,
          name: s.tab_name,
          items: (s.video_list || []).map((v) => ({
            id: String(v.series_id),
            title: v.series_title,
            cover: v.series_cover,
            badge: v.episode_right_text || `全${v.episode_cnt}集`,
            description: v.series_intro || "",
            tags: `${s.tab_name} · 排名第${v.rank || 1}`,
            rank: v.rank || 1,
          })),
        })),
      };
      return cacheHome;
    }
  } catch (err) {
    console.error("[Official Home Error]:", err.message);
  }
  return cacheHome;
}

// 2. 抓取官方分类短剧列表 (带题材路由与分页)
async function fetchOfficialCategory(type = "real-drama", tag = "", page = 1) {
  const cacheKey = `${type}_${tag}_${page}`;
  const cached = categoryCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 10 * 60 * 1000) {
    return cached.data;
  }

  let url = `https://hongguoduanju.com/category/${type}`;
  if (tag) {
    url += `/${tag}`;
  }
  if (page > 1) {
    url += `?page=${page}`;
  }

  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" }
    });

    const match = res.data.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/);
    if (match) {
      const data = JSON.parse(match[1]);
      const catData = data?.loaderData?.["category_$"] || {};
      const items = (catData.recommendList || []).map((item) => ({
        id: String(item.series_id),
        title: item.series_name,
        cover: item.series_cover,
        badge: item.episode_right_text || `全${item.episode_cnt}集`,
        description: item.series_intro || "",
        tags: (item.tags || []).join("/"),
      }));

      const result = { type, tag, page, items };
      categoryCache.set(cacheKey, { time: Date.now(), data: result });
      return result;
    }
  } catch (err) {
    console.error("[Official Category Error]:", err.message);
  }
  return { type, tag, page, items: [] };
}

// 3. 官方排行榜 HTML 数据流提取器 (前 100 名分页解析)
function extractRankFromHtml(html) {
  // 方式 1: 直接匹配 data-fn-args 属性值
  const attrRegex = /data-fn-args="([\s\S]*?)"\s*>/g;
  let match;
  while ((match = attrRegex.exec(html)) !== null) {
    try {
      const raw = match[1];
      if (!raw.includes("rankList")) continue;
      const decoded = raw.replace(/&quot;/g, '"');
      const arr = JSON.parse(decoded);
      const contentObj = arr[1]?.find((x) => x.key === "content");
      if (contentObj) {
        const rawArg = contentObj?.routerDataFnArgs?.[0];
        const parsed = typeof rawArg === "string" ? JSON.parse(rawArg) : rawArg;
        if (parsed && Array.isArray(parsed.rankList) && parsed.rankList.length > 0) {
          return parsed;
        }
      }
    } catch (_) {}
  }

  // 方式 2: 遍历 script 标签兜底解析
  const scripts = html.match(/<script[\s\S]*?<\/script>/g) || [];
  for (const s of scripts) {
    if (s.includes("rankList")) {
      const idx = s.indexOf('data-fn-args="');
      if (idx !== -1) {
        const start = idx + 'data-fn-args="'.length;
        const end = s.indexOf('">', start);
        if (end !== -1 && end > start) {
          const raw = s.slice(start, end);
          const decoded = raw.replace(/&quot;/g, '"');
          try {
            const arr = JSON.parse(decoded);
            const contentObj = arr[1]?.find((x) => x.key === "content");
            const rawArg = contentObj?.routerDataFnArgs?.[0];
            if (rawArg) {
              const parsed = typeof rawArg === "string" ? JSON.parse(rawArg) : rawArg;
              if (parsed && Array.isArray(parsed.rankList) && parsed.rankList.length > 0) {
                return parsed;
              }
            }
          } catch (e) {
            console.error("Parse rank JSON error:", e.message);
          }
        }
      }
    }
  }
  return null;
}

// 4. 抓取官方排行榜单页 (支持 4 大榜单，1~5 页，每页 20 部，共 100 部)
async function fetchOfficialRankPage(slug = "hot-drama", page = 1) {
  const pageNum = Math.max(1, Math.min(5, parseInt(page, 10) || 1));
  const typeConfig = OFFICIAL_RANK_TYPES.find((r) => r.slug === slug || r.key === slug) || OFFICIAL_RANK_TYPES[0];
  const targetSlug = typeConfig.slug;
  const cacheKey = `${targetSlug}_${pageNum}`;

  const cached = rankPageCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) {
    return cached.data;
  }

  const url = `https://hongguoduanju.com/rank/${targetSlug}${pageNum > 1 ? `?page=${pageNum}` : ""}`;
  
  // 增加重试机制与长超时 (15000ms)，避免因官方接口偶尔慢响应导致降级
  let html = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: 15000,
      });
      html = res.data;
      break;
    } catch (err) {
      console.warn(`[Rank Fetch Attempt ${attempt + 1} Failed for ${targetSlug}]:`, err.message);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }

  if (html) {
    const parsed = extractRankFromHtml(html);
    if (parsed && Array.isArray(parsed.rankList) && parsed.rankList.length > 0) {
      const items = parsed.rankList.map((item) => {
        const episodeCount = item.episodeVids?.length || 0;
        return {
          id: String(item.seriesId || item.id),
          rank: item.rank,
          title: item.title,
          cover: item.cover,
          badge: episodeCount > 0 ? `全${episodeCount}集` : "",
          heatText: item.heatText || "热播指数高",
          scoreText: item.scoreText || "",
          favoriteText: item.favoriteText || "",
          likeText: item.likeText || "",
          tags: Array.isArray(item.tags) ? item.tags.join(" · ") : (item.tags || ""),
          description: item.description || "",
        };
      });

      const result = {
        slug: targetSlug,
        title: typeConfig.name,
        page: pageNum,
        totalPages: parsed.pagination?.totalPages || 5,
        total: 100,
        updatedText: "今日已更新 · 基于红果内观看/互动等综合热度排序",
        items,
      };

      rankPageCache.set(cacheKey, { time: Date.now(), data: result });
      return result;
    }
  }

  // 兜底回退：若遇官方网站异常，优先使用首页对应分区，并自动从官方分类池补充至完整的 20 部！
  let fallbackItems = [];
  const home = await fetchOfficialHome();
  const sec = home.sections.find(
    (s) => s.type === typeConfig.key || s.type === typeConfig.slug || (typeConfig.key === "real" && s.type === "human")
  ) || home.sections[0];

  if (sec && Array.isArray(sec.items)) {
    fallbackItems = sec.items.map((it, idx) => ({
      ...it,
      rank: (pageNum - 1) * 20 + idx + 1,
      heatText: "热播指数高",
    }));
  }

  // 如果依然不足 20 部，从对应类型的分类池充实补满至 20 部！
  if (fallbackItems.length < 20) {
    try {
      const catMap = {
        "hot-drama": "real-drama",
        "hot-real-drama": "real-drama",
        "hot-ai-drama": "ai-drama",
        "hot-comic-drama": "comic-drama",
      };
      const catType = catMap[targetSlug] || "real-drama";
      const cat = await fetchOfficialCategory(catType, "", pageNum);
      const seen = new Set(fallbackItems.map((i) => String(i.id)));
      for (const item of (cat.items || [])) {
        if (!seen.has(String(item.id))) {
          seen.add(String(item.id));
          fallbackItems.push({
            ...item,
            rank: fallbackItems.length + 1,
            heatText: "热播指数高",
          });
        }
        if (fallbackItems.length >= 20) break;
      }
    } catch (_) {}
  }

  const fallbackResult = {
    slug: targetSlug,
    title: typeConfig.name,
    page: pageNum,
    totalPages: 5,
    total: 100,
    updatedText: "今日已更新 · 基于红果内观看/互动等综合热度排序",
    items: fallbackItems.slice(0, 20),
  };

  return fallbackResult;
}

function json(res, data, status = 200) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  protectRequestBody(req, res);
  // 浏览器页面与接口统一设置安全边界，生产静态页面也不能被外站嵌入。
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; frame-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  let u;
  if (req.url.length > 4096) return json(res, { error: '请求格式无效' }, 414);
  try { u = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch { return json(res,{error:'请求地址无效'},400); }
  const pathname = u.pathname;
  const isApi = pathname === '/api' || pathname.startsWith('/api/');

  if (req.method === "OPTIONS") {
    try { if (isApi) authorizeApi(req,res,u); }
    catch (error) { const failure=publicFailure(error); return json(res,{error:failure.message},failure.status); }
    res.writeHead(204);
    return res.end();
  }

  // 1. 健康检查
  if (pathname === "/health") {
    return json(res, { ok: true });
  }

  let playbackSignal;
  if (isApi) {
    try {
      const audience = accounts.audience(req);
      req.playbackPrivileged = !!audience && !audience.guest && (accounts.canConfigureSync(audience,req) || accountStore.membership(audience.id).active);
      const address = accounts.address(req), viewer = audience ? `${audience.guest ? 'guest' : 'account'}:${audience.id}` : `ip:${address}`;
      if (/^\/api\/episodes\/\d+\/stream$/.test(pathname) && ['GET','HEAD'].includes(req.method)) {
        if ((req.headers.range || '').length > 80) throw new AccountError(400, '请求格式无效');
        requestGuard.checkVideo(viewer, address);
        playbackSignal = playbackGuard.acquire(req, res, viewer, address);
      } else {
        const upload = req.method === 'PUT' && /^\/api\/admin\/uploads\/[a-f0-9-]+$/.test(pathname) && audience && !audience.guest && accounts.canConfigureSync(audience,req);
        requestGuard.acquire(req, res, viewer, address, /^\/api\/auth\/(login|register|reset)$/.test(pathname)||pathname==='/api/account/mfa/setup', upload);
      }
      if ([...u.searchParams].some(([key, value]) => key.length > 80 || value.length > (key === 'q' ? 200 : 1024))) throw new AccountError(400, '请求格式无效');
    } catch (error) {
      const failure = publicFailure(error);
      if (failure.status === 429) res.setHeader('Retry-After', String(error.retryAfter || 1));
      return json(res, { error: failure.message }, failure.status);
    }
  }
  const handleRequest = async () => {
  try {
    // 静态文件也纳入异常处理，部署期间文件变化不会绕过错误边界。
    if (!isApi) {
      requestGuard.acquireStatic(req, res, accounts.address(req));
      if (serveStatic(req, res, pathname)) return;
    }
    if (isApi) authorizeApi(req,res,u);
    const securityAction=['/api/auth/login','/api/auth/logout','/api/auth/reset','/api/auth/verify','/api/account/sessions/revoke','/api/account/mfa/setup','/api/account/mfa/enable','/api/account/mfa/verify'].includes(pathname);
    // 保留空间不足时，仍允许登录、退出及验证，便于用户保护账户和管理员处理故障。
    if(isApi && ['POST','PUT'].includes(req.method) && !securityAction){
      const previous=req.revalidateAccess;
      req.revalidateAccess=()=>{previous?.();personalStorage.ensureFree();};
      req.revalidateAccess();
    }
    if (await accounts.handle(req, res, u)) return;
    if (await content.handle(req, res, u)) return;
    const personalRoute = pathname.startsWith('/api/library') || pathname.startsWith('/api/history') || pathname === '/api/recommend';
    const services = personalServices(personalRoute ? accounts.guardLibrary(req) : null,res,req);
    if (await services.handleLibrary(req, res, u)) return;
    if (await services.handleHistory(req, res, u)) return;
    // 2. 官方大轮播 Banner API
    if (pathname === "/api/banners") {
      const own = content.list();
      const data = await catalog.read('home-sections', fetchOfficialHome, own.length > 0);
      const banners = [...own.map(item => ({ ...item, backgroundCover: item.cover })), ...(data?.banners || [])];
      return json(res, { backgroundPending: !data, banners: banners.filter((item, index) => banners.findIndex(row => row.id === item.id) === index) });
    }

    // 2.1 官方首页专区列表 (GET /api/sections)
    if (pathname === "/api/sections") {
      const own = content.list();
      const data = await catalog.read('home-sections', fetchOfficialHome, own.length > 0);
      return json(res, { backgroundPending: !data, sections: own.length ? [{ type: 'uploaded', name: '为你推荐', items: own }, ...(data?.sections || [])] : data.sections });
    }

    // 3. 官方分类标签池 (GET /api/category/tags)
    if (pathname === "/api/category/tags") {
      const type = u.searchParams.get('type') || 'real-drama';
      if (!OFFICIAL_TYPES.some(row => row.id === type)) throw new AccountError(400, '不支持的分类类型');
      const ownTags = content.store.categoryTags(type, OFFICIAL_TAGS);
      try {
        const data = await catalog.read(`tags:${type}`, () => coreProvider.categoryMetadata(type), content.store.listPage({type}).pagination.total > 0);
        const tags = [...(data?.tags || []), ...ownTags];
        return json(res, { ...(data || {types:OFFICIAL_TYPES,type}), backgroundPending:!data, tags:tags.filter((item,index)=>tags.findIndex(row=>row.id===item.id)===index) });
      } catch {
        if (ownTags.length || content.store.listPage({type}).pagination.total > 0) return json(res, {types:OFFICIAL_TYPES,type,tags:ownTags});
        throw new AccountError(502, '官网题材读取失败，请重试');
      }
    }

    // 4. 官方分类短剧列表 (GET /api/category/list?type=real-drama&tag=romance&page=1)
    if (pathname === "/api/category/list") {
      const type = u.searchParams.get("type") || "real-drama";
      const tag = u.searchParams.get("tag") || "";
      const page = Number(u.searchParams.get("page") || "1");
      if (!OFFICIAL_TYPES.some(row => row.id === type)) throw new AccountError(400, '不支持的分类类型');
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new AccountError(400, '分类页码无效');
      const options = {type,tag,tagLabel:OFFICIAL_TAGS.find(item=>item.id===tag)?.name || tag,page};
      const own = content.store.listPage(options);
      try {
        const data = await catalog.read(`category:${type}:${tag}:${page}`, () => coreProvider.categoryList(type,tag,page), own.pagination.total > 0);
        return json(res, { ...(data || {type,tag,page}), backgroundPending: !data, items:content.merge(data?.items || [],options), pagination:{...(data?.pagination || own.pagination),totalPages:Math.max(data?.pagination?.totalPages || 1,own.pagination.totalPages)} });
      } catch (error) { throw new AccountError(error.status || 502, error.status === 400 ? error.message : '官网分类读取失败，请重试'); }
    }

    // 5. 官方排行榜类别 (GET /api/rank/types)
    if (pathname === "/api/rank/types") {
      return json(res, { types: OFFICIAL_RANK_TYPES });
    }

    // 5.1 官方四大排行榜分页列表 (GET /api/rank/list?type=hot-drama&page=1)
    if (pathname === "/api/rank/list" || pathname === "/api/rank/page") {
      const slug = u.searchParams.get("type") || u.searchParams.get("slug") || "hot-drama";
      const page = parseInt(u.searchParams.get("page") || "1", 10);
      if (!OFFICIAL_RANK_TYPES.some(row => row.slug === slug || row.key === slug) || !Number.isSafeInteger(page) || page < 1 || page > 5) throw new AccountError(400, '请求格式无效');
      const data = await catalog.read(`rank:${slug}:${page}`, () => fetchOfficialRankPage(slug, page));
      return json(res, data);
    }

    // 5.2 兼容旧版全量四大排行榜 (GET /api/ranks)
    if (pathname === "/api/ranks") {
      const home = await catalog.read('home-sections', fetchOfficialHome);
      const ranks = home.sections.map((sec) => ({
        key: sec.type,
        title: sec.name.includes("榜") ? sec.name : `${sec.name}榜`,
        items: sec.items,
      }));
      return json(res, { ranks });
    }

    // 6. 全库短剧综合推荐接口 (GET /api/recommend 或 GET /api/home)
    if (pathname === "/api/recommend") {
      try {
        const page=Number(u.searchParams.get("page")||1);
        const session=u.searchParams.get("session")||crypto.randomUUID();
        return json(res,await services.recommendations.page(session,page));
      } catch(error) {
        return json(res,{error:error instanceof RecommendationError ? error.message : '推荐读取失败'},error instanceof RecommendationError?error.status:502);
      }
    }
    if (pathname === "/api/home") {
      const page = parseInt(u.searchParams.get("page") || "1", 10);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new AccountError(400, '分类页码无效');
      const own = content.list({page});
      const data = await catalog.read(`home:${page}`, async () => {
      try {
        const upstreamRes = {data: await coreProvider.home(page)};
        if (upstreamRes.data && Array.isArray(upstreamRes.data.items) && upstreamRes.data.items.length > 0) {
          return upstreamRes.data;
        }
      } catch (err) {
        // 上游不可用时自动降级到官方 Web 分类推荐池
      }
      const cat = await fetchOfficialCategory("real-drama", "", page);
      return { items: cat.items, page };
      }, own.length > 0);
      return json(res, { ...(data || {page}), items:content.merge(data?.items || [],{page}) });
    }


    // 7. 搜索接口 (GET /api/search?q=...)
    if (pathname === "/api/search") {
      const query = u.searchParams.get("q") || "", page = Number(u.searchParams.get("page") || 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new AccountError(400, '分类页码无效');
      const own = content.list({query,page});
      const data = await catalog.read(`search:${query}:${page}`, () => coreProvider.search(query,page), own.length > 0);
      return json(res, { ...(data || {page}), items:content.merge(data?.items || [], {query,page}) });
    }

    // 8. 单剧相关推荐 / 猜你喜欢 (GET /api/series/:id/related 或 GET /api/series/:id/recommend)
    const relMatch = /^\/api\/series\/(\d+)\/(?:related|recommend)$/.exec(pathname);
    if (relMatch) {
      const seriesId = relMatch[1];
      if (content.store.row(seriesId)) { const series = await content.detail(seriesId); return json(res,{seriesId,keyword:'',page:1,items:content.list({type:series.contentType}).filter(item=>item.id!==seriesId)}); }
      const limit = Number(u.searchParams.get("limit") || "16");
      const page = Number(u.searchParams.get("page") || "1");
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(page) || page < 1 || page > 1000) throw new AccountError(400, '请求格式无效');
      const related = await catalog.read(`related:${seriesId}:${page}:${limit}`, async () => {
      try {
        const detailRes = {data: await coreProvider.detail(seriesId)};
        const seriesData = detailRes.data;
        const tags = (seriesData.tags || "").split(/[\/,，\s]+/).filter(Boolean);
        const firstTag = tags[0] || "";

        let relatedItems = [];
        const seenIds = new Set([String(seriesId)]);

        // 1. 优先按相关题材/标签搜索（支持按页抓取）
        for (const t of (tags.length ? tags.slice(0, 3) : ["热播"])) {
          try {
            const searchRes = {data: await coreProvider.search(t,page)};
            for (const item of searchRes.data?.items || []) {
              const sid = String(item.id);
              if (!seenIds.has(sid)) {
                seenIds.add(sid);
                relatedItems.push(item);
              }
            }
          } catch (_) {}
          if (relatedItems.length >= limit) break;
        }

        // 2. 如果数量不足，从主页推荐与算法流按页补充
        let recPage = page;
        while (relatedItems.length < limit && recPage <= page + 2) {
          try {
            const recRes = {data: await coreProvider.home(recPage)};
            for (const item of recRes.data?.items || []) {
              const sid = String(item.id);
              if (!seenIds.has(sid)) {
                seenIds.add(sid);
                relatedItems.push(item);
              }
            }
          } catch (_) {}
          recPage++;
        }

        // 3. 兜底保障：官方网页分类列表
        if (relatedItems.length < limit) {
          try {
            const cat = await fetchOfficialCategory("real-drama", "", page);
            for (const item of cat.items || []) {
              const sid = String(item.id);
              if (!seenIds.has(sid)) {
                seenIds.add(sid);
                relatedItems.push(item);
              }
            }
          } catch (_) {}
        }

        return {
          seriesId,
          keyword: firstTag,
          page,
          items: relatedItems.slice(0, limit),
        };
      } catch (err) {
        const home = await fetchOfficialHome();
        const fallbackItems = (home.banners || [])
          .concat(home.sections?.[0]?.items || [])
          .filter((item) => String(item.id) !== String(seriesId));
        return { seriesId, keyword: "", page, items: fallbackItems.slice(0, limit) };
      }
      });
      return json(res, related);
    }

    // 8.1 剧集详情 (GET /api/series/:id)
    if (pathname.startsWith("/api/series/")) {
      const seriesData = await content.publicDetail(req, decodeURIComponent(pathname.slice("/api/series/".length)));
      if (seriesData && Array.isArray(seriesData.episodes)) {
        for (const ep of seriesData.episodes) {
          if (vidToSeriesMap.size >= 10000) vidToSeriesMap.delete(vidToSeriesMap.keys().next().value);
          vidToSeriesMap.set(String(ep.id), String(seriesData.id));
        }
      }
      return json(res, seriesData);
    }


    // 9. 官方多画质清晰度列表 (GET /api/episodes/:id/qualities)
    // 动态从官方接口读取该视频实际拥有的全部可解码播放清晰度档位，严格过滤会导致解码器崩溃的 bytevc2 私有流
    const qMatch = /^\/api\/episodes\/(\d+)\/qualities$/.exec(pathname);
    const guardedPlayback = /^\/api\/episodes\/(\d+)\/(qualities|play|stream)$/.exec(pathname);
    if (guardedPlayback) {
      if (!['GET','HEAD'].includes(req.method)) throw new AccountError(405,'请求方式无效');
      const seriesId = u.searchParams.get('seriesId') || u.searchParams.get('series_id') || vidToSeriesMap.get(guardedPlayback[1]);
      const resolved = await content.resolveEpisode(req, seriesId, guardedPlayback[1]);
      if (await content.ownPlayback(req,res,guardedPlayback[2],resolved)) return;
    }
    if (qMatch) {
      const episodeId = qMatch[1];
      const seriesId = u.searchParams.get("seriesId") || u.searchParams.get("series_id") || vidToSeriesMap.get(episodeId);
      const list = [];
      const seenKeys = new Set();

      try {
        const playback = await getOfficialWebPlayback(seriesId, episodeId);
        if (playback) return json(res, {
          episodeId, defaultQuality: playback.key,
          qualities: [{ key: playback.key, label: playback.label, qualityNum: playback.qualityNum, codec: playback.codec, rawKey: "official_web", isDefault: true }],
        });
      } catch (error) { console.warn("[网页播放信息读取失败]:", error.message); }

      const labelMap = {
        2160: "4K 超高清",
        1440: "2K 超清",
        1080: "1080P 超清",
        720: "720P 高清",
        540: "540P 高清",
        480: "480P 标清",
        360: "360P 流畅",
      };

      if (hgEngine) {
        try {
          const info = await hgEngine.fetchVideoInfo(episodeId);
          if (info.rows && Array.isArray(info.rows)) {
            for (const row of info.rows) {
              const qNum = hgEngine.qualityNumber(row.quality || row.item?.vheight || row.key);
              const key = qNum ? `${qNum}P` : (row.item?.definition || row.key).toUpperCase();
              const codec = row.item?.codec_type;

              // 核心过滤：bytevc2 是字节跳动未开源私有编码，标准浏览器与电视机芯会直接触发 PIPELINE_ERROR_DECODE 崩溃
              // 仅保留官方真实支持解码的流（如 bytevc1/HEVC 或 H.264）
              if (codec === "bytevc2") {
                continue;
              }

              if (seenKeys.has(key)) continue;
              seenKeys.add(key);

              const label = labelMap[qNum] || `${key} ${row.quality || ""}`.trim();
              list.push({
                key,
                label,
                qualityNum: qNum || 0,
                codec: codec === "bytevc1" ? "HEVC" : (codec || "H.264"),
                rawKey: row.key,
                isDefault: false,
              });
            }
          }
        } catch (e) {
          console.warn("[Official Qualities Fetch Error]:", e.message);
        }
      }

      // 如果 720P 在 App 端属于 bytevc2 被过滤，但官方 Web 网页端拥有原生可播放的 720P H.264，则由官方 Web 补充
      if (!seenKeys.has("720P") && seriesId) {
        try {
          const playback = await getOfficialWebPlayback(seriesId, episodeId);
          if (playback && !seenKeys.has(playback.key)) {
            seenKeys.add(playback.key);
            list.push({
              key: playback.key,
              label: playback.label,
              qualityNum: playback.qualityNum,
              codec: playback.codec,
              rawKey: "official_web",
              isDefault: false,
            });
          }
        } catch (_) {}
      }

      // 没有真实画质时返回失败，不能构造不存在的高清选项。
      if (list.length === 0) {
        return json(res, { error: "当前剧集没有可用的视频源，请稍后重试" }, 502);
      } else {
        // 按分辨率从高到低排序，最高清晰度设为默认
        list.sort((a, b) => b.qualityNum - a.qualityNum);
        list[0].isDefault = true;
      }

      return json(res, {
        episodeId,
        defaultQuality: list[0]?.key || "1080P",
        qualities: list,
      });
    }

    // 10. 单集播放地址解析 (GET /api/episodes/:id/play)
    const pMatch = /^\/api\/episodes\/(\d+)\/play$/.exec(pathname);
    if (pMatch) {
      const episodeId = pMatch[1];
      const quality = u.searchParams.get("quality") || "auto";
      const seriesId = u.searchParams.get("seriesId") || u.searchParams.get("series_id") || vidToSeriesMap.get(episodeId) || "";
      const sParam = seriesId ? `&seriesId=${encodeURIComponent(seriesId)}` : "";
      return json(res, {
        path: `/api/episodes/${episodeId}/stream?quality=${encodeURIComponent(quality)}${sParam}`,
        contentType: "video/mp4",
      });
    }

    // 11. MP4 视频媒体流代理 (支持官方全部实际拥有的 1080P/720P/540P/480P/360P 真实画质流，实时解密并支持 Range)
    const sMatch = /^\/api\/episodes\/(\d+)\/stream$/.exec(pathname);
    if (sMatch) {
      const episodeId = sMatch[1];
      const quality = u.searchParams.get("quality") || "auto";
      const seriesId = u.searchParams.get("seriesId") || u.searchParams.get("series_id") || vidToSeriesMap.get(episodeId);

      try {
        const playback = await getOfficialWebPlayback(seriesId, episodeId);
        if (playback) {
          if (quality !== playback.key && quality !== "auto")
            return json(res, { error: "当前视频不支持所选画质", availableQuality: playback.key }, 400);
          return await proxyWebVideo(req, res, playback);
        }
      } catch (error) { if (playbackSignal?.aborted || res.destroyed) return; console.warn("[网页视频读取失败]:", error.message); }

      // 分支 A: 用户选择 720P 时，若官方 App 端该流属于 bytevc2（不可解码），自动优先调度官方 Web 端原生 H.264 零报错直链
      let preferWeb720p = false;
      if (quality === "720P" && seriesId) {
        if (hgEngine) {
          try {
            const info = await hgEngine.fetchVideoInfo(episodeId);
            const row720 = info.rows?.find(
              (r) => r.key === "video_4" || hgEngine.qualityNumber(r.quality) === 720
            );
            if (!row720 || row720.item?.codec_type === "bytevc2") {
              preferWeb720p = true;
            }
          } catch (_) {
            if (playbackSignal?.aborted || res.destroyed) return;
            preferWeb720p = true;
          }
        } else {
          preferWeb720p = true;
        }
      }

      if (preferWeb720p && seriesId) {
        try {
          const playback = await getOfficialWebPlayback(seriesId, episodeId);
          if (playback) {
            return await proxyWebVideo(req, res, playback);
          }
        } catch (err) {
          if (playbackSignal?.aborted || res.destroyed) return;
          console.warn("[Web 720p Stream Error]:", err.message);
        }
      }

      // 分支 B: 走本地解密引擎调度官方 HEVC (bytevc1) 视频流
      if (hgEngine) {
        try {
          const cachedStream = await hgEngine.resolveStream(episodeId, quality);
          // 在途头部请求不共享取消状态；已完成的真实头部仍回填原缓存复用。
          const stream = { ...cachedStream }; delete stream.preparePromise;
          const prepared = await hgEngine.prepareHeader(stream);
          req.revalidatePlayback?.(true);
          cachedStream.prepared ||= prepared;
          const range = byteRange(req.headers.range, prepared.total);
          if (!range) {
            res.writeHead(416, {
              "Content-Range": `bytes */${prepared.total}`,
              "Access-Control-Allow-Origin": "*",
            });
            return res.end();
          }
          const [start, end] = range;
          const headers = {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
          };
          if (req.headers.range) {
            headers["Content-Range"] = `bytes ${start}-${end}/${prepared.total}`;
          }
          res.writeHead(req.headers.range ? 206 : 200, headers);
          if (req.method === "HEAD") return res.end();

          const chunkSize = 1024 * 1024;
          for (let offset = start; offset <= end && !res.destroyed; offset += chunkSize) {
            const chunkEnd = Math.min(offset + chunkSize - 1, end);
            const raw = await hgEngine.remoteRange(stream, offset, chunkEnd);
            const chunk = hgEngine.decryptPartial(raw.data, offset, stream.key, prepared);
            if (res.destroyed) break;
            if (!res.write(chunk)) {
              await new Promise((resolve) => {
                const done = () => {
                  res.off("drain", done);
                  res.off("close", done);
                  resolve();
                };
                res.on("drain", done);
                res.on("close", done);
              });
            }
          }
          return res.end();
        } catch (err) {
          if (playbackSignal?.aborted || res.destroyed) return;
          if (err instanceof AccountError) throw err;
          console.warn(`[Stream Engine Error for ${quality}]:`, err.message);
        }
      }


      // 如果解密引擎不可用且用户请求的是 720P，降级尝试官方 Web 端流
      if (seriesId) {
        try {
          const playback = await getOfficialWebPlayback(seriesId, episodeId);
          if (playback) {
            return await proxyWebVideo(req, res, playback);
          }
        } catch (err) {
          if (playbackSignal?.aborted || res.destroyed) return;
          console.warn("[Web Stream Fallback Error]:", err.message);
        }
      }

      return json(res, { error: "无法加载指定清晰度的视频媒体流" }, 502);
    }

    return json(res, { error: "404 Not Found" }, 404);
  } catch (err) {
    if (playbackSignal?.aborted || res.destroyed) return;
    const failure = publicFailure(err);
    if (!(err instanceof AccountError)) console.error('[接口处理失败]:', err?.message || String(err));
    if (res.headersSent) { res.destroy(); return; }
    if (failure.status === 429) res.setHeader('Retry-After', String(err.retryAfter || 1));
    return json(res, { error: failure.message }, failure.status);
  }
  };
  return withContentSignal(playbackSignal, handleRequest);
});

// HTTP头部尚未完整时也要有边界；正文时限兼容已有60秒上传分块读取。
server.headersTimeout = 15000;
server.requestTimeout = 65000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
server.maxConnections = positiveLimit(process.env, 'HTTP_MAX_CONNECTIONS', 512, 65536);
server.listen(PORT, process.env.HG_HOST || "0.0.0.0", () => {
  const actualPort = server.address().port;
  if (process.send) process.send({type:"ready",port:actualPort});
  console.log(`===============================================`);
  console.log(`🚀 红果本地服务已启动!`);
  console.log(`📡 监听地址: http://${process.env.HG_HOST || '0.0.0.0'}:${actualPort}`);
  console.log(`🎬 内容、推荐、分类、播放、本地资料与可选家庭同步`);
  console.log(`===============================================`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return; shuttingDown = true; librarySync.stop();
  for (const service of personalLibraries.values()) service.sync.stop();
  server.close(() => { for (const service of personalLibraries.values()) { service.library.close(); service.history.close(); } content.close(); trafficBudget.close(); accountStore.close(); libraryStore.close(); historyStore.close(); process.exit(0); });
  server.closeAllConnections();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
process.on("message", message => { if (message?.type === "shutdown") shutdown(); });
process.on("disconnect", () => { if (process.env.HG_MANAGED === "1") shutdown(); });
