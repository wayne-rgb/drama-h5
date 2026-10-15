import axios from "axios";
import { LibraryJournal } from "./library-journal.mjs";
import { accountRequest } from './account';
import { legacyOperations } from "@shared/legacy-migration.mjs";
import {
  RecommendationMode, RecommendationSignal,
  BannerItem,
  CategoryListResponse,
  CategoryTagsResponse,
  Detail,
  HistoryItem,
  RankGroup,
  RankPageResponse,
  RankTypeItem,
  Section,
  Series,
  Settings,
  VideoQualitiesResponse,
} from "./types";

const SETTINGS_KEY="hg_settings_v1";
export type PlaybackSource = { url: string; contentType: string; format: string; quality: string; version: string | null; expiresAt: number | null };
export type HistorySource="all"|"web"|"pc"|"tv";
export type SyncStatus={state:string;enabled:boolean;url:string;pending:number;lastSyncedAt:number|null;error:string};
let cache:{favorites:Series[];history:HistoryItem[];searchHistory:string[];recommendationSignals:RecommendationSignal[];preferences:{quality:string;speed:number;recommendationMode:RecommendationMode;recommendationResetAt:number};sync:SyncStatus}={favorites:[],history:[],searchHistory:[],recommendationSignals:[],preferences:{quality:"1080P",speed:1,recommendationMode:"mixed",recommendationResetAt:0},sync:{state:"unconfigured",enabled:false,url:"",pending:0,lastSyncedAt:null,error:""}};
let clockOffset=0;
let activeHistory:Series|null=null;
let refreshInFlight:Promise<any>|null=null;
let migration:Promise<void>|null=null;
let auxiliaryRecommendationSession = "";
let libraryRevision=0,libraryVersion='';
let libraryPagination:Record<string,{next:string|null;count:number}>={};
const loadedPersonalPages=new Set<string>();
export function getPersonalPagination(kind:'favorite'|'history'){return libraryPagination[kind]||{next:null,count:0};}
export async function loadPersonalPage(kind:'favorite'|'history'){
 const cursor=libraryPagination[kind]?.next;if(!cursor)return;
 const data=(await client().get('/api/library',{params:{kind,cursor}})).data,field=kind==='favorite'?'favorites':'history';
 const rows=kind==='favorite'?data.items:data.items.map((item:any)=>({...item,position:item.positionMs/1000,duration:item.durationMs/1000}));
 (cache as any)[field]=[...(cache as any)[field],...rows.filter((item:any)=>!(cache as any)[field].some((existing:any)=>(existing.id||existing.seriesId)===(item.id||item.seriesId)))];
 libraryPagination[kind]={next:(cache as any)[field].length>=data.count?null:data.next,count:data.count};loadedPersonalPages.add(kind);window.dispatchEvent(new CustomEvent('library-updated'));
}
const migrationOnly=new URLSearchParams(window.location.search).has("__legacy_migration");
function rawClient(){const instance=axios.create({baseURL:window.location.protocol==="file:"?(getSettings().baseUrl||"http://127.0.0.1:8788").replace(/\/+$/,""):"",timeout:15000,withCredentials:window.location.protocol!=="file:"});instance.interceptors.response.use(response=>response,error=>{if(error.response?.status===409&&error.response?.data?.error==="登录状态已变化，请刷新页面")window.location.reload();return Promise.reject(error);});return instance;}
let libraryOwner="guest";
let identityReady:Promise<void>|null=null;
let identityKnown=false;
function createJournal(owner:string){return new LibraryJournal(localStorage,owner==="guest"||owner.startsWith('guest:')?window.location.origin:`${window.location.origin}:account:${owner}`,async operation=>{await rawClient().post("/api/library/operations",operation,{headers:{"X-Library-Owner":owner}});});}
async function ensureLibraryIdentity(){
 if(!identityReady)identityReady=(async()=>{
  const data=await accountRequest('/api/account/session');
  libraryOwner=data.libraryOwner||data.user?.id||"guest";
  journal=createJournal(libraryOwner); identityKnown=true;
  try{localStorage.setItem("hg_account_owner",libraryOwner);}catch{}
 })().catch(error=>{identityReady=null;throw error;});
 return identityReady;
}
function client(){
 const instance=rawClient();
 instance.interceptors.request.use(async request=>{if(/^\/api\/(library|history|recommend)(?:\/|\?|$)/.test(request.url||"")){await ensureLibraryIdentity();request.headers["X-Library-Owner"]=libraryOwner;}return request;});
 return instance;
}
export async function flushPersonalLibrary(){await ensureLibraryIdentity();await journal.flush(true);}
function warning(error:any){window.dispatchEvent(new CustomEvent("history-storage-error",{detail:error?.message||"本地记录保存失败，请检查服务和存储空间"}));}
let journal=createJournal("guest");
function operation(kind:string,key:string,op:string,value:any=null,force=false){try{if(!identityKnown)throw Error("个人资料正在加载，请稍后重试");journal.save({kind,key,op,value,at:Math.round(Date.now()+clockOffset)});void journal.flush(force).catch(warning);return true;}catch(error){warning(error);return false;}}
export function getSettings():Settings{try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||"null")||{baseUrl:"http://127.0.0.1:8788",token:""};}catch{return{baseUrl:"http://127.0.0.1:8788",token:""};}}
export function saveSettings(value:Settings){localStorage.setItem(SETTINGS_KEY,JSON.stringify(value));}
export function getFavorites():Series[]{return cache.favorites;}
export function toggleFavorite(series:Series):boolean{const exists=cache.favorites.some(item=>item.id===series.id);cache.favorites=exists?cache.favorites.filter(item=>item.id!==series.id):[series,...cache.favorites];operation("favorite",series.id,exists?"delete":"set",exists?null:series);return !exists;}
export function getSearchHistory():string[]{return cache.searchHistory;}
export function saveSearchHistory(query:string):string[]{query=query.trim();if(query){cache.searchHistory=[query,...cache.searchHistory.filter(item=>item.toLowerCase()!==query.toLowerCase())].slice(0,10);operation("search",query.toLowerCase(),"set",{query});}return cache.searchHistory;}
export function removeSearchHistory(query:string):string[]{cache.searchHistory=cache.searchHistory.filter(item=>item!==query);operation("search",query.trim().toLowerCase(),"delete");return cache.searchHistory;}
export function clearSearchHistory(){cache.searchHistory=[];operation("search","*","clear");}
export function getPlaybackPreferences(){return cache.preferences;}
export function savePlaybackPreference(key:"quality"|"speed"|"recommendationMode"|"recommendationResetAt",value:string|number){cache.preferences={...cache.preferences,[key]:value};operation("preference",key,"set",{value});}
export function saveRecommendationSignal(key:string,value:RecommendationSignal){
 if (!["real-drama","comic-drama","ai-drama"].includes(value.contentType)) return;
 return operation("recommendation",key,"set",value);
}
export function resetRecommendationPreferences(){savePlaybackPreference("recommendationResetAt",Math.round(Date.now()+clockOffset));}
export function getProgress(id:string):HistoryItem|null{return cache.history.find(item=>item.seriesId===id)||null;}
export function beginHistory(series:Series,progress?:HistoryItem|null){activeHistory=series;if(progress)cache.history=[progress,...cache.history.filter(item=>item.seriesId!==series.id)];}
export function saveProgress(seriesId:string,episodeId:string,position:number,extra?:{title?:string;cover?:string;badge?:string;tags?:string;episodeNumber?:number;duration?:number;completed?:boolean}){
 if(!activeHistory||activeHistory.id!==seriesId||!episodeId)return;
 const item={seriesId,...(activeHistory.contentType?{contentType:activeHistory.contentType}:{}),title:extra?.title||activeHistory.title,cover:extra?.cover||activeHistory.cover,badge:extra?.badge||activeHistory.badge,tags:extra?.tags||activeHistory.tags,description:activeHistory.description,episodeId,episodeNumber:extra?.episodeNumber||1,position,duration:extra?.duration||0,completed:!!extra?.completed,updatedAt:Math.round(Date.now()+clockOffset)};
 const previous=getProgress(seriesId);
 if(previous&&Object.entries(item).every(([key,value])=>key==='updatedAt'||(previous as any)[key]===value))return;
 const force=!previous||previous.episodeId!==episodeId||item.completed||position<previous.position||position-previous.position>Math.max(3,(item.updatedAt-previous.updatedAt)/1000*4+1);
 cache.history=[item,...cache.history.filter(row=>row.seriesId!==seriesId)];
 operation("history",seriesId,"set",{...item,positionMs:Math.max(0,Math.round(position*1000)),durationMs:Number.isFinite(item.duration)?Math.max(0,Math.round(item.duration*1000)):0},force);
}
async function migrate(){if(migration)return migration;const keys=["hg_favorites_v1","hg_progress_v1","hg_search_history_v1","hg_pref_quality","hg_playback_speed",...Object.keys(localStorage).filter(key=>key.startsWith("hg_history_outbox_v1:")).sort()];const raw=Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)]));if(!Object.values(raw).some(value=>value!==null))return;
 migration=(async()=>{
  const operations=legacyOperations(raw),migrationId=localStorage.getItem("hg_library_migration_id")||journal.uuid();
  localStorage.setItem("hg_library_migration_id",migrationId);
  // 每次请求只提交有界批次；全部成功后才清理原始资料，失败可从原批次安全重试。
  for(let offset=0;;){
   let end=offset,bytes=1024;
   while(end<operations.length&&end-offset<256){
    const size=new TextEncoder().encode(JSON.stringify(operations[end])).byteLength+1;
    if(end>offset&&bytes+size>1024*1024)break;
    bytes+=size;end++;
   }
   await client().post("/api/library/import",{migrationId,offset,total:operations.length,operations:operations.slice(offset,end)});
   if(end>=operations.length)break;
   offset=end;
  }
  for(const key of keys)if(localStorage.getItem(key)===raw[key])localStorage.removeItem(key);
 })();try{await migration;}finally{migration=null;}}
export async function refreshLibrary(){if(refreshInFlight)return refreshInFlight;refreshInFlight=(async()=>{await ensureLibraryIdentity();if(libraryOwner==="guest"||libraryOwner.startsWith('guest:'))await migrate();await journal.flush();const started=Date.now();const data=(await client().get("/api/library",{params:libraryVersion?{since:libraryRevision,version:libraryVersion}:{}})).data;clockOffset=(data.serverTime||Date.now())-(started+Date.now())/2;
 if(!data.unchanged){
  const old=cache;cache={...data,recommendationSignals:data.recommendationSignals||[],preferences:{quality:"1080P",speed:1,recommendationMode:"mixed",recommendationResetAt:0,...data.preferences},history:(data.history||[]).map((item:any)=>({...item,position:item.positionMs/1000,duration:item.durationMs/1000}))};
  if(data.reset)loadedPersonalPages.clear();
  else for(const [kind,field,id] of [['favorite','favorites','id'],['history','history','seriesId'],['recommendation','recommendationSignals','seriesId']] as const){
   const retained=(old[field] as any[]).filter(item=>(loadedPersonalPages.has(kind)||kind==='favorite'&&item.id===activeHistory?.id)&&!(data.changes||[]).some((event:any)=>event.kind===kind&&(event.op==='clear'||event.op==='delete'&&event.key===item[id])&&event.at>=item.updatedAt));
   (cache as any)[field]=[...cache[field],...retained.filter(item=>!cache[field].some((row:any)=>kind==='recommendation'?row.seriesId===item.seriesId&&row.sessionId===item.sessionId:row[id]===item[id]))];
  }
  for(const [kind,page] of Object.entries(data.pagination||{}) as any){
   const field=kind==='favorite'?'favorites':kind==='history'?'history':'recommendationSignals',previous=libraryPagination[kind];
   const moved=(data.changes||[]).some((event:any)=>event.kind===kind&&(event.op==='clear'||event.op==='set'&&!(old[field] as any[]).some(row=>(kind==='favorite'?row.id:kind==='history'?row.seriesId:`${row.sessionId}:${row.seriesId}`)===event.key)));
   const next=loadedPersonalPages.has(kind)&&previous?.count===page.count&&!moved?previous.next:page.next;
   libraryPagination[kind]={...page,next:(cache as any)[field].length>=page.count?null:next};
  }
 }
 cache.sync=data.sync||cache.sync;libraryRevision=data.revision;libraryVersion=data.version;
 // 尚未上传的真实本地进度不能被轮询返回的旧值覆盖。
 for(const {event} of journal.entries())if(event.kind==='history'){
  const newer=cache.history.filter(item=>item.updatedAt>event.at);
  if(event.op==='clear')cache.history=newer;
  else if(!newer.some(item=>item.seriesId===event.key)){
   cache.history=cache.history.filter(item=>item.seriesId!==event.key);
   if(event.op==='set')cache.history.unshift({...event.value,updatedAt:event.at,position:event.value.positionMs/1000,duration:event.value.durationMs/1000});
  }
 }
 window.dispatchEvent(new CustomEvent("library-updated"));return cache;})();try{return await refreshInFlight;}finally{refreshInFlight=null;}}
export async function commitRecommendationPreferences(){
 await ensureLibraryIdentity();
 const deadline=Date.now()+15000;
 while(journal.entries().length){await journal.flush();if(Date.now()>deadline)throw Error("推荐偏好尚未保存，请重试");}
 if(refreshInFlight)await refreshInFlight;
 return (await refreshLibrary()).preferences;
}
export async function getServerProgress(id:string):Promise<HistoryItem|null>{await ensureLibraryIdentity();await journal.flush(true);const data=(await client().get('/api/library',{params:{seriesId:id}})).data;const item=data.item?{...data.item,position:data.item.positionMs/1000,duration:data.item.durationMs/1000}:null;if(data.favorite&&!cache.favorites.some(row=>row.id===id))cache.favorites.unshift(data.favorite);const local=getProgress(id),pending=journal.entries().some(({event}:any)=>event.kind==='history'&&event.key===id&&event.op==='set');if(local&&(pending||item&&local.updatedAt>item.updatedAt))return local;cache.history=[...(item?[item]:[]),...cache.history.filter(row=>row.seriesId!==id)];window.dispatchEvent(new CustomEvent('library-updated'));return item;}
export async function getHistoryList(_source:HistorySource="all"):Promise<HistoryItem[]>{await refreshLibrary();return cache.history;}
export async function removeHistoryItem(id:string,_source:HistorySource="all"){operation("history",id,"delete");await journal.flush();await refreshLibrary();}
export async function clearHistory(_source:HistorySource="all"){operation("history","*","clear");await journal.flush();await refreshLibrary();}
export function getSyncStatus(){return cache.sync;}
export async function configureSync(url:string,key:string,enabled=true){const data=(await client().post("/api/library/sync",enabled?{url,key}:{enabled:false})).data;cache.sync=data;await refreshLibrary();return data;}
if(!migrationOnly){setInterval(()=>void refreshLibrary().catch(()=>{}),1000);window.addEventListener("online",()=>void refreshLibrary().catch(warning));window.addEventListener("storage",event=>{if(identityKnown&&event.key==="hg_account_owner"&&event.newValue&&event.newValue!==libraryOwner)window.location.reload();});}

export const api = {
  // 首页先显示真实自有内容，再补齐后台完成的外部专区。
  async getHomeSnapshot(): Promise<{ banners: BannerItem[]; sections: Section[]; backgroundPending: boolean }> {
    const [banners, sections] = await Promise.all([client().get("/api/banners"), client().get("/api/sections")]);
    return { banners: banners.data?.banners || [], sections: sections.data?.sections || [], backgroundPending: !!(banners.data?.backgroundPending || sections.data?.backgroundPending) };
  },
  // 1. 官方首页大轮播 Banner
  async getBanners(): Promise<BannerItem[]> {
    const res = await client().get("/api/banners");
    return res.data?.banners || [];
  },

  // 2. 官方四大分类专区 (热播短剧 / 真人剧 / 漫剧 / AI剧)
  async getSections(): Promise<Section[]> {
    const res = await client().get("/api/sections");
    return res.data?.sections || [];
  },

  // 3. 官方分类标签池 (三大类型与 24 种官方题材)
  async getCategoryTags(type = "real-drama"): Promise<CategoryTagsResponse> {
    const res = await client().get("/api/category/tags",{params:{type}});
    return res.data;
  },

  // 4. 官方分类短剧列表 (支持类型/题材/分页)
  async getCategoryList(
    type = "real-drama",
    tag = "",
    page = 1
  ): Promise<CategoryListResponse> {
    const res = await client().get(
      `/api/category/list?type=${encodeURIComponent(type)}&tag=${encodeURIComponent(
        tag
      )}&page=${page}`
    );
    return res.data;
  },

  // 5. 官方排行榜分类选项
  async getRankTypes(): Promise<RankTypeItem[]> {
    const res = await client().get("/api/rank/types");
    return res.data?.types || [];
  },

  // 5.1 官方排行榜分页列表 (支持 4 大榜单，1~5 页，前 100 名)
  async getRankPageList(slug = "hot-drama", page = 1): Promise<RankPageResponse> {
    const res = await client().get(
      `/api/rank/list?type=${encodeURIComponent(slug)}&page=${page}`
    );
    return res.data;
  },

  // 5.2 兼容旧版全量四大排行榜 (获取首页 Top 9 集合)
  async getRanks(): Promise<RankGroup[]> {
    const res = await client().get("/api/ranks");
    return res.data?.ranks || [];
  },

  // 6. 搜索短剧
  async search(keyword: string, page = 1): Promise<{ items: Series[]; page: number }> {
    const res = await client().get(
      `/api/search?q=${encodeURIComponent(keyword)}&page=${page}`
    );
    return res.data;
  },

  // 6.1 沉浸式流推荐接口 (GET /api/recommend?page=N)
  async getRecommendStream(page = 1, session: string, signal?: AbortSignal): Promise<{ items: Series[]; page: number; session: string }> {
    await ensureLibraryIdentity();
    await journal.flush();
    const res = await client().get(`/api/recommend?page=${page}&session=${encodeURIComponent(session)}`, {signal});
    return res.data;
  },

  // 7. 获取剧集与选集详情
  async getSeries(id: string): Promise<Detail> {
    const res = await client().get(`/api/series/${id}`);
    return res.data;
  },

  // 8. 获取官方实时画质清晰度列表 (仅提供真实可播放的官方流)
  async getVideoQualities(episodeId: string, seriesId?: string): Promise<VideoQualitiesResponse> {
    const sParam = seriesId ? `?seriesId=${encodeURIComponent(seriesId)}` : "";
    const res = await client().get(`/api/episodes/${episodeId}/qualities${sParam}`);
    return res.data;
  },

  // 9. 视频流播放直链 (支持指定清晰度画质与短剧关联)
  async getPlaybackSource(episodeId: string, quality: string, seriesId: string, signal?: AbortSignal): Promise<PlaybackSource> {
    const response = await client().get(`/api/episodes/${encodeURIComponent(episodeId)}/play`, { params: { quality, seriesId }, signal });
    const data = response.data;
    const value = data?.url || data?.path;
    if (typeof value !== 'string' || !value || data.contentType !== 'video/mp4' || data.format && data.format !== 'mp4') throw Error('当前剧集没有可用的视频源，请稍后重试');
    const base = window.location.protocol === 'file:' ? getSettings().baseUrl.replace(/\/+$/, '') + '/' : window.location.href;
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('当前剧集没有可用的视频源，请稍后重试');
    return { url: url.href, contentType: data.contentType, format: data.format || 'mp4', quality: data.quality || quality, version: data.version || null, expiresAt: data.expiresAt ?? null };
  },

  // 旧版调用保留同站入口；新播放器从播放接口获取资源。
  getVideoStreamUrl(episodeId: string, quality?: string, seriesId?: string): string {
    const params=new URLSearchParams();if(quality)params.set("quality",quality);if(seriesId)params.set("seriesId",seriesId);
    const base=window.location.protocol==="file:"?getSettings().baseUrl.replace(/\/+$/,""):"";
    return `${base}/api/episodes/${encodeURIComponent(episodeId)}/stream?${params}`;
  },

  // 10. 全库个性化算法推荐流 (瀑布流 / 猜你喜欢)
  async getRecommend(page = 1): Promise<{ items: Series[]; page: number }> {
    if (page === 1 || !auxiliaryRecommendationSession) auxiliaryRecommendationSession = journal.uuid();
    const res = await client().get(`/api/recommend?page=${page}&session=${encodeURIComponent(auxiliaryRecommendationSession)}`);
    return res.data;
  },

  // 11. 单剧同类相关推荐 (播放页/详情页猜你喜欢，支持按页换一批)
  async getRelatedSeries(
    seriesId: string,
    limit = 16,
    page = 1
  ): Promise<{ seriesId: string; keyword: string; items: Series[]; page?: number }> {
    const res = await client().get(
      `/api/series/${seriesId}/related?limit=${limit}&page=${page}`
    );
    return res.data;
  },

  // 12. 智能聚合当前短剧的同系列多季列表 (第1季、第2季、第3季...)
  async getSeriesSeasons(series: Series): Promise<import("@shared/types").SeasonInfo[]> {
    try {
      const { parseSeasonInfo, matchAndSortSeasons } = await import("@shared/utils");
      const info = parseSeasonInfo(series.title);
      // 用系列主剧名在全库进行同名检索
      const res = await this.search(info.baseTitle, 1);
      const candidates = res.items || [];
      return matchAndSortSeasons(series, candidates);
    } catch {
      return [{
        seriesId: String(series.id),
        title: series.title,
        seasonNumber: 1,
        seasonLabel: "第1季",
        cover: series.cover,
        badge: series.badge,
        isCurrent: true
      }];
    }
  },
};

