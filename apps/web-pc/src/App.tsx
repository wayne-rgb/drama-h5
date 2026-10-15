import React, { useState, useEffect, useRef } from "react";
import { useI18n, languages, translate, LocalizedMessage, MessageValues, Language } from "./i18n";
import { readPlaybackLocation, playbackLocation } from "./playback-location";
import { FullscreenWatch, PlayerActions, PlayerPanel, PlayerSideAction } from "./mobile-prototype/PlayerActions";
import { CategoryFilters } from "./mobile-prototype/CategoryFilters";
import { bindPlaybackLifecycle } from './playback-lifecycle.mjs';
import { toggleMediaFullscreen } from './playback-fullscreen.mjs';
import { useMobileLayout } from "./use-mobile-layout";
import { AccountDialogs, AccountHome, AccountMenu, AccountPanel, useAccountSession } from "./AccountArea";
import "./account.css";
import { EpisodeInteractions, VipGate } from "./EpisodeInteractions";
import { LikedEpisodes, useLikeCount } from "./LikedEpisodes";
import { historyUuid } from "./history-outbox.mjs";
import { RecommendationSession, RecommendationWatch, bindRecommendationPlayback } from "./recommendation-session.mjs";
import { useContentAnalytics } from './use-content-analytics';
import { usePlaybackSource } from './use-playback-source';
import { 
  api,
  saveRecommendationSignal, resetRecommendationPreferences, commitRecommendationPreferences,
  getFavorites, 
  toggleFavorite, 
  getProgress,
  getServerProgress,
  beginHistory,
  saveProgress, 
  flushPersonalLibrary,
  getPersonalPagination,
  loadPersonalPage,
  getHistoryList,
  removeHistoryItem,
  clearHistory,
  getSearchHistory,
  saveSearchHistory,
  removeSearchHistory,
  clearSearchHistory,
  getSettings, 
  saveSettings, getPlaybackPreferences, savePlaybackPreference, getSyncStatus, configureSync, refreshLibrary
} from "./api";
import { 
  BannerItem, 
  CategoryTag, 
  CategoryType, 
  Detail, 
  Episode, 
  RankItem, 
  RankTypeItem, 
  Section, 
  Series, RecommendationMode, 
  Settings,
  VideoQualityItem,
  SeasonInfo,
  HistoryItem
} from "./types";
import { 
  Play, 
  Pause,
  Search, 
  Heart, 
  ThumbsUp,
  Settings as SettingsIcon, 
  Sparkles, 
  ArrowLeft, 
  ChevronRight, 
  ChevronLeft, 
  Film, 
  Flame, 
  ChevronDown,
  ChevronUp,
  UserCheck, 
  Palette, 
  Bot, 
  Grid, 
  Trophy, 
  Crown, 
  RefreshCw, 
  Compass,
  Star,
  Maximize,
  Minimize,
  Volume2,
  VolumeX,
  Gauge,
  Check,
  RotateCcw,
  Sliders,
  HelpCircle,
  X,
  Layers,
  Clock,
  Trash2,
  Tag,
  Tv
} from "lucide-react";

const playbackFailure = (error:any) => error?.response?.data?.error === 'VIP_REQUIRED' ? 'VIP_REQUIRED' : error?.isAxiosError && !error.response ? '网络连接中断，请检查网络后重试' : '当前剧集没有可用的视频源，请稍后重试';

export default function App({ mobilePrototype: forceMobileLayout }: { mobilePrototype?: boolean } = {}) {
  const mobilePrototype = useMobileLayout(forceMobileLayout);
  const accountState = useAccountSession();
  const hasVipAccess = !!accountState.session?.user?.membership.active || !!accountState.session?.capabilities.admin;
  const [accountPanel, setAccountPanel] = useState<AccountPanel>(() => { const panel = new URLSearchParams(window.location.search).get("account"); return ["login", "register", "recover", "reset", "verify", "profile", "membership"].includes(panel || "") ? panel as AccountPanel : null; });
  const { language, t, localizeLabel, localizeError, setLanguage, formatDate } = useI18n();
  const [languageSaved, setLanguageSaved] = useState(true);
  const changeLanguage = (value: string) => {
    if (languages.some(item => item.id === value)) setLanguageSaved(setLanguage(value as Language));
  };
  // 顶层主标签：首页 | 推荐刷剧 | 分类 | 榜单 | 搜索 | 追剧 | 设置
  // 有播放链接时先加载目标剧集，不能在等待期间播放推荐并产生无关历史。
  const [tab, setTabState] = useState<"home" | "recommend" | "category" | "rank" | "search" | "favorites" | "settings">(readPlaybackLocation(window.location.href).seriesId ? 'home' : accountPanel ? "favorites" : mobilePrototype ? "recommend" : "home");

  // 1. 首页状态
  const [selectedHomeSection, setSelectedHomeSection] = useState<string>("all");
  const [banners, setBanners] = useState<BannerItem[]>([]);
  const [activeBannerIndex, setActiveBannerIndex] = useState(0);
  const [sections, setSections] = useState<Section[]>([]);

  // 2. 分类状态 (对应官方 category/real-drama)
  const [categoryTypes, setCategoryTypes] = useState<CategoryType[]>([
    { id: "real-drama", name: "真人剧" },
    { id: "comic-drama", name: "漫剧" },
    { id: "ai-drama", name: "AI剧" },
  ]);
  const [categoryTags, setCategoryTags] = useState<CategoryTag[]>([]);
  const categoryTagsRequest=useRef(0);
  const categoryTagsRetry=useRef<ReturnType<typeof setTimeout> | null>(null);
  const categoryListRequest=useRef(0);
  const categoryListRetry=useRef<ReturnType<typeof setTimeout> | null>(null);
  const homeRequest=useRef(0);
  const homeRetry=useRef<ReturnType<typeof setTimeout> | null>(null);
  const [categoryTagsLoading,setCategoryTagsLoading]=useState(false);
  const [categoryError,setCategoryError]=useState("");
  const [categoryTotalPages,setCategoryTotalPages]=useState(0);
  const [selectedCatType, setSelectedCatType] = useState<string>("real-drama");
  const [selectedCatTag, setSelectedCatTag] = useState<string>("");
  const [categoryItems, setCategoryItems] = useState<Series[]>([]);
  const [catPage, setCatPage] = useState<number>(1);
  const [catLoading, setCatLoading] = useState(false);

  // 3. 官方榜单状态 (对应图一官方横幅与 4 大子榜单，每页 20 部共 5 页 100 名)
  const [rankTypes, setRankTypes] = useState<RankTypeItem[]>([
    { slug: "hot-drama", name: "红果热播榜", key: "all" },
    { slug: "hot-real-drama", name: "真人剧热播榜", key: "real" },
    { slug: "hot-ai-drama", name: "AI剧热播榜", key: "ai" },
    { slug: "hot-comic-drama", name: "漫剧热播榜", key: "comic" },
  ]);
  const [selectedRankSlug, setSelectedRankSlug] = useState<string>("hot-drama");
  const [rankItems, setRankItems] = useState<RankItem[]>([]);
  const [rankPage, setRankPage] = useState<number>(1);
  const [rankTotalPages, setRankTotalPages] = useState<number>(5);
  const [rankLoading, setRankLoading] = useState(false);

  // 4. 搜索状态 (任务 06: 热搜榜、搜索历史、实时输入联想、题材快筛)
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Series[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchHistoryList, setSearchHistoryList] = useState<string[]>([]);
  const [searchSuggestions, setSearchSuggestions] = useState<Series[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [searchFilterTag, setSearchFilterTag] = useState<string>("全部");
  const [searchLoading, setSearchLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const suggestTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 热门搜索推荐词 (基于官方热榜与爆款关键词)
  const hotSearchKeywords = [
    "太奶奶",
    "反向拿捏",
    "逆袭",
    "重生",
    "神豪",
    "战神",
    "甜宠",
    "穿越",
    "霸总",
    "白月光"
  ];

  // 搜索快筛标签
  const searchFilterTags = ["全部", "真人", "漫剧", "AI剧", "逆袭", "甜宠", "重生", "都市", "古装"];

  // 🌟 4.1 沉浸式刷剧流状态 (任务 07: PC滚轮/上下键 + 9:16竖屏大流容器 + 随刷随播)
  const [streamList, setStreamList] = useState<Series[]>([]);
  const [streamIndex, setStreamIndex] = useState(0);
  const [streamPage, setStreamPage] = useState(1);
  const [streamLoading, setStreamLoading] = useState(false);
  const [streamError, setStreamError] = useState("");
  const [streamPlaybackAttempt, setStreamPlaybackAttempt] = useState(0);
  const [streamBuffering, setStreamBuffering] = useState(false);
  const [recommendationMode, setRecommendationMode] = useState<RecommendationMode>(getPlaybackPreferences().recommendationMode);
  const [showRecommendationResetConfirm, setShowRecommendationResetConfirm] = useState(false);
  const streamFeedRef = useRef<any>(null);
  const streamWatchRef = useRef<any>(null);
  const detailWatchRef = useRef<any>(null);
  const streamDetailLoaderRef = useRef<any>(null);
  const streamStartRequest = useRef(0);
  const recommendationSignalEpoch = useRef({feed: "", session: "", resetAt: getPlaybackPreferences().recommendationResetAt});
  const [streamCurrentEpisode, setStreamCurrentEpisode] = useState<Episode | null>(null);
  const [streamDetail, setStreamDetail] = useState<Detail | null>(null);
  const [streamDetailLoading, setStreamDetailLoading] = useState(false);
  const [streamIsPlaying, setStreamIsPlaying] = useState(true);
  const [streamCurrentTime, setStreamCurrentTime] = useState(0);
  const [streamDuration, setStreamDuration] = useState(0);
  const [streamDescriptionExpanded, setStreamDescriptionExpanded] = useState(false);
  const [streamVideoFit, setStreamVideoFit] = useState<"contain" | "cover">("contain");
  const [streamIsLandscape, setStreamIsLandscape] = useState<boolean>(false);
  const [streamEpisodeIndex, setStreamEpisodeIndex] = useState<number>(0);
  const [streamPlaybackSpeed, setStreamPlaybackSpeed] = useState<number>(1.0);
  const [streamShowSpeedMenu, setStreamShowSpeedMenu] = useState<boolean>(false);
  const [streamQuality, setStreamQuality] = useState<string>("1080P");
  const [streamShowQualityMenu, setStreamShowQualityMenu] = useState<boolean>(false);
  const [streamQualities, setStreamQualities] = useState<VideoQualityItem[]>([]);
  const [streamQualitiesLoading, setStreamQualitiesLoading] = useState<boolean>(false);
  const [streamQualityEpisodeId, setStreamQualityEpisodeId] = useState("");
  const [streamIsDraggingProgress, setStreamIsDraggingProgress] = useState<boolean>(false);
  const streamQualitySwitchTimeRef = useRef<number | null>(null);
  const streamVideoRef = useRef<HTMLVideoElement>(null);
  const streamWheelLockRef = useRef(false);
  const streamGestureRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const suppressStreamClickUntil = useRef(0);
  const detailGestureRef = useRef<{ x: number; y: number; at: number; episodeId?: string } | null>(null);
  const suppressDetailClickUntil = useRef(0);
  const [streamInfoOpen, setStreamInfoOpen] = useState(false);
  const [mobileDetailInfoOpen, setMobileDetailInfoOpen] = useState(false);
  const [mobileEpisodesOpen, setMobileEpisodesOpen] = useState(false);
  const [mobileRelatedOpen, setMobileRelatedOpen] = useState(false);
  const [mobileDetailLandscape, setMobileDetailLandscape] = useState(false);
  const [streamMuted, setStreamMuted] = useState(false);
  const [streamVolume, setStreamVolume] = useState(1);
  const streamPlayerContainerRef = useRef<HTMLDivElement>(null);
  const mobileSearchOrigin = useRef<{ tab: "recommend" | "category"; series: Detail | null; episodeId?: string }>({ tab: "recommend", series: null });

  // 5. 播放器与画质倍速控制状态
  const [activeSeries, setActiveSeriesState] = useState<Detail | null>(null);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);
  const [favorites, setFavorites] = useState<Series[]>([]);
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [personalPageBusy,setPersonalPageBusy]=useState(false);
  const [historyStorageWarning, setHistoryStorageWarning] = useState("");
  const historyRequest = useRef(0);
  const detailRequest = useRef(0);
  const streamDetailRequest = useRef(0);
  const navigationGeneration = useRef(0);
  const invalidatePlaybackRequests = () => {
    detailRequest.current++; streamDetailRequest.current++; navigationGeneration.current++;
    streamFeedRef.current?.cancel(); streamWatchRef.current?.leave(); detailWatchRef.current?.leave();
    setLoading(false); setStreamDetailLoading(false);
  };
  const setTab = (next: typeof tab) => { invalidatePlaybackRequests(); setTabState(next); };
  const setActiveSeries = (next: Detail | null) => {
    if (!next) {
      invalidatePlaybackRequests();
      window.history.replaceState(null, "", playbackLocation(window.location.href));
    }
    setActiveSeriesState(next);
  };
  const openSeriesRef = useRef<typeof handleSelectSeries>();
  useEffect(() => () => { detailRequest.current++; streamDetailRequest.current++; navigationGeneration.current++; }, []);

  const [favSubTab, setFavSubTab] = useState<"overview" | "favorites" | "history" | "likes" | "settings">("overview");
  // 手机端默认直接展示追剧内容，桌面继续使用个人概览。
  const personalContentTab = mobilePrototype && favSubTab === 'overview' ? 'favorites' : favSubTab;
  const mainContentRef = useRef<HTMLElement>(null);
  const personalSettingsReturn = useRef<{ section: 'favorites' | 'history' | 'likes'; scrollTop: number }>({ section: 'favorites', scrollTop: 0 });
  const restorePersonalScroll = useRef(false);
  const mobileSettingsOpen = mobilePrototype && !activeSeries && (tab === 'settings' || tab === 'favorites' && favSubTab === 'settings');
  useEffect(() => {
    if (mobileSettingsOpen && mainContentRef.current) mainContentRef.current.scrollTop = 0;
    else if (restorePersonalScroll.current && mainContentRef.current) { mainContentRef.current.scrollTop = personalSettingsReturn.current.scrollTop; restorePersonalScroll.current = false; }
  }, [mobileSettingsOpen]);
  const likesCount = useLikeCount(accountState.session?.user?.id, `${tab}:${favSubTab}:${!!activeSeries}`);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [syncStatus, setSyncStatus] = useState(getSyncStatus());
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteKey, setRemoteKey] = useState("");
  const [syncSaving, setSyncSaving] = useState(false);
  const remoteUrlTouched = useRef(false);
  const [toast, setToast] = useState<LocalizedMessage | null>(null);
  const [loading, setLoading] = useState(false);
  if (!detailWatchRef.current) detailWatchRef.current = new RecommendationWatch(saveRecommendationSignal);
  if (!streamWatchRef.current) streamWatchRef.current = new RecommendationWatch(saveRecommendationSignal);
  if (!streamFeedRef.current) streamFeedRef.current = new RecommendationSession(
    (page: number, session: string, signal: AbortSignal) => api.getRecommendStream(page, session, signal),
    undefined,
    (state: any) => {setStreamList(state.items);setStreamIndex(state.index);setStreamPage(state.page);setStreamLoading(state.loading);setStreamError(state.error);},
    (series: Series, session: string, reason?: string) => {streamWatchRef.current.leave(reason);beginRecommendationExposure(series, session);void streamDetailLoaderRef.current?.(series);}
  );



  const beginRecommendationExposure = (series: Series, session: string) => {
    const epoch = recommendationSignalEpoch.current, resetAt = getPlaybackPreferences().recommendationResetAt;
    if (epoch.feed !== session) {epoch.feed = session;epoch.session = session;epoch.resetAt = resetAt;}
    else if (epoch.resetAt !== resetAt) {streamWatchRef.current.discard();epoch.resetAt = resetAt;epoch.session = historyUuid();}
    streamWatchRef.current.begin(epoch.session, series);
  };

  // 官方真实画质清晰度状态
  const [videoQualities, setVideoQualities] = useState<VideoQualityItem[]>([]);
  const [currentQuality, setCurrentQuality] = useState<string>(() => {
    try {
      return getPlaybackPreferences().quality || "1080P";
    } catch {
      return "1080P";
    }
  });
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [qualitiesLoading, setQualitiesLoading] = useState(false);
  const [qualityEpisodeId, setQualityEpisodeId] = useState("");
  const [qualityRetry, setQualityRetry] = useState(0);

  // 🌟 同类好剧推荐状态 (任务 01: 猜你喜欢 & 任务 02: 换一批)
  const [relatedSeries, setRelatedSeries] = useState<Series[]>([]);
  const [relatedPool, setRelatedPool] = useState<Series[]>([]);
  const [relatedPage, setRelatedPage] = useState<number>(1);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedRefreshing, setRelatedRefreshing] = useState(false);
  const [refreshRotateDeg, setRefreshRotateDeg] = useState(0);
  const [relatedKeyword, setRelatedKeyword] = useState<string>("");
  const [recommendFadeIn, setRecommendFadeIn] = useState(true);

  // 🌟 全剧终「片尾推荐弹窗」状态 (任务 03)
  const [showSeriesEndModal, setShowSeriesEndModal] = useState(false);
  const [seriesEndCountdown, setSeriesEndCountdown] = useState(5);
  const [seriesEndTarget, setSeriesEndTarget] = useState<Series | null>(null);

  // 🌟 多季短剧状态 (任务 04: 智能季数识别与快速换季)
  const [seasonsList, setSeasonsList] = useState<SeasonInfo[]>([]);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | number | null>(null);
  const [seasonsLoading, setSeasonsLoading] = useState(false);

  // 选集区间状态 (每页 50 集，10 列 x 5 排)
  const [episodeRangeIndex, setEpisodeRangeIndex] = useState(0);
  const [showRangeDropdown, setShowRangeDropdown] = useState(false);

  // 播放倍速状态 (0.75x ~ 3.0x)

  const [playbackSpeed, setPlaybackSpeed] = useState<number>(() => {
    try {
      const saved = String(getPlaybackPreferences().speed);
      if (saved) return Number(saved);
    } catch {}
    return 1.0;
  });
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);

  // 播放器控制与交互状态
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [playbackBuffering, setPlaybackBuffering] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoPlayNext, setAutoPlayNext] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<NodeJS.Timeout | null>(null);
  const qualitySwitchTimeRef = useRef<number | null>(null);

  const currentEpisode: Episode | undefined = activeSeries?.episodes?.[currentEpisodeIndex];
  const detailSource = usePlaybackSource(activeSeries?.id, currentEpisode?.id, currentQuality,
    !!currentEpisode && qualityEpisodeId === currentEpisode.id && (currentEpisodeIndex < 3 || hasVipAccess), qualityRetry, accountState.session?.libraryOwner);
  const streamSource = usePlaybackSource(streamDetail?.id, streamCurrentEpisode?.id, streamQuality,
    tab === 'recommend' && !activeSeries && !!streamCurrentEpisode && streamQualityEpisodeId === streamCurrentEpisode.id && streamDetail?.id === streamList[streamIndex]?.id && (streamEpisodeIndex < 3 || hasVipAccess), streamPlaybackAttempt, accountState.session?.libraryOwner);
  useEffect(() => { if (detailSource.error) setPlaybackError(playbackFailure(detailSource.error)); }, [detailSource.error]);
  useEffect(() => { if (streamSource.error) setStreamError(playbackFailure(streamSource.error)); }, [streamSource.error]);


  const showToast = (key: string, values?: MessageValues) => {
    setToast({ key, values });
    setTimeout(() => setToast(null), 2500);
  };

  useEffect(() => {
    loadHomeData();
    loadCategoryTags();
    loadRankTypes();
    setFavorites(getFavorites());
    void refreshHistory();
    setSearchHistoryList(getSearchHistory());
    const location = readPlaybackLocation(window.location.href);
    if (location.seriesId) void openSeriesRef.current?.({ id: location.seriesId }, undefined, location.episodeId);
    const back = () => {
      const location = readPlaybackLocation(window.location.href);
      if (location.seriesId) void openSeriesRef.current?.({ id: location.seriesId }, undefined, location.episodeId);
      else setActiveSeries(null);
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  const refreshHistory = async () => {
    const request = ++historyRequest.current;
    try {
      const items = await getHistoryList();
      if (request === historyRequest.current) { setHistoryList(items); setHistoryError(""); }
    } catch { if (request === historyRequest.current) setHistoryError("历史记录服务不可用，待上传进度将在恢复连接后补传。"); }
  };
  useEffect(() => {
    if (tab !== "favorites" || activeSeries || favSubTab !== "history") return;
    void refreshHistory();
    const timer = setInterval(() => void refreshHistory(), 1000);
    return () => { clearInterval(timer); historyRequest.current++; };
  }, [favSubTab, tab, activeSeries]);
  useEffect(() => {
    const warning = (event: Event) => setHistoryStorageWarning((event as CustomEvent<string>).detail);
    window.addEventListener("history-storage-error", warning);
    return () => window.removeEventListener("history-storage-error", warning);
  }, []);

  useEffect(() => {
    const update = () => {
      const pref = getPlaybackPreferences();
      const epoch = recommendationSignalEpoch.current;
      if (epoch.resetAt !== pref.recommendationResetAt) {
        streamWatchRef.current.discard();detailWatchRef.current.discard();
        epoch.resetAt = pref.recommendationResetAt;epoch.session = historyUuid();
        const series = streamFeedRef.current.items[streamFeedRef.current.index];
        if (tab === "recommend" && !activeSeries && series && streamCurrentEpisode) streamWatchRef.current.begin(epoch.session, series);
        else if (activeSeries) detailWatchRef.current.begin(historyUuid(), activeSeries);
      }
      setRecommendationMode(pref.recommendationMode); setFavorites(getFavorites()); setSearchHistoryList(getSearchHistory()); const status=getSyncStatus(); setSyncStatus(status); if(!remoteUrlTouched.current)setRemoteUrl(status.url); if(!activeSeries && tab!=="recommend"){const pref=getPlaybackPreferences();setPlaybackSpeed(pref.speed);setCurrentQuality(pref.quality);} };
    window.addEventListener("library-updated", update); void refreshLibrary().then(update).catch(()=>{});
    return () => window.removeEventListener("library-updated", update);
  }, [activeSeries,tab,streamCurrentEpisode?.id]);
  useEffect(() => { if(!activeSeries && tab!=="recommend") {const preferences=getPlaybackPreferences();setPlaybackSpeed(preferences.speed);setCurrentQuality(preferences.quality);} }, [activeSeries,tab]);
  const refreshSearchHistory = () => {
    setSearchHistoryList(getSearchHistory());
  };

  // 轮播定时器
  useEffect(() => {
    if (banners.length <= 1) return;
    const timer = setInterval(() => {
      setActiveBannerIndex((prev) => (prev + 1) % banners.length);
    }, 6000);
    return () => clearInterval(timer);
  }, [banners]);

  // 分类筛选变动时加载
  useEffect(() => {
    if (tab === "category") {
      fetchCategoryList(selectedCatType, selectedCatTag, catPage);
    }
  }, [tab, selectedCatType, selectedCatTag, catPage]);
  useEffect(()=>{void loadCategoryTags(selectedCatType);},[selectedCatType]);

  // 榜单类型或页码变动时加载
  useEffect(() => {
    if (tab === "rank") {
      fetchRankList(selectedRankSlug, rankPage);
    }
  }, [tab, selectedRankSlug, rankPage]);

  useEffect(() => {
    if (tab !== "recommend" || activeSeries) return;
    const feed = streamFeedRef.current;
    if (feed.needsRestart(getPlaybackPreferences())) void loadStreamData(1, false);
    else if (feed.items[feed.index] && !streamWatchRef.current.active) void loadStreamDetail(feed.items[feed.index]);
  }, [tab, activeSeries]);
  useEffect(() => {
    const feed = streamFeedRef.current;
    if (tab === "recommend" && !activeSeries && feed.items.length && feed.index >= feed.items.length - 3 && !feed.exhausted) {
      void feed.load().catch(() => {});
    }
  }, [tab, activeSeries, streamIndex, streamList.length, streamPage]);
  useEffect(() => {
    const watch = streamWatchRef.current, video = streamVideoRef.current;
    if (tab !== "recommend" || activeSeries || !video) {watch.pause();return;}
    return bindRecommendationPlayback(video, watch);
  }, [tab, activeSeries, streamCurrentEpisode?.id, streamQuality, streamQualityEpisodeId, streamPlaybackAttempt, streamSource.source?.url]);

  // 🌟 PC端键盘上下键切剧 (仅在 recommend 标签且无主动播放弹窗时生效)
  useEffect(() => {
    if (tab !== "recommend" || activeSeries) return;

    const handleStreamKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        handleSwitchStream("prev");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleSwitchStream("next");
      } else if (e.key === " " || e.key === "k" || e.key === "K") {
        e.preventDefault();
        const video = streamVideoRef.current;
        if (video) {
          if (video.paused) {
            video.play().then(() => setStreamIsPlaying(true)).catch(() => setStreamIsPlaying(false));
          } else {
            video.pause();
            setStreamIsPlaying(false);
          }
        }
      }
    };

    window.addEventListener("keydown", handleStreamKeyDown);
    return () => window.removeEventListener("keydown", handleStreamKeyDown);
  }, [tab, activeSeries, streamIndex, streamList, streamPage]);

  // 加载首页基础数据
  const loadHomeData = async (attempt=0) => {
    const request=++homeRequest.current;
    if (homeRetry.current) clearTimeout(homeRetry.current);
    try {
      const data = await api.getHomeSnapshot();
      if (request!==homeRequest.current) return;
      setBanners(data.banners);
      setSections(data.sections);
      if (data.backgroundPending && attempt < 10) homeRetry.current=setTimeout(()=>{
        if (request===homeRequest.current) void loadHomeData(attempt+1);
      },1000);
    } catch {
      if (request===homeRequest.current && !attempt) showToast("获取首页数据失败，请确认服务端已启动");
    }
  };

  // 加载分类标签
  const loadCategoryTags = async (type="real-drama", attempt=0) => {
    const request=++categoryTagsRequest.current;
    if (categoryTagsRetry.current) clearTimeout(categoryTagsRetry.current);
    setCategoryTagsLoading(true);if (!attempt) setCategoryTags([]);
    try {
      const res = await api.getCategoryTags(type);
      if(request!==categoryTagsRequest.current)return;
      if (res.types && res.types.length > 0) setCategoryTypes(res.types);
      setCategoryTags(res.tags||[]);
      // 先展示自有题材，外部元数据完成后自动补齐，不让用户重复切换标签。
      if (res.backgroundPending && attempt < 10) categoryTagsRetry.current=setTimeout(()=>{
        if (request===categoryTagsRequest.current) void loadCategoryTags(type,attempt+1);
      },1000);
    } catch {
      if(request===categoryTagsRequest.current)setCategoryError("官网题材读取失败，请重试");
    } finally {
      if(request===categoryTagsRequest.current)setCategoryTagsLoading(false);
    }
  };

  // 页面卸载后取消目录补齐，旧请求不得覆盖新页面结果。
  useEffect(()=>()=>{
    categoryTagsRequest.current++;categoryListRequest.current++;homeRequest.current++;
    if(categoryTagsRetry.current)clearTimeout(categoryTagsRetry.current);
    if(categoryListRetry.current)clearTimeout(categoryListRetry.current);
    if(homeRetry.current)clearTimeout(homeRetry.current);
  },[]);

  // 加载榜单类别定义
  const loadRankTypes = async () => {
    try {
      const types = await api.getRankTypes();
      if (types && types.length > 0) setRankTypes(types);
    } catch {
      console.warn("加载榜单分类失败");
    }
  };

  // 请求分类短剧列表
  const fetchCategoryList = async (type: string, tag: string, page: number, attempt=0) => {
    const request=++categoryListRequest.current;
    if (categoryListRetry.current) clearTimeout(categoryListRetry.current);
    try {
      if (!attempt) {setCatLoading(true);setCategoryError("");setCategoryItems([]);}
      const res = await api.getCategoryList(type, tag, page);
      if(request!==categoryListRequest.current)return;
      setCategoryItems(res.items || []);
      setCategoryTotalPages(res.pagination?.totalPages||0);
      if (res.backgroundPending && attempt < 10) categoryListRetry.current=setTimeout(()=>{
        if (request===categoryListRequest.current) void fetchCategoryList(type,tag,page,attempt+1);
      },1000);
    } catch {
      if(request===categoryListRequest.current)setCategoryError("官网分类读取失败，请重试");
    } finally {
      if(request===categoryListRequest.current)setCatLoading(false);
    }
  };

  // 请求排行榜单分页列表 (1~5页，每页20部)
  const fetchRankList = async (slug: string, page: number) => {
    try {
      setRankLoading(true);
      const res = await api.getRankPageList(slug, page);
      setRankItems(res.items || []);
      setRankTotalPages(res.totalPages || 5);
    } catch {
      showToast("加载榜单列表失败");
    } finally {
      setRankLoading(false);
    }
  };

  const loadStreamData = async (targetPage = 1, append = false) => {
    try {
      if (append) await streamFeedRef.current.load(targetPage);
      else {
        const request=++streamStartRequest.current, generation=navigationGeneration.current;
        streamFeedRef.current.cancel();
        streamWatchRef.current.leave();streamVideoRef.current?.pause();
        streamDetailRequest.current++;
        setStreamCurrentEpisode(null);setStreamDetail(null);
        setStreamLoading(true);
        const preferences=await commitRecommendationPreferences();
        if(request!==streamStartRequest.current||generation!==navigationGeneration.current)return;
        await streamFeedRef.current.start(preferences);
      }
    } catch { setStreamLoading(false); setStreamError("推荐暂时不可用，请检查本地服务后重试"); }
  };

  // 加载当前刷剧项的详情与续播集数
  const loadStreamDetail = async (series: Series) => {
    if (!series) return;
    const request = ++streamDetailRequest.current;
    const session = streamFeedRef.current.id;
    streamWatchRef.current.pause();streamVideoRef.current?.pause();
    setStreamCurrentEpisode(null);setStreamDetail(null);
    setStreamQualityEpisodeId("");setStreamQualities([]);setStreamError("");
    setStreamEpisodeIndex(0);setStreamIsPlaying(false);
    setStreamShowQualityMenu(false);setStreamShowSpeedMenu(false);
    if (streamWatchRef.current.active?.value.seriesId !== series.id) beginRecommendationExposure(series, session);
    try {
      setStreamDetailLoading(true);
      setStreamDescriptionExpanded(false);
      if (mobilePrototype) setStreamInfoOpen(false);
      setStreamCurrentTime(0);
      setStreamDuration(0);
      setStreamIsLandscape(false);
      
      const detail = await api.getSeries(series.id);
      const progress = await getServerProgress(series.id).catch(() => null);

      if (request !== streamDetailRequest.current) return;
      detail.contentType = series.contentType || detail.contentType;
      setStreamDetail(detail);
      const savedIndex = detail.episodes?.findIndex(episode => episode.id === progress?.episodeId) ?? -1;
      const episodeIndex = savedIndex >= 0 ? progress?.completed ? (savedIndex + 1) % detail.episodes.length : savedIndex : 0;
      const ep = detail.episodes?.[episodeIndex] || null;
      const position = savedIndex >= 0 && !progress?.completed ? progress?.position || 0 : 0;
      beginHistory(detail, progress || undefined);
      setPlaybackSpeed(getPlaybackPreferences().speed);setStreamPlaybackSpeed(getPlaybackPreferences().speed);
      setStreamEpisodeIndex(episodeIndex);setStreamCurrentEpisode(ep);
      if (ep) saveProgress(series.id, ep.id, position, {title: detail.title, cover: detail.cover, badge: detail.badge, tags: detail.tags, episodeNumber: ep.number, duration: savedIndex >= 0 && !progress?.completed ? progress?.duration || 0 : 0});
      setStreamIsPlaying(false);streamQualitySwitchTimeRef.current = position;

    } catch (err) {
      if (request === streamDetailRequest.current) {setStreamError("剧集加载失败，请重试");console.warn("加载流剧集详情失败:", err);}
    } finally {
      if (request === streamDetailRequest.current) setStreamDetailLoading(false);
    }
  };

  streamDetailLoaderRef.current = loadStreamDetail;

  // 推荐流中无缝播放当前短剧的下一集
  useEffect(() => {
    if (!streamCurrentEpisode || !streamDetail) return;
    let active = true;
    setStreamQualityEpisodeId(""); setStreamQualities([]); setStreamQualitiesLoading(true);
    setStreamError(""); setStreamIsPlaying(false);
    setStreamBuffering(false);
    if (streamEpisodeIndex >= 3 && !hasVipAccess) { setStreamQualitiesLoading(false); return; }
    api.getVideoQualities(streamCurrentEpisode.id, streamDetail.id).then(response => {
      if (!active) return;
      if (!response.qualities?.length) throw new Error("视频画质不可用");
      const preferred = getPlaybackPreferences().quality;
      const quality = response.qualities.some(item => item.key === preferred) ? preferred : response.defaultQuality || response.qualities[0].key;
      setStreamQualities(response.qualities); setStreamQuality(quality);
      setStreamQualityEpisodeId(streamCurrentEpisode.id);
    }).catch(error => { if (active) setStreamError(playbackFailure(error)); })
      .finally(() => { if (active) setStreamQualitiesLoading(false); });
    return () => { active = false; };
  }, [streamCurrentEpisode?.id, streamDetail?.id, streamPlaybackAttempt, hasVipAccess]);

  const handleStreamNextEpisode = (automatic = false) => {
    if (!streamDetail || !streamDetail.episodes || streamDetail.episodes.length === 0) return;
    streamWatchRef.current.pause();
    const nextIdx = streamEpisodeIndex + 1;
    if (nextIdx < streamDetail.episodes.length) {
      const nextEp = streamDetail.episodes[nextIdx];
      streamQualitySwitchTimeRef.current = 0;
      setStreamEpisodeIndex(nextIdx);
      setStreamCurrentEpisode(nextEp);
      setStreamCurrentTime(0);
      setStreamDuration(0);
      setStreamIsPlaying(true);
      if (automatic) showToast("已自动连播：第{{number}}集", { number: nextEp.number || nextIdx + 1 });
    } else {
      // 当前短剧全集播放完毕，自动切到推荐流下一部短剧
      showToast("本剧已连播完毕，自动为您切换下一部精选短剧");
      if (automatic) streamWatchRef.current.complete();
      handleSwitchStream("next", automatic ? "automatic" : "manual");
    }
  };

  // 推荐流切换画质 (保持当前播放进度秒级续播)
  const handleStreamSelectQuality = (qKey: string) => {
    if (qKey === streamQuality) {
      setStreamShowQualityMenu(false);
      return;
    }
    const video = streamVideoRef.current;
    const prevTime = video ? video.currentTime : streamCurrentTime;
    const wasPaused = video ? video.paused : false;

    streamQualitySwitchTimeRef.current = prevTime;
    setStreamQuality(qKey);
    setStreamShowQualityMenu(false);
    try {
      savePlaybackPreference("quality", qKey);
    } catch {}
    showToast("清晰度已切换至：{{quality}}", { quality: qKey });

    if (video) {
      const handleRestoreOnReady = () => {
        if (streamQualitySwitchTimeRef.current !== null && streamQualitySwitchTimeRef.current > 0) {
          video.currentTime = streamQualitySwitchTimeRef.current;
          streamQualitySwitchTimeRef.current = null;
        }
        video.playbackRate = streamPlaybackSpeed;
        if (!wasPaused) {
          video.play().catch(() => {});
        }
      };
      video.addEventListener("loadeddata", handleRestoreOnReady, { once: true });
    }
  };

  // 推荐流切换播放倍速
  const handleStreamSelectSpeed = (speed: number) => {
    setStreamPlaybackSpeed(speed);
    savePlaybackPreference("speed", speed);
    setStreamShowSpeedMenu(false);
    if (streamVideoRef.current) {
      streamVideoRef.current.playbackRate = speed;
    }
    showToast("倍速已切换至：{{speed}}x", { speed });
  };

  // Previous remains inside the same session; only explicit next can produce a quick skip.
  const handleSwitchStream = async (direction: "prev" | "next", reason: "manual" | "automatic" = "manual") => {
    try {
      if(streamFeedRef.current.needsRestart(getPlaybackPreferences())){await loadStreamData(1,false);return;}
      const moved = await streamFeedRef.current.advance(direction, reason === "manual" ? direction : "automatic");
      if (!moved && direction === "prev") showToast("已经是本次推荐的第一部");
      else if (!moved) showToast("暂无更多推荐");
    } catch { showToast("推荐加载失败，可重试当前会话"); }
  };

  // 搜索框实时输入联想 (250ms 防抖)
  const handleSearchInputChange = (val: string) => {
    setSearchQuery(val);
    if (!val.trim()) {
      setSearchSuggestions([]);
      setShowSuggestions(false);
      setIsSuggesting(false);
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      return;
    }

    setShowSuggestions(true);
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    suggestTimerRef.current = setTimeout(async () => {
      try {
        setIsSuggesting(true);
        const data = await api.search(val.trim(), 1);
        setSearchSuggestions((data.items || []).slice(0, 6));
      } catch {
        setSearchSuggestions([]);
      } finally {
        setIsSuggesting(false);
      }
    }, 250);
  };

  // 执行最终搜索 (保存历史、重置筛选、关闭联想浮层)
  const executeSearch = async (queryText: string) => {
    const text = queryText.trim();
    if (!text) return;
    setSearchQuery(text);
    setShowSuggestions(false);
    setSearchSuggestions([]);
    setIsSuggesting(false);
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);

    // 保存到本地搜索历史
    const updatedHistory = saveSearchHistory(text);
    setSearchHistoryList(updatedHistory);

    try {
      setSearchLoading(true);
      setHasSearched(true);
      setSearchFilterTag("全部");
      const data = await api.search(text, 1);
      setSearchResults(data.items || []);
    } catch {
      showToast("搜索请求失败，请稍后重试");
    } finally {
      setSearchLoading(false);
    }
  };

  // 表单提交搜索
  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    executeSearch(searchQuery);
  };

  // 点击联想候选项
  const handleSelectSuggestion = (item: Series) => {
    saveSearchHistory(item.title);
    setSearchHistoryList(getSearchHistory());
    setShowSuggestions(false);
    setSearchSuggestions([]);
    handleSelectSeries(item);
  };

  // 选择短剧进入播放详情
  const handleSelectSeries = async (series: Pick<Series, "id"> & Partial<Series>, selectedProgress?: HistoryItem, requestedEpisode = "") => {
    const request = ++detailRequest.current;
    try {
      setShowSeriesEndModal(false);
      setLoading(true);
      const detail = await api.getSeries(series.id);
      const prog = selectedProgress || await getServerProgress(series.id).catch(() => null);
      if (request !== detailRequest.current) return;
      let initIndex = 0;
      if (prog && detail.episodes) {
        const found = detail.episodes.findIndex((ep) => ep.id === prog.episodeId);
        if (found !== -1) initIndex = found;
      }
      if (prog?.completed && detail.episodes[initIndex]?.id === prog.episodeId && initIndex < detail.episodes.length - 1) initIndex++;
      if (requestedEpisode) {
        const requestedIndex = detail.episodes.findIndex(episode => episode.id === requestedEpisode);
        if (requestedIndex >= 0) initIndex = requestedIndex;
      }
      beginHistory(detail, prog);
      if (mobilePrototype) { setMobileDetailInfoOpen(false); setMobileEpisodesOpen(false); setMobileRelatedOpen(false); }
      setPlaybackSpeed(getPlaybackPreferences().speed);
      setStreamPlaybackSpeed(getPlaybackPreferences().speed);
      setActiveSeries(detail);
      setCurrentEpisodeIndex(initIndex);
      setEpisodeRangeIndex(Math.floor(initIndex / 30));
      setShowRangeDropdown(false);

      // 立即记录/更新观看历史（即使刚点进来，也能作为最近浏览/观看记录）
      const ep = detail.episodes?.[initIndex];
      qualitySwitchTimeRef.current = prog?.completed || prog?.episodeId !== ep?.id ? 0 : prog?.position || 0;
      saveProgress(series.id, ep?.id || "", prog?.completed || prog?.episodeId !== ep?.id ? 0 : prog?.position || 0, {
        title: detail.title || series.title,
        cover: detail.cover || series.cover,
        badge: detail.badge || series.badge,
        tags: detail.tags || series.tags,
        episodeNumber: ep?.number || initIndex + 1,
        duration: prog?.duration || 0,
      });
    } catch {
      if (request === detailRequest.current) showToast("获取剧集详情失败");
    } finally {
      if (request === detailRequest.current) setLoading(false);
    }
  };
  openSeriesRef.current = handleSelectSeries;

  // 收藏 / 取消收藏
  const handleToggleFav = (series: Series) => {
    const isFav = toggleFavorite(series);
    setFavorites(getFavorites());
    showToast(isFav ? "已加入我的追剧" : "已从我的追剧移除");
  };

  useEffect(() => {
    if (accountPanel) { videoRef.current?.pause(); streamVideoRef.current?.pause(); }
  }, [accountPanel]);
  const playbackReturn = activeSeries && currentEpisode ? {seriesId:activeSeries.id,episodeId:currentEpisode.id} : tab==='recommend' && streamDetail && streamCurrentEpisode ? {seriesId:streamDetail.id,episodeId:streamCurrentEpisode.id} : undefined;
  const detailLocked = !!currentEpisode && (currentEpisodeIndex >= 3 && !hasVipAccess || playbackError === 'VIP_REQUIRED');
  useContentAnalytics(videoRef, activeSeries?.id, currentEpisode?.id, !!activeSeries?.owned && !!accountState.session, `${qualityEpisodeId}:${currentQuality}:${detailSource.source?.url || ''}`, 'detail', accountState.session?.libraryOwner, detailLocked, playbackError);
  useContentAnalytics(streamVideoRef, streamDetail?.id, streamCurrentEpisode?.id, tab === 'recommend' && !activeSeries && !!streamDetail?.owned && !!accountState.session, `${streamQualityEpisodeId}:${streamQuality}:${streamPlaybackAttempt}:${streamSource.source?.url || ''}`, 'feed', accountState.session?.libraryOwner, !!streamCurrentEpisode && (streamEpisodeIndex >= 3 && !hasVipAccess || streamError === 'VIP_REQUIRED'), streamError);
  const openMobileSearch = (origin: "recommend" | "category") => {
    mobileSearchOrigin.current = { tab: origin, series: activeSeries, episodeId: currentEpisode?.id };
    setTab("search"); setActiveSeries(null);
  };
  const returnMobileSearch = () => {
    const origin = mobileSearchOrigin.current;
    setTab(origin.tab); setActiveSeries(null);
    if (origin.series) void handleSelectSeries(origin.series, undefined, origin.episodeId);
    else if (origin.tab === "recommend") void loadStreamData(1, false);
    else if (!categoryItems.length) void fetchCategoryList(selectedCatType, selectedCatTag, catPage);
  };
  const toggleMobileFullscreen = async (container: HTMLDivElement | null, video: HTMLVideoElement | null) => {
    try {
      await toggleMediaFullscreen(container, video);
    } catch { showToast("操作失败，请稍后重试"); }
  };
  useEffect(() => {
    if (!activeSeries || !currentEpisode) return;
    const location = readPlaybackLocation(window.location.href);
    const url = playbackLocation(window.location.href, activeSeries.id, currentEpisode.id);
    if (url === window.location.href) return;
    if (location.seriesId !== activeSeries.id) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, [activeSeries?.id, currentEpisode?.id]);
  useEffect(() => {
    const watch = detailWatchRef.current, video = videoRef.current;
    if (!activeSeries || !video) {watch.pause();return;}
    return bindRecommendationPlayback(video, watch);
  }, [activeSeries, currentEpisode?.id, currentQuality, qualityEpisodeId, detailSource.source?.url]);

  useEffect(() => {
    const snapshot = () => {
      const series = activeSeries || streamList[streamIndex];
      const episode = activeSeries ? currentEpisode : streamCurrentEpisode;
      const video = activeSeries ? videoRef.current : streamVideoRef.current;
      if (!series || !episode || !video || (activeSeries ? qualitySwitchTimeRef.current : streamQualitySwitchTimeRef.current) !== null) return;
      saveProgress(series.id, episode.id, Math.floor(video.currentTime || 0), {
        title: series.title, cover: series.cover, badge: series.badge, tags: series.tags,
        episodeNumber: episode.number, duration: Math.floor(video.duration || 0), completed: video.ended,
      });
      void flushPersonalLibrary().catch(()=>{});
    };
    const visibility = () => { if (document.visibilityState === "hidden") snapshot(); };
    window.addEventListener("pagehide", snapshot);
    document.addEventListener("visibilitychange", visibility);
    const video = activeSeries ? videoRef.current : streamVideoRef.current;
    video?.addEventListener("seeked", snapshot);
    video?.addEventListener("pause", snapshot);
    video?.addEventListener("ended", snapshot);
    return () => {
      window.removeEventListener("pagehide", snapshot);
      document.removeEventListener("visibilitychange", visibility);
      video?.removeEventListener("seeked", snapshot);
      video?.removeEventListener("pause", snapshot);
      video?.removeEventListener("ended", snapshot);
      void flushPersonalLibrary().catch(()=>{});
    };
  }, [activeSeries, currentEpisode?.id, streamIndex, streamCurrentEpisode?.id, qualityEpisodeId, streamQualityEpisodeId, detailSource.source?.url, streamSource.source?.url]);


  // 后台暂停与回到前台续播共用一套生命周期处理。
  useEffect(() => {
    if (accountPanel) return;
    const video = activeSeries ? videoRef.current : tab === 'recommend' ? streamVideoRef.current : null;
    if (video) return bindPlaybackLifecycle(video);
  }, [activeSeries?.id, currentEpisode?.id, qualityEpisodeId, currentQuality, streamCurrentEpisode?.id, streamQualityEpisodeId, streamQuality, streamPlaybackAttempt, tab, accountPanel, detailSource.source?.url, streamSource.source?.url]);

  // 根据当前分集请求真实可用的视频源。
  useEffect(() => {
    if (!currentEpisode) return;

    let isMounted = true;
    setQualitiesLoading(true);
    setVideoQualities([]);
    setQualityEpisodeId("");
    setPlaybackError("");
    setPlaybackBuffering(false);
    setCurrentTime(0); setDuration(0); setIsPlaying(false);
    if (currentEpisodeIndex >= 3 && !hasVipAccess) { setQualitiesLoading(false); return; }

    api.getVideoQualities(currentEpisode.id, activeSeries?.id)
      .then((res) => {
        if (!isMounted) return;
        if (res.qualities && res.qualities.length > 0) {
          setVideoQualities(res.qualities);
          // 优先匹配用户此前选择的画质，若该画质在当前官方真实支持列表中则复用
          const pref = getPlaybackPreferences().quality;
          const hasPref = pref && res.qualities.some((q) => q.key === pref);
          if (hasPref) {
            setCurrentQuality(pref);
          } else if (res.defaultQuality) {
            setCurrentQuality(res.defaultQuality);
          } else {
            setCurrentQuality(res.qualities[0].key);
          }
          setQualityEpisodeId(currentEpisode.id);
        } else {
          setPlaybackError("当前剧集没有可用的视频源，请稍后重试");
        }
      })
      .catch((err) => {
        if (isMounted) setPlaybackError(playbackFailure(err));
        console.warn("加载官方画质失败:", err);
      })
      .finally(() => {
        if (isMounted) setQualitiesLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [currentEpisode?.id, activeSeries?.id, qualityRetry, hasVipAccess]);

  // 🌟 1.5 切换短剧时，自动拉取同题材推荐短剧 (任务 01: 猜你喜欢 & 任务 02: 换一批)
  useEffect(() => {
    if (!activeSeries?.id) {
      setRelatedSeries([]);
      setRelatedPool([]);
      setRelatedKeyword("");
      setRelatedPage(1);
      return;
    }

    let isMounted = true;
    setRelatedLoading(true);
    setRelatedPage(1);
    setRecommendFadeIn(true);

    // 联合拉取同题材与算法流，组建充足的推荐候选池
    Promise.all([
      api.getRelatedSeries(activeSeries.id, 16, 1).catch(() => ({ seriesId: "", keyword: "", items: [] })),
      api.getRecommend(1).catch(() => ({ items: [], page: 1 })),
    ])
      .then(([relRes, recRes]) => {
        if (!isMounted) return;
        const seenIds = new Set<string>([String(activeSeries.id)]);
        const combinedPool: Series[] = [];

        // 优先收纳同题材好剧
        for (const item of relRes.items || []) {
          const sid = String(item.id);
          if (!seenIds.has(sid)) {
            seenIds.add(sid);
            combinedPool.push(item);
          }
        }
        // 补充算法推荐剧集
        for (const item of recRes.items || []) {
          const sid = String(item.id);
          if (!seenIds.has(sid)) {
            seenIds.add(sid);
            combinedPool.push(item);
          }
        }

        setRelatedPool(combinedPool);
        setRelatedSeries(combinedPool.slice(0, 15));
        setRelatedKeyword(relRes.keyword || "");
      })
      .catch((err) => {
        console.warn("加载同类推荐短剧失败:", err);
      })
      .finally(() => {
        if (isMounted) setRelatedLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeSeries?.id]);

  // 🌟 任务 02:「🔄 换一批」智能实时换剧与微动效交互 (一排5个共三排，每次15部)
  const handleRefreshRecommend = async () => {
    if (!activeSeries?.id || relatedRefreshing || relatedLoading) return;

    // 1. 图标旋转 360° 微动效 (连续点击累加角度，永不倒转)
    setRefreshRotateDeg((prev) => prev + 360);
    setRelatedRefreshing(true);

    // 2. 卡片渐变微动效
    setRecommendFadeIn(false);

    const BATCH_SIZE = 15;
    const nextPage = relatedPage + 1;
    const startIndex = (nextPage - 1) * BATCH_SIZE;
    const endIndex = nextPage * BATCH_SIZE;

    // 3. 检查本地缓冲池是否有足够的剧集库存
    if (relatedPool.length >= endIndex) {
      setTimeout(() => {
        setRelatedSeries(relatedPool.slice(startIndex, endIndex));
        setRelatedPage(nextPage);
        setRecommendFadeIn(true);
        setRelatedRefreshing(false);
      }, 180);

      // 后台静默预取下一页充实库存
      if (relatedPool.length < (nextPage + 1) * BATCH_SIZE) {
        Promise.all([
          api.getRelatedSeries(activeSeries.id, 15, nextPage + 1).catch(() => ({ items: [] })),
          api.getRecommend(nextPage + 1).catch(() => ({ items: [] })),
        ]).then(([rel, rec]) => {
          setRelatedPool((prev) => {
            const seen = new Set(prev.map((i) => String(i.id)));
            const addList: Series[] = [];
            for (const item of [...(rel.items || []), ...(rec.items || [])]) {
              const sid = String(item.id);
              if (sid !== String(activeSeries.id) && !seen.has(sid)) {
                seen.add(sid);
                addList.push(item);
              }
            }
            return [...prev, ...addList];
          });
        });
      }
      return;
    }

    // 4. 库存不足，实时向服务端拉取新数据
    try {
      const [moreRelated, moreRec] = await Promise.all([
        api.getRelatedSeries(activeSeries.id, 15, nextPage).catch(() => ({ items: [] })),
        api.getRecommend(nextPage).catch(() => ({ items: [] })),
      ]);

      const seen = new Set<string>([String(activeSeries.id), ...relatedPool.map((i) => String(i.id))]);
      const newItems: Series[] = [];

      for (const item of moreRelated.items || []) {
        const sid = String(item.id);
        if (!seen.has(sid)) {
          seen.add(sid);
          newItems.push(item);
        }
      }
      for (const item of moreRec.items || []) {
        const sid = String(item.id);
        if (!seen.has(sid)) {
          seen.add(sid);
          newItems.push(item);
        }
      }

      setTimeout(() => {
        if (newItems.length >= 8) {
          const updatedPool = [...relatedPool, ...newItems];
          setRelatedPool(updatedPool);
          setRelatedSeries(newItems.slice(0, 15));
          setRelatedPage(nextPage);
        } else {
          // 若全库已轮换到底，平滑循环回第一批
          setRelatedSeries(relatedPool.slice(0, 15));
          setRelatedPage(1);
        }
        setRecommendFadeIn(true);
        setRelatedRefreshing(false);
      }, 180);
    } catch {
      setTimeout(() => {
        setRelatedSeries(relatedPool.slice(0, 15));
        setRelatedPage(1);
        setRecommendFadeIn(true);
        setRelatedRefreshing(false);
      }, 180);
    }
  };

  // 🌟 任务 03: 5秒倒计时引擎，全剧终沉浸式自动连播下一部精选短剧
  useEffect(() => {
    if (!showSeriesEndModal || !seriesEndTarget) return;

    setSeriesEndCountdown(5);
    const timer = setInterval(() => {
      setSeriesEndCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setShowSeriesEndModal(false);
          handleSelectSeries(seriesEndTarget);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [showSeriesEndModal, seriesEndTarget]);

  // 当短剧或集数发生变动时，确保片尾弹窗处于关闭状态
  useEffect(() => {
    setShowSeriesEndModal(false);
  }, [activeSeries?.id, currentEpisodeIndex]);

  // 🌟 任务 04: 自动拉取当前短剧的同系列多季列表
  useEffect(() => {
    if (!activeSeries) {
      setSeasonsList([]);
      setSelectedSeasonId(null);
      return;
    }
    setSelectedSeasonId(activeSeries.id);
    let cancelled = false;
    setSeasonsLoading(true);
    api.getSeriesSeasons(activeSeries)
      .then((list) => {
        if (!cancelled) {
          setSeasonsList(list);
          setSelectedSeasonId(activeSeries.id);
          setSeasonsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setSeasonsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSeries?.id]);

  // 🌟 任务 04: 快速切换季数
  const handleSwitchSeason = async (season: SeasonInfo) => {
    if (String(season.seriesId) === String(activeSeries?.id)) return;
    try {
      setShowSeriesEndModal(false);
      showToast("正在切换至《{{title}}》...", { title: season.title });
      await handleSelectSeries({
        id: season.seriesId,
        title: season.title,
        cover: season.cover || activeSeries?.cover || "",
        badge: season.badge || "",
        description: "",
        tags: activeSeries?.tags || "",
      });
    } catch {
      showToast("切换季数失败");
    }
  };

  // 换一部片尾推荐剧集
  const handleSwitchNextSeriesRecommendation = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!activeSeries) return;
    const pool = [
      ...relatedSeries,
      ...relatedPool,
      ...sections.flatMap((s) => s.items),
      ...banners
    ].filter(
      (s) => String(s.id) !== String(activeSeries.id) && String(s.id) !== String(seriesEndTarget?.id)
    );
    if (pool.length > 0) {
      const nextTarget = pool[Math.floor(Math.random() * pool.length)];
      setSeriesEndTarget(nextTarget);
      setSeriesEndCountdown(5);
    } else {
      showToast("暂无更多同类推荐剧");
    }
  };

  // 2. 全屏状态同步监听
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // 3. 遥控器与键盘快捷键全面支持
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      ) {
        return;
      }

      // 若片尾推荐弹窗已打开，响应回车立即连播、Esc 关闭弹窗
      if (showSeriesEndModal) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowSeriesEndModal(false);
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (seriesEndTarget) {
            setShowSeriesEndModal(false);
            handleSelectSeries(seriesEndTarget);
          }
          return;
        }
      }

      if (!activeSeries || !videoRef.current) return;
      const video = videoRef.current;

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          if (video.paused) {
            video.play();
            setIsPlaying(true);
          } else {
            video.pause();
            setIsPlaying(false);
          }
          resetControlsTimer();
          break;
        case "ArrowLeft":
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 5);
          setCurrentTime(video.currentTime);
          showToast("快退5秒", { time: formatTime(video.currentTime) });
          resetControlsTimer();
          break;
        case "ArrowRight":
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 9999, video.currentTime + 5);
          setCurrentTime(video.currentTime);
          showToast("快进5秒", { time: formatTime(video.currentTime) });
          resetControlsTimer();
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, Math.round((video.volume + 0.1) * 10) / 10);
          setVolume(video.volume);
          setIsMuted(false);
          showToast("音量：{{value}}%", { value: Math.round(video.volume * 100) });
          resetControlsTimer();
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, Math.round((video.volume - 0.1) * 10) / 10);
          setVolume(video.volume);
          showToast("音量：{{value}}%", { value: Math.round(video.volume * 100) });
          resetControlsTimer();
          break;
        case "[": {
          e.preventDefault();
          const speeds = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
          const currIdx = speeds.indexOf(playbackSpeed);
          const nextIdx = Math.max(0, currIdx - 1);
          handleSelectSpeed(speeds[nextIdx]);
          break;
        }
        case "]": {
          e.preventDefault();
          const speeds = [0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
          const currIdx = speeds.indexOf(playbackSpeed);
          const nextIdx = Math.min(speeds.length - 1, currIdx + 1);
          handleSelectSpeed(speeds[nextIdx]);
          break;
        }
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "m":
        case "M":
          e.preventDefault();
          video.muted = !video.muted;
          setIsMuted(video.muted);
          showToast(video.muted ? "已静音" : "已恢复声音");
          resetControlsTimer();
          break;
        case "n":
        case "N":
          e.preventDefault();
          if (currentEpisodeIndex < activeSeries.episodes.length - 1) {
            setShowSeriesEndModal(false);
            setCurrentEpisodeIndex((i) => i + 1);
          }
          break;
        case "p":
        case "P":
          e.preventDefault();
          if (currentEpisodeIndex > 0) {
            setShowSeriesEndModal(false);
            setCurrentEpisodeIndex((i) => i - 1);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeSeries, currentEpisodeIndex, playbackSpeed, showSeriesEndModal, seriesEndTarget]);

  const resetControlsTimer = () => {
    setShowControls(true);
    if (controlsTimerRef.current) {
      clearTimeout(controlsTimerRef.current);
    }
    controlsTimerRef.current = setTimeout(() => {
      setShowControls(false);
      setShowQualityMenu(false);
      setShowSpeedMenu(false);
    }, 3500);
  };

  const handleTogglePlay = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    resetControlsTimer();
  };

  const retryDetailPlayback = () => {
    if (qualitySwitchTimeRef.current === null) qualitySwitchTimeRef.current = videoRef.current?.currentTime ?? currentTime;
    setPlaybackBuffering(false);
    setQualityRetry(attempt => attempt + 1);
  };
  const retryStreamPlayback = () => {
    if (streamCurrentEpisode) {
      if (streamQualitySwitchTimeRef.current === null) streamQualitySwitchTimeRef.current = streamVideoRef.current?.currentTime ?? streamCurrentTime;
      setStreamBuffering(false);
      setStreamPlaybackAttempt(attempt => attempt + 1);
    } else if (streamList[streamIndex]) void loadStreamDetail(streamList[streamIndex]);
    else void streamFeedRef.current.retry().catch(() => {});
    setStreamError("");
  };

  const handleLoadedMetadata = () => {
    if (!videoRef.current) return;
    if (mobilePrototype) {
      setMobileDetailLandscape(videoRef.current.videoWidth > videoRef.current.videoHeight);
      videoRef.current.volume = volume; videoRef.current.muted = isMuted;
    }
    videoRef.current.playbackRate = playbackSpeed;
    setDuration(videoRef.current.duration || 0);

    // 如果是画质切换，精确恢复当前播放时间戳并继续播放
    if (qualitySwitchTimeRef.current !== null) {
      if (qualitySwitchTimeRef.current > 0) {
        videoRef.current.currentTime = qualitySwitchTimeRef.current;
      }
      qualitySwitchTimeRef.current = null;
    } else if (activeSeries && currentEpisode) {
      // 换集/初次加载时才检查历史续播
      const prog = getProgress(activeSeries.id);
      if (prog && !prog.completed && prog.episodeId === currentEpisode.id && prog.position > 0) {
        if (prog.position < (videoRef.current.duration || 9999) - 5) {
          videoRef.current.currentTime = prog.position;
          showToast("已恢复播放进度", { time: formatTime(prog.position) });
        }
      }
    }

    if (!accountPanel) videoRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
  };


  const handleTimeUpdate = () => {
    if (!activeSeries || !currentEpisode || !videoRef.current || qualitySwitchTimeRef.current !== null) return;
    const time = Math.floor(videoRef.current.currentTime);
    setCurrentTime(videoRef.current.currentTime);
    setDuration(videoRef.current.duration || 0);

    // 严禁在视频还在正常播放中显示片尾推荐弹窗
    if (showSeriesEndModal && videoRef.current.duration > 0 && videoRef.current.currentTime < videoRef.current.duration - 0.5) {
      setShowSeriesEndModal(false);
    }

    if (time >= 0) {
      saveProgress(activeSeries.id, currentEpisode.id, time, {
        title: activeSeries.title,
        cover: activeSeries.cover,
        badge: activeSeries.badge,
        tags: activeSeries.tags,
        episodeNumber: currentEpisode.number || currentEpisodeIndex + 1,
        duration: Math.floor(videoRef.current.duration || 0),
        completed: videoRef.current.ended,
      });
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const target = parseFloat(e.target.value);
    videoRef.current.currentTime = target;
    setCurrentTime(target);
    handleTimeUpdate();
    resetControlsTimer();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return;
    const val = parseFloat(e.target.value);
    videoRef.current.volume = val;
    setVolume(val);
    setIsMuted(val === 0);
    if (val > 0) videoRef.current.muted = false;
  };

  const handleToggleMute = () => {
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setIsMuted(videoRef.current.muted);
    if (!videoRef.current.muted && videoRef.current.volume === 0) {
      videoRef.current.volume = 0.6;
      setVolume(0.6);
    }
  };

  // 切换画质 (平滑保持当前时间进度，零黑屏零卡顿)
  const handleSelectQuality = (qKey: string) => {
    if (qKey === currentQuality) {
      setShowQualityMenu(false);
      return;
    }
    const video = videoRef.current;
    const prevTime = video ? video.currentTime : currentTime;
    const wasPaused = video ? video.paused : false;

    qualitySwitchTimeRef.current = prevTime;
    setCurrentQuality(qKey);
    setShowQualityMenu(false);
    try {
      savePlaybackPreference("quality", qKey);
    } catch {}
    showToast("正在切换画质", { quality: qKey });

    if (video) {
      const handleRestoreOnReady = () => {
        if (qualitySwitchTimeRef.current !== null && qualitySwitchTimeRef.current > 0) {
          video.currentTime = qualitySwitchTimeRef.current;
          qualitySwitchTimeRef.current = null;
        }
        video.playbackRate = playbackSpeed;
        if (!wasPaused) {
          video.play().catch(() => {});
        }
      };
      // 监听新流就绪后再续播
      video.addEventListener("loadeddata", handleRestoreOnReady, { once: true });
    }
  };


  // 切换倍速
  const handleSelectSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef.current) {
      videoRef.current.playbackRate = speed;
    }
    try {
      savePlaybackPreference("speed", speed);
    } catch {}
    setShowSpeedMenu(false);
    showToast("倍速已切换至：{{speed}}x", { speed });
  };

  // 全屏切换
  const toggleFullscreen = () => {
    void toggleMobileFullscreen(playerContainerRef.current, videoRef.current);
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const handleVideoEnded = () => {
    const video = videoRef.current;
    if (!video || !activeSeries) return;
    handleTimeUpdate();
    detailWatchRef.current.pause();
    if (currentEpisodeIndex === activeSeries.episodes.length - 1 && video.ended) detailWatchRef.current.complete();

    // 1. 中间集数：继续连播下一集
    if (currentEpisodeIndex < activeSeries.episodes.length - 1) {
      if (autoPlayNext) {
        setCurrentEpisodeIndex((prev) => prev + 1);
        showToast("本集结束自动下一集", { number: currentEpisodeIndex + 1 });
      } else {
        video.pause();
        setIsPlaying(false);
      }
      return;
    }

    // 2. 全剧最后一集：严格保证全剧彻底播放完毕后才显示
    // 必须经过多重严格校验：确保视频已经彻底到底，而不是在播放过程中触发
    const isDurationValid = !isNaN(video.duration) && video.duration > 0;
    const isCompletelyEnded = video.ended || (isDurationValid && video.currentTime >= video.duration - 0.3);

    if (!isCompletelyEnded) {
      // 视频尚未彻底播完，严禁显示推荐弹窗！
      return;
    }

    // 彻底停止视频流播放并定格
    video.pause();
    setIsPlaying(false);

    // 🌟 任务 04: 当季播放完后，最高优先级锁定并自动连播同系列下一季！
    let candidate: Series | null = null;
    let isNextSeason = false;

    const currentSeasonIdx = seasonsList.findIndex(
      (s) => String(s.seriesId) === String(activeSeries.id)
    );
    if (currentSeasonIdx !== -1 && currentSeasonIdx < seasonsList.length - 1) {
      const nextSeason = seasonsList[currentSeasonIdx + 1];
      candidate = {
        id: nextSeason.seriesId,
        title: nextSeason.title,
        cover: nextSeason.cover || activeSeries.cover,
        badge: nextSeason.badge || "全集",
        description: "",
        tags: "同系列下一季"
      };
      isNextSeason = true;
    }

    // 若没有下一季（或已是最终季），回退至同类好剧推荐池
    if (!candidate) {
      const allPool = [
        ...relatedSeries,
        ...relatedPool,
        ...sections.flatMap((s) => s.items),
        ...banners
      ];
      candidate = allPool.find((s) => String(s.id) !== String(activeSeries.id)) || null;
    }

    if (candidate) {
      setSeriesEndTarget(candidate);
      setShowSeriesEndModal(true);
      if (isNextSeason) {
        showToast(`🎉 恭喜追完当前季！即将自动连播下一季`);
      }
    } else {
      showToast("追完全集", { title: activeSeries.title });
    }
  };

  const currentBanner = banners[activeBannerIndex];
  const currentRankType = rankTypes.find((r) => r.slug === selectedRankSlug) || rankTypes[0];

  useEffect(() => { setPlaybackError(""); }, [currentEpisode?.id, currentQuality]);

  // 今日日期格式化
  const todayStr = t("更新日期", { date: formatDate(new Date(), { month: "short", day: "numeric" }) });

  useEffect(() => {
    // 播放链接的异步详情请求尚未完成时，响应式导航不能取消它。
    if (activeSeries || readPlaybackLocation(window.location.href).seriesId) return;
    if (mobilePrototype && tab === "home") {
      setTab("category");
      if (!categoryItems.length) void fetchCategoryList(selectedCatType, selectedCatTag, catPage);
    } else if (mobilePrototype && tab === "settings") {
      setFavSubTab("settings"); setTab("favorites");
    } else if (!mobilePrototype && tab === "favorites" && favSubTab === "settings") {
      setTab("settings");
    }
  }, [mobilePrototype, tab, favSubTab, activeSeries?.id]);
  useEffect(() => { if (accountState.session && accountPanel === "profile" && !accountState.session.user) setAccountPanel("login"); }, [accountState.session, accountPanel]);
  const openPersonalPage = (section: "overview" | "favorites" | "history" | "likes" | "settings") => {
    if (mobilePrototype && section === 'settings' && !mobileSettingsOpen) personalSettingsReturn.current = { section: ['favorites','history','likes'].includes(personalContentTab) ? personalContentTab as 'favorites' | 'history' | 'likes' : 'favorites', scrollTop: mainContentRef.current?.scrollTop || 0 };
    setFavSubTab(section); setActiveSeries(null); setTab(section === "settings" && !mobilePrototype ? "settings" : "favorites"); void refreshHistory(); setFavorites(getFavorites());
  };
  const returnMobileSettings = () => { restorePersonalScroll.current = true; openPersonalPage(personalSettingsReturn.current.section); };
  const personalFavoriteCount=getPersonalPagination('favorite').count||favorites.length,personalHistoryCount=getPersonalPagination('history').count||historyList.length;
  const personalAreaProps = { session: accountState.session, onPanel: setAccountPanel, onOverview: () => openPersonalPage("overview"), onFavorites: () => openPersonalPage("favorites"), onHistory: () => openPersonalPage("history"), onLikes: () => openPersonalPage("likes"), onSettings: () => openPersonalPage("settings"), favoritesCount: personalFavoriteCount, historyCount: personalHistoryCount, likesCount };

  return (
    <div className={`${mobilePrototype ? "mobile-prototype-mode " : ""}${forceMobileLayout === true ? "mobile-prototype-preview " : ""}flex h-screen w-screen overflow-hidden bg-[#070a12] text-slate-100 flex-col font-sans select-none`}>
      {/* 提示条 Toast */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-slate-800/95 border border-slate-700/80 backdrop-blur px-5 py-2.5 rounded-full text-sm shadow-2xl text-rose-400 font-semibold animate-bounce">
          {toast.values ? translate(language, toast.key, toast.values) : localizeError(toast.key)}
        </div>
      )}

      {/* 🔝 顶部通用导航栏（TV 遥控器与电脑鼠标通用，导航栏置顶） */}
      {!mobilePrototype && <header className="h-16 md:h-20 bg-[#0a0f1d]/95 backdrop-blur border-b border-slate-800/80 px-4 md:px-8 flex items-center justify-between z-30 shrink-0">
        <div className="flex-1 min-w-0 flex items-center gap-3 md:gap-8 overflow-x-auto no-scrollbar">
          {/* Logo */}
          <div 
            className="flex items-center gap-3 cursor-pointer shrink-0" 
            onClick={() => { setTab("home"); setActiveSeries(null); }}
          >
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-rose-600 via-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-900/40">
              <Play className="w-5 h-5 fill-white text-white ms-0.5" />
            </div>
            <div className="hidden md:block">
              <h1 className="font-extrabold text-base md:text-xl tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">{t("红果短剧")}</h1>
              <span className="text-[10px] text-rose-400/90 font-bold tracking-widest uppercase block -mt-1">{t("TV & PC 客户端")}</span>
            </div>
          </div>

          {/* 顶部主菜单项 (首页 | 分类 | 榜单 | 搜索 | 追剧) */}
          <nav className="flex items-center gap-1 md:gap-2">
            {/* 1. 首页 */}
            <button
              tabIndex={1}
              onClick={() => { setTab("home"); setActiveSeries(null); }}
              className={`tv-nav-item flex items-center gap-1.5 md:gap-2 px-3.5 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-semibold transition-all duration-200 outline-none focus:ring-4 focus:ring-rose-500/50 shrink-0 ${
                tab === "home" && !activeSeries
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Sparkles className="w-4 h-4" />{t("首页")}</button>

            {/* 1.5 推荐刷剧 (沉浸式 9:16 短剧流) */}
            <button
              tabIndex={2}
              onClick={() => { 
                setTab("recommend"); 
                setActiveSeries(null); 
                loadStreamData(1, false);
              }}
              className={`tv-nav-item flex items-center gap-1.5 md:gap-2 px-3.5 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-semibold transition-all duration-200 outline-none focus:ring-4 focus:ring-rose-500/50 shrink-0 ${
                tab === "recommend" && !activeSeries
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Compass className="w-4 h-4" />{t("推荐")}</button>

            {/* 2. 分类 */}
            <button
              tabIndex={3}
              onClick={() => { 
                setTab("category"); 
                setActiveSeries(null);
                if (categoryItems.length === 0) fetchCategoryList(selectedCatType, selectedCatTag, catPage);
              }}
              className={`tv-nav-item flex items-center gap-1.5 md:gap-2 px-3.5 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-semibold transition-all duration-200 outline-none focus:ring-4 focus:ring-rose-500/50 shrink-0 ${
                tab === "category" && !activeSeries
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Grid className="w-4 h-4" />{t("分类")}</button>

            {/* 3. 榜单 */}
            <button
              tabIndex={3}
              onClick={() => { 
                setTab("rank"); 
                setActiveSeries(null); 
                if (rankItems.length === 0) fetchRankList(selectedRankSlug, rankPage);
              }}
              className={`tv-nav-item flex items-center gap-1.5 md:gap-2 px-3.5 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-semibold transition-all duration-200 outline-none focus:ring-4 focus:ring-rose-500/50 shrink-0 ${
                tab === "rank" && !activeSeries
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Trophy className="w-4 h-4 text-amber-400" />{t("榜单")}</button>

            {/* 4. 搜索 */}
            <button
              tabIndex={4}
              onClick={() => { setTab("search"); setActiveSeries(null); }}
              className={`tv-nav-item flex items-center gap-1.5 md:gap-2 px-3.5 py-2 md:py-2.5 rounded-xl text-xs md:text-sm font-semibold transition-all duration-200 outline-none focus:ring-4 focus:ring-rose-500/50 shrink-0 ${
                tab === "search" && !activeSeries
                  ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                  : "text-slate-300 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Search className="w-4 h-4" />{t("搜索")}</button>

          </nav>
        </div>

        {/* 右侧用户区提供资料、会员、追剧、历史、点赞与设置，语言归入设置。 */}
        <AccountMenu {...personalAreaProps} />
      </header>}
      {mobilePrototype && !activeSeries && tab !== "recommend" && <header className={`prototype-header${mobileSettingsOpen ? ' prototype-settings-header' : ''}`}>
        {mobileSettingsOpen ? <><button aria-label={t('返回')} onClick={returnMobileSettings}><ArrowLeft size={23}/></button><strong>{t('设置')}</strong><span className="prototype-header-spacer" aria-hidden="true"/></> : <>
        <div className="prototype-brand"><span className="prototype-brand-icon"><Play size={17} fill="currentColor" /></span><strong>{t(tab === "category" ? "分类" : tab === "rank" ? "榜单" : tab === "favorites" || tab === "settings" ? "我的" : tab === "search" ? "搜索" : "推荐")}</strong></div>
        {tab === "category" && <button aria-label={t("搜索")} onClick={() => openMobileSearch("category")}><Search size={22} /></button>}
        {tab === "favorites" && favSubTab !== "settings" && <button aria-label={t("设置")} onClick={() => openPersonalPage("settings")}><SettingsIcon size={22}/></button>}
        {tab === "search" && <button aria-label={t("返回")} onClick={returnMobileSearch}><X size={22} /></button>}
        </>}
      </header>}

      {!languageSaved && <div role="alert" className="bg-amber-950 text-amber-200 px-5 py-2">{t("语言偏好无法保存")}</div>}
      {historyStorageWarning && <div role="alert" className="bg-amber-950 text-amber-200 px-5 py-2">{localizeError(historyStorageWarning)}</div>}
      {/* 主界面区域 */}
      <main ref={mainContentRef} className={`flex-1 ${mobilePrototype && activeSeries ? "prototype-detail-main" : ""} ${mobilePrototype && !activeSeries && tab === "category" ? "prototype-category-main" : ""} ${!activeSeries && tab === "recommend" ? "overflow-hidden p-0" : "overflow-y-auto px-4 md:px-8 py-6"}`}>
        {/* ======================= 1. 播放与选集详情界面 ======================= */}
        {activeSeries ? (
          <div className={`max-w-[1720px] mx-auto flex flex-col gap-8 pb-14 px-2 sm:px-4 ${mobilePrototype ? "prototype-detail-layout" : ""}`}>
            {/* 上半部分：左侧播放器 + 右侧选集栏 */}
            <div className={`flex flex-col lg:flex-row gap-6 ${mobilePrototype ? "prototype-detail-upper" : ""}`}>
              {/* 左侧大屏播放器 */}
              <div className={`flex-1 flex flex-col gap-4 ${mobilePrototype ? "prototype-detail-player-column" : ""}`}>
              <div className={`flex items-center justify-between ${mobilePrototype ? "prototype-legacy-player-controls" : ""}`}>
                <button
                  tabIndex={7}
                  onClick={() => setActiveSeries(null)}
                  className="flex items-center gap-2 text-sm text-slate-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-slate-800 transition outline-none focus:ring-2 focus:ring-rose-500"
                >
                  <ArrowLeft className="w-4 h-4" />{t("返回")}</button>
                <div className="flex items-center gap-2">
                  <span className="text-xs px-3 py-1 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium">
                    {t("正在播放第{{number}}集", { number: currentEpisode?.number || currentEpisodeIndex + 1 })}
                  </span>
                </div>
              </div>

              {/* 🌟 沉浸式专业播放器容器 (全屏/倍速/官方真实画质/连播/快捷键) */}
              <div
                ref={playerContainerRef}
                style={mobilePrototype ? { touchAction: "pan-x" } : undefined}
                onPointerDown={event => {
                  if (!mobilePrototype || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, [data-gesture-exclude]")) return;
                  detailGestureRef.current = { x: event.clientX, y: event.clientY, at: Date.now(), episodeId: currentEpisode?.id };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerUp={event => {
                  const start = detailGestureRef.current;
                  detailGestureRef.current = null;
                  if (!mobilePrototype || !start) return;
                  const dx = event.clientX - start.x, dy = event.clientY - start.y;
                  if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - start.at < 500) {
                    suppressDetailClickUntil.current = Date.now() + 400;
                    handleTogglePlay();
                    return;
                  }
                  if (Math.abs(dy) < 70 || Math.abs(dy) <= Math.abs(dx) * 1.3 || Date.now() - start.at >= 1200) return;
                  suppressDetailClickUntil.current = Date.now() + 400;
                  if (start.episodeId !== currentEpisode?.id) return;
                  const nextIndex = currentEpisodeIndex + (dy < 0 ? 1 : -1);
                  if (nextIndex < 0 || nextIndex >= activeSeries.episodes.length) return;
                  setCurrentEpisodeIndex(nextIndex);
                  setMobileDetailInfoOpen(false);
                  setShowSeriesEndModal(false);
                }}
                onPointerCancel={() => { detailGestureRef.current = null; }}
                onClickCapture={event => {
                  if (mobilePrototype && Date.now() < suppressDetailClickUntil.current && !(event.target as HTMLElement).closest("button, input")) { event.preventDefault(); event.stopPropagation(); }
                }}
                onMouseMove={resetControlsTimer}
                onClick={resetControlsTimer}
                onDoubleClick={mobilePrototype ? undefined : toggleFullscreen}
                className={`relative aspect-[9/16] max-h-[72vh] lg:max-h-none lg:aspect-video w-full bg-black rounded-2xl overflow-hidden border border-slate-800 shadow-2xl flex items-center justify-center group ${mobilePrototype ? "prototype-detail-stage" : ""} ${
                  isFullscreen ? "fixed inset-0 z-50 rounded-none border-none max-h-none aspect-auto w-screen h-screen" : ""
                }`}
              >
                {detailLocked ? <VipGate cover={activeSeries.cover} number={currentEpisode?.number} loading={!accountState.session} onSubscribe={() => setAccountPanel('membership')} onBack={() => setActiveSeries(null)} onEpisodes={mobilePrototype ? () => setMobileEpisodesOpen(true) : undefined} /> : currentEpisode && qualityEpisodeId === currentEpisode.id ? (
                  <>
                    {detailSource.source && <video
                      ref={videoRef}
                      key={currentEpisode.id}
                      src={detailSource.source?.url}
                      autoPlay={!accountPanel}
                      playsInline
                      onTimeUpdate={handleTimeUpdate}
                      onLoadedMetadata={handleLoadedMetadata}
                      onEnded={handleVideoEnded}
                      onError={() => { setPlaybackBuffering(false); setPlaybackError("无法播放媒体"); setIsPlaying(false); }}
                      onWaiting={event => { if (!event.currentTarget.paused) setPlaybackBuffering(true); }}
                      onStalled={event => { if (!event.currentTarget.paused) setPlaybackBuffering(true); }}
                      onPlay={() => {
                        setIsPlaying(true);
                        setShowSeriesEndModal(false);
                      }}
                      onPlaying={() => {
                        setPlaybackBuffering(false);
                        setIsPlaying(true);
                        setShowSeriesEndModal(false);
                      }}
                      onPause={() => { handleTimeUpdate(); setPlaybackBuffering(false); setIsPlaying(false); }}
                      onSeeked={handleTimeUpdate}
                      onClick={handleTogglePlay}
                      className="w-full h-full object-contain cursor-pointer"
                    />}

                    {mobilePrototype && <>
                      <div className="prototype-detail-shade" />
                      <div className="prototype-detail-top">
                        <div className="prototype-detail-back"><button aria-label={t("返回")} onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else setActiveSeries(null); }}><ArrowLeft size={21} /></button><span>{t("第{{number}}集", { number: currentEpisode.number })}</span></div>
                        <PlayerActions key={currentEpisode.id} speed={playbackSpeed} quality={currentQuality} qualities={videoQualities} loading={qualitiesLoading} onSpeed={handleSelectSpeed} onQuality={handleSelectQuality} onSearch={() => openMobileSearch(tab === "category" ? "category" : "recommend")} onFullscreen={() => void toggleMobileFullscreen(playerContainerRef.current, videoRef.current)} autoplay={autoPlayNext} onAutoplay={() => setAutoPlayNext(value => !value)} muted={isMuted} onMute={handleToggleMute} volume={volume} onVolume={value => { if (videoRef.current) { videoRef.current.volume = value; videoRef.current.muted = value === 0; } setVolume(value); setIsMuted(value === 0); }} onPrevious={() => setCurrentEpisodeIndex(value => value - 1)} previousDisabled={currentEpisodeIndex === 0} onRelated={() => setMobileRelatedOpen(true)} />
                      </div>
                      {mobileDetailLandscape && <FullscreenWatch key={currentEpisode.id} videoRef={videoRef} onClick={() => void toggleMobileFullscreen(playerContainerRef.current, videoRef.current)} />}
                      <div className="prototype-detail-side">
                        <button aria-label={t(favorites.some(item => item.id === activeSeries.id) ? '已追剧' : '点击追剧')} onClick={() => handleToggleFav(activeSeries)} className="detail-follow-avatar"><img src={activeSeries.cover} alt={activeSeries.title}/><span>{favorites.some(item => item.id === activeSeries.id) ? '✓' : '+'}</span></button>
                        <EpisodeInteractions key={currentEpisode.id} seriesId={activeSeries.id} episodeId={currentEpisode.id} title={activeSeries.title} session={accountState.session} onLogin={() => setAccountPanel('login')} />
                        <PlayerSideAction disabled={currentEpisodeIndex >= activeSeries.episodes.length - 1} label={t("下一集")} icon={<ChevronRight size={27} />} onClick={() => { setCurrentEpisodeIndex(value => value + 1); setMobileDetailInfoOpen(false); }} />
                      </div>
                      <div className="prototype-detail-info" data-gesture-exclude>
                        <h3><bdi>{activeSeries.title}</bdi></h3>
                        <button className="prototype-info-toggle" aria-expanded={mobileDetailInfoOpen} onClick={() => setMobileDetailInfoOpen(value => !value)}>{t(mobileDetailInfoOpen ? "收起剧集信息" : "展开剧集信息")}<ChevronDown size={14} /></button>
                        {mobileDetailInfoOpen && <div className="prototype-detail-synopsis"><p>{localizeLabel(activeSeries.tags)}</p><p dir="auto">{activeSeries.description || t("暂无剧集简介")}</p></div>}
                        <button className="prototype-episodes-trigger" aria-expanded={mobileEpisodesOpen} onClick={() => setMobileEpisodesOpen(true)}><Layers size={16} /><span>{t("选集")} · {t("第{{number}}集", { number: currentEpisode.number })} / {activeSeries.episodes.length}</span><ChevronDown size={15} /></button>
                      </div>
                      <div className="prototype-detail-progress" dir="ltr"><span>{formatTime(currentTime)}</span><input aria-label={t("播放进度")} type="range" min="0" max={duration || 100} step="0.5" value={Math.min(currentTime, duration || 100)} onChange={handleSeek} /><span>{formatTime(duration)}</span></div>
                    </>}

                    {playbackError && <div role="alert" className="absolute inset-x-3 top-20 z-40 p-3 rounded-xl bg-black/85 text-sm text-rose-200">{localizeError(playbackError)} <button className="underline ms-2" onClick={retryDetailPlayback}>{t("重试")}</button></div>}
                    {(playbackBuffering || detailSource.loading) && !playbackError && <div role="status" className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center gap-3 bg-black/20"><RefreshCw className="w-8 h-8 animate-spin"/><span>{t("加载中...")}</span></div>}

                    {/* 暂停时中央呼吸播放大按钮 */}
                    {!isPlaying && (
                      <button
                        onClick={handleTogglePlay}
                        aria-label={t("播放")}
                        className="absolute inset-0 m-auto w-16 h-16 md:w-20 md:h-20 rounded-full bg-rose-600/90 hover:bg-rose-500 text-white flex items-center justify-center shadow-2xl shadow-rose-950/80 backdrop-blur transition-transform hover:scale-110 z-20"
                      >
                        <Play className="w-8 h-8 fill-white ms-1" />
                      </button>
                    )}

                    {/* 🔝 顶部控制栏 (标题、集数、画质徽章、快捷键说明) */}
                    <div
                      className={`absolute top-0 inset-x-0 p-4 md:p-6 bg-gradient-to-b from-black/85 via-black/40 to-transparent flex items-center justify-between transition-opacity duration-300 z-30 pointer-events-auto ${mobilePrototype ? "prototype-legacy-player-controls" : ""} ${
                        showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {isFullscreen && (
                          <button
                            onClick={toggleFullscreen}
                            aria-label={t("全屏切换")}
                            className="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white transition"
                          >
                            <ArrowLeft className="w-5 h-5" />
                          </button>
                        )}
                        <div>
                          <h3 className="font-bold text-sm md:text-base text-white flex items-center gap-2">
                            {activeSeries.title}
                            <span className="text-xs px-2.5 py-0.5 rounded-full bg-rose-600 text-white font-medium">
                              {t("第{{number}}集", { number: currentEpisode.number || currentEpisodeIndex + 1 })}
                            </span>
                          </h3>
                        </div>
                      </div>

                      {/* 顶部右侧徽章与快捷键帮助 */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2.5 py-1 rounded-lg bg-black/60 border border-rose-500/40 text-rose-400 font-bold">
                          {currentQuality}
                        </span>
                        {playbackSpeed !== 1 && (
                          <span className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 font-bold">
                            {playbackSpeed}x
                          </span>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowShortcutsHelp(!showShortcutsHelp);
                          }}
                          title={t("快捷键说明")}
                          className="p-1.5 rounded-xl bg-black/60 hover:bg-slate-800 border border-slate-700/80 text-slate-400 hover:text-white transition"
                        >
                          <HelpCircle className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* ⌨️ 快捷键说明悬浮卡片 */}
                    {showShortcutsHelp && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-16 end-4 z-40 bg-slate-900/95 border border-slate-700 rounded-2xl p-4 shadow-2xl backdrop-blur text-xs space-y-2.5 w-64"
                      >
                        <div className="flex items-center justify-between pb-1.5 border-b border-slate-800 font-bold text-white">
                          <span>{t("⌨️ 播放器快捷键 (TV / PC)")}</span>
                          <button onClick={() => setShowShortcutsHelp(false)} className="text-slate-400 hover:text-white">✕</button>
                        </div>
                        <div className="grid grid-cols-2 gap-y-2 text-slate-300">
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">{t("空格")}</kbd>{t("播放/暂停")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">F</kbd>{t("全屏切换")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">← / →</kbd>{t("快退/快进 5s")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">↑ / ↓</kbd>{t("音量调节")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">[ / ]</kbd>{t("减速/加速")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">N / P</kbd>{t("下集/上集")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">M</kbd>{t("静音切换")}</div>
                          <div><kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-[10px] text-rose-400">{t("双击")}</kbd>{t("全屏")}</div>
                        </div>
                      </div>
                    )}

                    {/* 🔽 底部控制栏 (时间轴、播放/暂停、选集、倍速、官方画质、音量、全屏) */}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className={`absolute bottom-0 inset-x-0 p-4 md:p-6 bg-gradient-to-t from-black/95 via-black/60 to-transparent flex flex-col gap-3 transition-opacity duration-300 z-30 pointer-events-auto ${mobilePrototype ? "prototype-legacy-player-controls" : ""} ${
                        showControls || !isPlaying ? "opacity-100" : "opacity-0 pointer-events-none"
                      }`}
                    >
                      {/* 1. 进度条 (Scrub bar) */}
                      <div className="relative group/bar flex items-center w-full">
                        <input
                          type="range"
                          aria-label={t("播放进度")}
                          min={0}
                          max={duration || 100}
                          value={currentTime}
                          onChange={handleSeek}
                          step={0.5}
                          className="w-full h-1.5 group-hover/bar:h-2.5 bg-slate-700/80 rounded-lg appearance-none cursor-pointer accent-rose-500 transition-all"
                        />
                      </div>

                      {/* 2. 按钮控制栏 */}
                      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                        {/* 左侧控制：播放/暂停、上集、下集、时间 */}
                        <div className="flex items-center gap-3">
                          <button
                            onClick={handleTogglePlay}
                            aria-label={isPlaying ? t("暂停") : t("播放")}
                            className="w-9 h-9 rounded-xl bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center transition shadow-lg shadow-rose-950/60"
                          >
                            {isPlaying ? <Pause className="w-4 h-4 fill-white" /> : <Play className="w-4 h-4 fill-white ms-0.5" />}
                          </button>

                          <button
                            disabled={currentEpisodeIndex <= 0}
                            onClick={() => setCurrentEpisodeIndex((i) => i - 1)}
                            title={t("上一集 (P)")}
                            className="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>

                          <button
                            disabled={currentEpisodeIndex >= activeSeries.episodes.length - 1}
                            onClick={() => setCurrentEpisodeIndex((i) => i + 1)}
                            title={t("下一集 (N)")}
                            className="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>

                          <div dir="ltr" className="text-slate-300 font-mono text-xs ps-1 whitespace-nowrap">
                            <span className="text-white font-bold">{formatTime(currentTime)}</span>
                            <span className="text-slate-500 mx-1">/</span>
                            <span>{formatTime(duration)}</span>
                          </div>
                        </div>

                        {/* 右侧控制：倍速、画质、连播、音量、全屏 */}
                        <div className="flex items-center gap-2 md:gap-3">
                          {/* ⚡ 倍速选择菜单 */}
                          <div className="relative">
                            <button
                              onClick={() => {
                                setShowSpeedMenu(!showSpeedMenu);
                                setShowQualityMenu(false);
                              }}
                              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold transition border ${
                                playbackSpeed !== 1.0
                                  ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                                  : "bg-slate-900/80 hover:bg-slate-800 text-slate-300 border-slate-700/80"
                              }`}
                            >
                              <Gauge className="w-3.5 h-3.5" />
                              <span>{playbackSpeed}x</span>
                            </button>

                            {showSpeedMenu && (
                              <div className="absolute bottom-11 end-0 bg-slate-900/95 border border-slate-700 rounded-2xl p-1.5 shadow-2xl backdrop-blur flex flex-col gap-1 w-24 z-40">
                                <div className="px-2 py-1 text-[10px] text-slate-400 font-bold border-b border-slate-800">{t("播放倍速")}</div>
                                {[0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map((s) => (
                                  <button
                                    key={s}
                                    onClick={() => handleSelectSpeed(s)}
                                    className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                                      playbackSpeed === s
                                        ? "bg-rose-600 text-white font-bold"
                                        : "hover:bg-slate-800 text-slate-300"
                                    }`}
                                  >
                                    <span>{s}x</span>
                                    {playbackSpeed === s && <Check className="w-3.5 h-3.5" />}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* 📺 官方真实清晰度选择菜单 */}
                          <div className="relative">
                            <button
                              onClick={() => {
                                setShowQualityMenu(!showQualityMenu);
                                setShowSpeedMenu(false);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900/80 hover:bg-slate-800 text-rose-400 font-bold text-xs border border-rose-500/30 transition shadow-sm"
                            >
                              <Sliders className="w-3.5 h-3.5" />
                              <span>{currentQuality}</span>
                            </button>

                            {showQualityMenu && (
                              <div className="absolute bottom-11 end-0 bg-slate-900/95 border border-slate-700 rounded-2xl p-1.5 shadow-2xl backdrop-blur flex flex-col gap-1 w-36 z-40">
                                <div className="px-2.5 py-1 text-[10px] text-slate-400 font-bold border-b border-slate-800 flex items-center justify-between">
                                  <span>{t("官方真实画质")}</span>
                                  {qualitiesLoading && <RefreshCw className="w-2.5 h-2.5 animate-spin text-rose-400" />}
                                </div>
                                {videoQualities.length > 0 ? (
                                  videoQualities.map((q) => (
                                    <button
                                      key={q.key}
                                      onClick={() => handleSelectQuality(q.key)}
                                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                                        currentQuality === q.key
                                          ? "bg-rose-600 text-white font-bold"
                                          : "hover:bg-slate-800 text-slate-300"
                                      }`}
                                    >
                                      <span>{localizeLabel(q.label)}</span>
                                      {currentQuality === q.key && <Check className="w-3.5 h-3.5" />}
                                    </button>
                                  ))
                                ) : (
                                  <div className="px-2.5 py-2 text-xs text-slate-500">
                                    {qualitiesLoading ? t("加载官方画质中...") : t("1080P 超清")}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* 🔁 自动连播开关 */}
                          <button
                            onClick={() => {
                              setAutoPlayNext(!autoPlayNext);
                              showToast(autoPlayNext ? "已关闭自动连播" : "已开启自动连播");
                            }}
                            className={`hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-bold transition border ${
                              autoPlayNext
                                ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                                : "bg-slate-900/80 text-slate-400 border-slate-800"
                            }`}
                          >
                            <span>{t("连播:")}{autoPlayNext ? t("开") : t("关")}</span>
                          </button>

                          {/* 🔊 音量控制 */}
                          <div className="hidden sm:flex items-center gap-1.5 bg-slate-900/80 border border-slate-800 px-2.5 py-1.5 rounded-xl">
                            <button onClick={handleToggleMute} aria-label={t("静音切换")} className="text-slate-300 hover:text-white transition">
                              {isMuted || volume === 0 ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
                            </button>
                            <input
                              type="range"
                              aria-label={t("音量调节")}
                              min={0}
                              max={1}
                              step={0.05}
                              value={isMuted ? 0 : volume}
                              onChange={handleVolumeChange}
                              className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-rose-500"
                            />
                          </div>

                          {/* ⛶ 全屏按钮 */}
                          <button
                            onClick={toggleFullscreen}
                            title={t("全屏 (F)")}
                            className="p-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 text-slate-300 hover:text-white transition"
                          >
                            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* 🌟 任务 03: 全剧终「片尾推荐弹窗」（仅在全剧彻底播放完后显示，播放中绝对不显示） */}
                    {showSeriesEndModal && seriesEndTarget && !isPlaying && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/85 backdrop-blur-md animate-fade-in select-none"
                      >
                        <div className="relative w-full max-w-sm sm:max-w-md md:max-w-lg bg-gradient-to-b from-slate-900/95 to-slate-950/95 border border-slate-700/80 rounded-2xl md:rounded-3xl p-5 md:p-7 shadow-2xl text-center space-y-4 md:space-y-5">
                          {/* 右上角关闭按钮 */}
                          <button
                            onClick={() => setShowSeriesEndModal(false)}
                            className="absolute top-3.5 end-3.5 p-2 rounded-full text-slate-400 hover:text-white hover:bg-slate-800/80 transition"
                            title={t("留在本剧")}
                          >
                            <X className="w-5 h-5" />
                          </button>

                          {/* 撒花 / 追完提示 */}
                          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 font-bold text-xs md:text-sm">
                            <Trophy className="w-4 h-4 text-amber-400" />
                            <span>
                              {seriesEndTarget.tags === "同系列下一季"
                                ? t("恭喜追完当前季！即将连播下一季")
                                : t("追完全集", { title: activeSeries.title })}
                            </span>
                          </div>

                          <div className="space-y-1">
                            <h2 className="text-lg md:text-2xl font-black text-white tracking-wide">
                              {seriesEndTarget.tags === "同系列下一季"
                                ? t("为您自动连播同系列下一季")
                                : t("为您精选下一部同类爆款")}
                            </h2>
                            <p className="text-xs md:text-sm text-slate-400">
                              {seriesEndTarget.tags === "同系列下一季"
                                ? t("原班人马精彩剧情不间断，即刻无缝续看下一季！")
                                : t("高分好剧连播不间断，精彩剧情即刻续享")}
                            </p>
                          </div>

                          {/* 精选短剧卡片 (点击立即播放) */}
                          <div
                            onClick={() => {
                              setShowSeriesEndModal(false);
                              handleSelectSeries(seriesEndTarget);
                            }}
                            className="flex items-center gap-3.5 md:gap-4 p-3 md:p-4 rounded-2xl bg-slate-800/60 hover:bg-slate-800/90 border border-slate-700/70 hover:border-rose-500/50 transition cursor-pointer text-start group"
                          >
                            <div className="relative w-18 md:w-24 aspect-[3/4] rounded-xl overflow-hidden shrink-0 bg-slate-800 shadow-lg">
                              <img
                                src={seriesEndTarget.cover}
                                alt={seriesEndTarget.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                              <div className="absolute inset-0 bg-black/20 group-hover:bg-transparent transition" />
                              <div className="absolute bottom-1 end-1 px-1.5 py-0.5 rounded bg-black/75 text-[10px] text-white font-medium">
                                {localizeLabel(seriesEndTarget.badge) || t("全集")}
                              </div>
                            </div>

                            <div className="flex-1 min-w-0 space-y-1.5">
                              <div className="flex items-center gap-2">
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-600/20 text-rose-400 border border-rose-500/30">
                                  {localizeLabel(seriesEndTarget.tags) || t("同类好剧")}
                                </span>
                              </div>
                              <h4 className="font-bold text-sm md:text-base text-white group-hover:text-rose-400 transition truncate">
                                {seriesEndTarget.title}
                              </h4>
                              <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                                {seriesEndTarget.description || t("精彩短剧连播，高潮迭起，逆袭反转不停歇！")}
                              </p>
                            </div>
                          </div>

                          {/* 倒计时提示与换一部 */}
                          <div className="flex items-center justify-between text-xs font-semibold px-1">
                            <span className="text-slate-400 flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                              {t("倒计时连播", { seconds: seriesEndCountdown })}
                            </span>
                            <button
                              onClick={handleSwitchNextSeriesRecommendation}
                              className="text-slate-400 hover:text-slate-200 flex items-center gap-1 transition"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />{t("换一部推荐")}</button>
                          </div>

                          {/* 倒计时进度条 */}
                          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-rose-500 via-rose-400 to-amber-500 transition-all duration-1000 ease-linear rounded-full"
                              style={{ width: `${(seriesEndCountdown / 5) * 100}%` }}
                            />
                          </div>

                          {/* 操作按钮组 */}
                          <div className="flex items-center gap-3 pt-1">
                            <button
                              onClick={() => setShowSeriesEndModal(false)}
                              className="flex-1 py-2.5 md:py-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold text-xs md:text-sm transition"
                            >{t("留在本剧")}</button>
                            <button
                              onClick={() => {
                                setShowSeriesEndModal(false);
                                handleSelectSeries(seriesEndTarget);
                              }}
                              className="flex-[1.5] py-2.5 md:py-3 rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 hover:from-rose-500 hover:to-rose-400 text-white font-bold text-xs md:text-sm shadow-lg shadow-rose-900/50 flex items-center justify-center gap-2 transition hover:scale-[1.02]"
                            >
                              <Play className="w-4 h-4 fill-white" />
                              {t("立即播放")} ({seriesEndCountdown}s)
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-slate-400 text-sm text-center p-4">
                    {playbackError ? <div role="alert">{localizeError(playbackError)} <button className="underline ms-2" onClick={retryDetailPlayback}>{t("重试")}</button></div> : t("加载中...")}
                  </div>
                )}
                {currentEpisode && mobilePrototype && detailLocked && <div className="detail-social-actions"><EpisodeInteractions key={currentEpisode.id} seriesId={activeSeries.id} episodeId={currentEpisode.id} title={activeSeries.title} session={accountState.session} onLogin={() => setAccountPanel('login')} /></div>}
              </div>
              {currentEpisode && !mobilePrototype && <div className="desktop-social-actions"><EpisodeInteractions key={currentEpisode.id} seriesId={activeSeries.id} episodeId={currentEpisode.id} title={activeSeries.title} session={accountState.session} onLogin={() => setAccountPanel('login')} /></div>}

              {/* 左侧播放器下方：轻量操作条（上下集切换） */}
              <div className={`flex flex-wrap items-center justify-between gap-3 pt-1 ${mobilePrototype ? "prototype-legacy-player-controls" : ""}`}>
                <div className="flex items-center gap-3">
                  <button
                    tabIndex={9}
                    disabled={currentEpisodeIndex <= 0}
                    onClick={() => {
                      setShowSeriesEndModal(false);
                      setCurrentEpisodeIndex((i) => i - 1);
                    }}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold transition outline-none focus:ring-2 focus:ring-rose-500"
                  >
                    <ChevronLeft className="w-4 h-4" />{t("上一集")}</button>
                  <button
                    tabIndex={10}
                    disabled={currentEpisodeIndex >= activeSeries.episodes.length - 1}
                    onClick={() => {
                      setShowSeriesEndModal(false);
                      setCurrentEpisodeIndex((i) => i + 1);
                    }}
                    className="flex items-center gap-2 px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold transition outline-none focus:ring-4 focus:ring-rose-500/50 shadow-lg shadow-rose-900/40"
                  >{t("下一集")}<ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="text-xs text-slate-400 font-medium">
                  {t("正在播放第{{number}}集", { number: currentEpisode?.number || currentEpisodeIndex + 1 })} · {t("共{{count}}集", { count: activeSeries.episodes.length })}
                </div>
              </div>

              {/* 🌟「为你推荐 · 同类好剧」专区 (严格放置在系列季数左侧，播放器正下方) */}
              <PlayerPanel enabled={mobilePrototype} open={mobileRelatedOpen} label={t("为你推荐")} onClose={() => setMobileRelatedOpen(false)}>
              <div className="w-full pt-6 border-t border-slate-800/80 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-bold text-white flex items-center gap-2">{t("为你推荐")}</h3>
                    {relatedKeyword && (
                      <span className="text-xs px-2.5 py-0.5 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 font-normal">{t("关联标签:")}{localizeLabel(relatedKeyword)}
                      </span>
                    )}
                  </div>

                  {/* 🔄「换一批」智能实时换剧与微动效按钮 */}
                  <button
                    type="button"
                    onClick={handleRefreshRecommend}
                    disabled={relatedLoading || relatedRefreshing}
                    className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700/90 active:scale-95 text-xs font-semibold text-slate-300 hover:text-white border border-slate-700/60 hover:border-rose-500/50 shadow-sm transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed group outline-none focus:ring-2 focus:ring-rose-500/50"
                    title={t("换一批推荐短剧")}
                  >
                    <RefreshCw
                      style={{
                        transform: `rotate(${refreshRotateDeg}deg)`,
                        transition: "transform 0.65s cubic-bezier(0.34, 1.56, 0.64, 1)",
                      }}
                      className={`w-3.5 h-3.5 text-rose-400 group-hover:text-rose-300 ${
                        relatedRefreshing ? "animate-spin" : ""
                      }`}
                    />
                    <span>{t("换一批")}</span>
                  </button>
                </div>

                {/* 推荐卡片列表：标准 5 列栅格，3 排共 15 部 (严格还原图一优酷版式)，具备平滑切换动效 */}
                {relatedLoading ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {Array.from({ length: 15 }).map((_, idx) => (
                      <div
                        key={idx}
                        className="animate-pulse bg-[#0a0f1d] border border-slate-800/60 rounded-2xl p-2.5 space-y-2.5"
                      >
                        <div className="aspect-[3/4] bg-slate-800/60 rounded-xl" />
                        <div className="h-4 bg-slate-800/60 rounded w-3/4" />
                        <div className="h-3 bg-slate-800/40 rounded w-1/2" />
                      </div>
                    ))}
                  </div>
                ) : relatedSeries.length > 0 ? (
                  <div
                    className={`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 transition-all duration-300 ease-out ${
                      recommendFadeIn ? "opacity-100 translate-y-0" : "opacity-30 translate-y-1"
                    }`}
                  >
                    {relatedSeries.slice(0, 15).map((item) => (
                      <div
                        key={item.id}
                        tabIndex={0}
                        onClick={() => handleSelectSeries(item)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSelectSeries(item);
                        }}
                        className="group flex flex-col rounded-2xl overflow-hidden bg-[#0a0f1d] border border-slate-800/80 hover:border-rose-500/60 hover:shadow-2xl hover:shadow-rose-950/30 hover:-translate-y-1.5 transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70"
                      >
                        <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                          <img
                            src={item.cover}
                            alt={item.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            loading="lazy"
                          />
                          {item.badge && (
                            <span className="absolute top-2 end-2 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-rose-600/90 text-white shadow-md">
                              {localizeLabel(item.badge)}
                            </span>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-rose-300">
                              <Play className="w-4 h-4 fill-rose-300" />{t("点击换剧")}</span>
                          </div>
                        </div>
                        <div className="p-3 flex flex-col flex-1 justify-between gap-1">
                          <h4 className="font-bold text-sm leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                            {item.title}
                          </h4>
                          <p className="text-xs text-slate-500 line-clamp-1">
                            {localizeLabel(item.tags) || t("同类好剧")}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-500 text-sm bg-slate-900/30 rounded-2xl border border-slate-800">{t("暂无同类推荐短剧")}</div>
                )}
              </div>
              </PlayerPanel>
            </div>

            {/* 右侧面板 (1排6个共5排30集，自然紧凑高度，减少两排卡片高度) */}
            <PlayerPanel enabled={mobilePrototype} open={mobileEpisodesOpen} label={t("选集")} onClose={() => setMobileEpisodesOpen(false)}>
            <div style={mobilePrototype ? { width: "100%" } : undefined} className="w-full lg:w-[480px] xl:w-[520px] 2xl:w-[560px] flex flex-col bg-[#0a0f1d] border border-slate-800 rounded-2xl p-5 shrink-0 self-start">
              <div>
                {/* 1. 顶部 Tab 标签栏 */}
                <div className={`flex items-center gap-6 border-b border-slate-800/80 pb-3 mb-4 ${mobilePrototype ? "prototype-legacy-player-controls" : ""}`}>
                  <button className="text-base font-bold text-white border-b-2 border-rose-500 pb-1 -mb-3.5">{t("视频")}</button>
                </div>

                {/* 2. 剧名与题材热度标签 */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-lg font-extrabold text-white leading-snug line-clamp-1">
                      {activeSeries.title}
                    </h2>
                    <button
                      tabIndex={8}
                      onClick={() => handleToggleFav(activeSeries)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition shrink-0 outline-none focus:ring-2 focus:ring-rose-500 ${
                        favorites.some((f) => f.id === activeSeries.id)
                          ? "bg-rose-500/20 text-rose-400 border border-rose-500/40"
                          : "bg-slate-800 hover:bg-slate-700 text-slate-300"
                      }`}
                    >
                      <Heart
                        className={`w-3.5 h-3.5 ${
                          favorites.some((f) => f.id === activeSeries.id)
                            ? "fill-rose-500 text-rose-500"
                            : "text-slate-400"
                        }`}
                      />
                      {favorites.some((f) => f.id === activeSeries.id) ? t("已追剧") : t("追剧")}
                    </button>
                  </div>

                  {mobilePrototype && <button className="prototype-info-toggle" aria-expanded={mobileDetailInfoOpen} onClick={() => setMobileDetailInfoOpen(value => !value)}>{t(mobileDetailInfoOpen ? "收起剧集信息" : "展开剧集信息")}<ChevronDown size={14} /></button>}
                  <div className={`${mobilePrototype && !mobileDetailInfoOpen ? "hidden" : "flex"} flex-wrap items-center gap-2 text-[11px] text-slate-400`}>
                    <span className="text-rose-400 font-semibold flex items-center gap-1">{t("🔥 连载中")}</span>
                    <span>·</span>
                    <span>{t("共{{count}}集", { count: activeSeries.episodes.length })}</span>
                    {activeSeries.tags && (
                      <>
                        <span>·</span>
                        <span className="text-slate-300">{localizeLabel(activeSeries.tags)}</span>
                      </>
                    )}
                  </div>

                  <p className={`text-xs text-slate-400 leading-relaxed line-clamp-2 ${mobilePrototype && !mobileDetailInfoOpen ? "hidden" : ""}`}>
                    {activeSeries.description || t("暂无剧集简介")}
                  </p>
                </div>

                {/* 选集头部与区间选择器 (点击展开完整区间面板) */}
                <div className="pt-2 pb-2 border-t border-slate-800/80">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Film className="w-4 h-4 text-rose-500" />
                      <span className="font-bold text-sm text-white">{t("选集")}</span>
                      <span className="text-xs text-slate-400 font-mono">
                        {t("共{{count}}集", { count: activeSeries.episodes.length })}
                      </span>
                    </div>

                    {/* 区间切换触发器（带有展开/收起浮动面板功能） */}
                    {activeSeries.episodes.length > 30 && (
                      <button
                        onClick={() => setShowRangeDropdown(!showRangeDropdown)}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-xs font-semibold text-rose-400 hover:text-rose-300 border border-slate-700/60 transition"
                        title={t("点击展开选择剧集区间")}
                      >
                        <span>
                          {t("集数范围", { start: episodeRangeIndex * 30 + 1, end: Math.min((episodeRangeIndex + 1) * 30, activeSeries.episodes.length) })}
                        </span>
                        {showRangeDropdown ? (
                          <ChevronUp className="w-3.5 h-3.5 text-rose-400" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5 text-rose-400" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 3. 展开时显示区间选择面板，收起时显示 30 集卡片网格 */}
              {showRangeDropdown ? (
                <div className="pt-3 flex-1">
                  <div className="p-3 rounded-xl bg-slate-900/95 border border-slate-700/80 shadow-2xl backdrop-blur">
                    <div className="text-[11px] font-bold text-slate-400 mb-2.5 flex items-center justify-between">
                      <span className="text-slate-300">{t("快速跳转分段区间 (每组30集)")}</span>
                      <button
                        onClick={() => setShowRangeDropdown(false)}
                        className="text-xs text-rose-400 hover:text-rose-300 font-semibold"
                      >{t("返回选集")}</button>
                    </div>
                    <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 max-h-[260px] overflow-y-auto pe-1">
                      {Array.from({ length: Math.ceil(activeSeries.episodes.length / 30) }).map((_, rIdx) => {
                        const start = rIdx * 30 + 1;
                        const end = Math.min((rIdx + 1) * 30, activeSeries.episodes.length);
                        const isCurrentRange = episodeRangeIndex === rIdx;
                        return (
                          <button
                            key={rIdx}
                            onClick={() => {
                              setEpisodeRangeIndex(rIdx);
                              setShowRangeDropdown(false);
                            }}
                            className={`py-2 px-1 rounded-lg text-xs font-bold transition text-center ${
                              isCurrentRange
                                ? "bg-rose-600 text-white shadow-md shadow-rose-900/50"
                                : "bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white"
                            }`}
                          >
                            {start}-{end}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                /* 选集网格：1排6个共5排 */
                <div className="grid grid-cols-6 gap-2.5 pt-3">
                  {activeSeries.episodes
                    .slice(episodeRangeIndex * 30, (episodeRangeIndex + 1) * 30)
                    .map((ep, idx) => {
                      const actualIdx = episodeRangeIndex * 30 + idx;
                      const isCurrent = actualIdx === currentEpisodeIndex;
                      return (
                        <button
                          key={ep.id}
                          onClick={() => {
                            setShowSeriesEndModal(false);
                            setCurrentEpisodeIndex(actualIdx);
                            if (mobilePrototype) setMobileEpisodesOpen(false);
                          }}
                          title={t("第{{number}}集", { number: ep.number || actualIdx + 1 })}
                          className={`h-12 rounded-xl text-sm font-extrabold transition-all outline-none focus:ring-2 focus:ring-rose-500/70 flex items-center justify-center relative shadow-sm ${
                            isCurrent
                              ? "bg-rose-600 text-white shadow-md shadow-rose-900/60 scale-105 z-10 ring-2 ring-rose-400"
                              : "bg-slate-800/85 hover:bg-slate-700/90 text-slate-200 hover:text-white"
                          }`}
                        >
                          {actualIdx >= 3 && !hasVipAccess && <Crown className="episode-vip-marker" aria-label="VIP" />}
                          {isCurrent && !detailLocked ? (
                            <div className="flex items-center gap-1">
                              <span className="w-1 h-3 bg-white rounded-full animate-bounce" />
                              <span className="w-1 h-4.5 bg-white rounded-full animate-bounce [animation-delay:0.15s]" />
                              <span className="w-1 h-2.5 bg-white rounded-full animate-bounce [animation-delay:0.3s]" />
                            </div>
                          ) : (
                            ep.number || actualIdx + 1
                          )}
                        </button>
                      );
                    })}
                </div>
              )}

              {/* 🌟 4. 重点实现：选集下方的同系列剧集列表（整卡可点，与播放深度结合，无多余按钮） */}
              <div className="mt-6 pt-4 border-t border-slate-800/80 space-y-3.5">
                <div className="flex items-center justify-between px-0.5">
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-rose-500" />
                    <span className="font-extrabold text-sm text-white">{t("同系列")}</span>
                  </div>
                  <span className="text-[11px] text-slate-400">{t("点击卡片直接播放")}</span>
                </div>

                {/* 同系列卡片纵向排布列表（显示区域限制显示6个，其他支持滚动浏览） */}
                <div className="flex flex-col gap-3 max-h-[855px] overflow-y-auto pe-1.5 select-none">
                  {(seasonsList.length > 0
                    ? seasonsList
                    : [
                        {
                          seriesId: activeSeries.id,
                          title: activeSeries.title,
                          baseTitle: activeSeries.title,
                          seasonNumber: 1,
                          seasonLabel: "第1季",
                          cover: activeSeries.cover,
                          badge: activeSeries.badge || t("全集"),
                          episodeCount: activeSeries.episodes.length,
                        },
                      ]
                  ).map((season) => {
                    const isPlayingThis = String(season.seriesId) === String(activeSeries.id);

                    return (
                      <div
                        key={season.seriesId}
                        tabIndex={0}
                        onClick={() => handleSwitchSeason(season)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSwitchSeason(season);
                        }}
                        className={`relative flex items-center gap-3.5 p-3 rounded-2xl border transition-all duration-300 group cursor-pointer outline-none focus:ring-2 focus:ring-rose-500/70 select-none ${
                          isPlayingThis
                            ? "bg-gradient-to-r from-rose-950/40 via-slate-900 to-[#0c0f18] border-rose-500/60 shadow-lg shadow-rose-950/30"
                            : "bg-gradient-to-r from-[#121624] via-[#101420] to-[#0c0f18] border-slate-800/80 hover:border-rose-500/50 hover:shadow-xl hover:-translate-y-0.5"
                        }`}
                      >
                        {/* 左侧海报封面 (带 hover 微播放浮层动效) */}
                        <div className="relative w-20 aspect-[3/4] rounded-xl overflow-hidden shrink-0 bg-slate-900 border border-slate-800 shadow-md">
                          <img
                            src={season.cover || activeSeries.cover}
                            alt={season.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            loading="lazy"
                          />
                          {!isPlayingThis && (
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <Play className="w-5 h-5 text-white fill-white drop-shadow-md" />
                            </div>
                          )}
                        </div>

                        {/* 右侧季数详情区 */}
                        <div className="flex-1 min-w-0 flex flex-col justify-between self-stretch py-0.5 space-y-1">
                          {/* 顶部标签行：全集标签 + 正在播放状态 */}
                          <div className="flex items-center justify-between">
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#1a233a] text-slate-300 border border-slate-700/50">
                              {(season.episodeCount || isPlayingThis) ? t("共{{count}}集", { count: season.episodeCount || activeSeries.episodes.length }) : t("选集")}
                            </span>
                            {isPlayingThis && (
                              <span className="text-[10px] text-rose-400 font-bold flex items-center gap-1 bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/30">
                                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />{t("正在播放")}</span>
                            )}
                          </div>

                          {/* 大标题：加粗白色季数全名 */}
                          <h4
                            className={`font-black text-sm text-white tracking-tight leading-snug line-clamp-1 transition ${
                              isPlayingThis ? "text-rose-400" : "group-hover:text-rose-300"
                            }`}
                            title={season.title}
                          >
                            {season.title}
                          </h4>

                          {/* 剧情简介：2 行自然截断 */}
                          <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                            {isPlayingThis
                              ? activeSeries.description || t("全网高分热门力作，逆袭反转不停歇！")
                              : t("暂无剧集简介")}
                          </p>

                          {/* 底部操作区域 */}
                          <div className="flex items-center justify-between pt-1">
                            {!isPlayingThis && (
                              <span className="text-[11px] text-slate-500 group-hover:text-rose-400 font-medium transition flex items-center gap-0.5">{t("点击播放")}<ChevronRight className="w-3 h-3" />
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            </PlayerPanel>
          </div>
        </div>
      ) : null}

        {/* ======================= 2. 官方首页板块 (Home) ======================= */}
        {!activeSeries && tab === "home" && (
          <div className="max-w-7xl mx-auto space-y-8 pb-14">
            {/* 🌟 官方级顶部大宽屏 Banner 轮播 */}
            {currentBanner && (
              <div className="relative rounded-3xl overflow-hidden border border-slate-800/80 shadow-2xl group min-h-[280px] md:min-h-[360px] flex items-end p-6 md:p-10">
                <img
                  src={currentBanner.backgroundCover || currentBanner.cover}
                  alt={currentBanner.title}
                  className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#070a12] via-[#070a12]/60 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-r from-[#070a12]/90 via-transparent to-transparent" />

                <div className="relative z-10 max-w-2xl space-y-3">
                  {currentBanner.titleImage ? (
                    <img src={currentBanner.titleImage} alt={currentBanner.title} className="h-10 md:h-14 object-contain" />
                  ) : (
                    <h2 className="text-2xl md:text-4xl font-extrabold text-white tracking-tight">{currentBanner.title}</h2>
                  )}

                  <div className="flex items-center gap-2 text-xs font-semibold text-rose-400">
                    <span className="px-2.5 py-0.5 rounded-full bg-rose-500/20 border border-rose-500/30">{t("官方主打推荐")}</span>
                    <span>{currentBanner.tags}</span>
                  </div>

                  <p className="text-xs md:text-sm text-slate-300 line-clamp-2 leading-relaxed">
                    {currentBanner.description}
                  </p>

                  <div className="pt-2 flex items-center gap-4">
                    <button
                      onClick={() => handleSelectSeries(currentBanner)}
                      className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 text-sm font-bold shadow-xl shadow-rose-900/50 transition-all scale-100 hover:scale-105 outline-none focus:ring-4 focus:ring-rose-500/60"
                    >
                      <Play className="w-4 h-4 fill-white" />{t("立即观看")}</button>
                    <button
                      onClick={() => handleToggleFav(currentBanner)}
                      className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-slate-900/80 hover:bg-slate-800 text-sm font-semibold border border-slate-700/80 transition outline-none focus:ring-2 focus:ring-rose-500"
                    >
                      <Heart className="w-4 h-4 text-rose-500" />{t("加入追剧")}</button>
                  </div>
                </div>

                <div className="absolute bottom-6 end-8 z-10 flex gap-2">
                  {banners.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setActiveBannerIndex(idx)}
                      className={`h-2 rounded-full transition-all ${
                        idx === activeBannerIndex ? "w-8 bg-rose-500" : "w-2 bg-slate-600 hover:bg-slate-400"
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 首页专区快速切换 */}
            <div className="flex items-center gap-2 border-b border-slate-800/80 pb-3 overflow-x-auto no-scrollbar">
              {[
                { type: "all", name: "全部热播", icon: Flame },
                { type: "human", name: "真人短剧", icon: UserCheck },
                { type: "comic", name: "热门漫剧", icon: Palette },
                { type: "ai", name: "AI 先锋剧", icon: Bot },
              ].map((tabItem) => {
                const Icon = tabItem.icon;
                const isSelected = selectedHomeSection === tabItem.type;
                return (
                  <button
                    key={tabItem.type}
                    onClick={() => setSelectedHomeSection(tabItem.type)}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all shrink-0 outline-none focus:ring-4 focus:ring-rose-500/50 ${
                      isSelected
                        ? "bg-slate-800 text-rose-400 border border-rose-500/30 shadow-md"
                        : "text-slate-400 hover:text-white hover:bg-slate-800/40"
                    }`}
                  >
                    <Icon className="w-4 h-4" /> {localizeLabel(tabItem.name)}
                  </button>
                );
              })}
            </div>

            {/* 专区短剧网格 */}
            {sections
              .filter((sec) => selectedHomeSection === "all" || sec.type === selectedHomeSection)
              .map((section) => (
                <div key={section.type} className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg md:text-xl font-bold flex items-center gap-2">
                      <span className="w-1.5 h-5 rounded-full bg-rose-500 inline-block" />
                      {localizeLabel(section.name)}
                    </h3>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                    {section.items.map((item) => (
                      <div
                        key={item.id}
                        tabIndex={0}
                        onClick={() => handleSelectSeries(item)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSelectSeries(item); }}
                        className="group flex flex-col rounded-2xl overflow-hidden bg-[#0a0f1d] border border-slate-800/80 hover:border-rose-500/60 hover:shadow-2xl hover:shadow-rose-950/30 hover:-translate-y-1 transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70"
                      >
                        <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                          <img
                            src={item.cover}
                            alt={item.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            loading="lazy"
                          />
                          {item.badge && (
                            <span className="absolute top-2.5 end-2.5 px-2.5 py-0.5 rounded-lg text-[10px] font-bold bg-rose-600/90 text-white shadow-md">
                              {localizeLabel(item.badge)}
                            </span>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3.5">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-rose-300">
                              <Play className="w-4 h-4 fill-rose-300" />{t("点击播放")}</span>
                          </div>
                        </div>
                        <div className="p-3.5 flex flex-col flex-1 justify-between gap-1.5">
                          <h4 className="font-bold text-sm leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                            {item.title}
                          </h4>
                          <p className="text-xs text-slate-500 line-clamp-1">{localizeLabel(item.tags) || t("官方推荐")}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

        {/* ======================= 2.5 沉浸式刷剧流板块 (Recommend - 任务 07: 最大化全屏无白边 + 图二对齐布局) ======================= */}
        {!activeSeries && tab === "recommend" && (
          <div 
            className="w-full h-full flex items-center justify-center relative select-none overflow-hidden bg-black"
            style={mobilePrototype ? { touchAction: "pan-x" } : undefined}
            onPointerDown={event => {
              if (!mobilePrototype || !event.isPrimary || event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, [data-gesture-exclude]")) return;
              streamGestureRef.current = { x: event.clientX, y: event.clientY, at: Date.now() };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={event => {
              const start = streamGestureRef.current;
              streamGestureRef.current = null;
              if (!mobilePrototype || !start) return;
              const dx = event.clientX - start.x, dy = event.clientY - start.y;
              if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - start.at < 500) {
                suppressStreamClickUntil.current = Date.now() + 400;
                const video = streamVideoRef.current;
                if (video?.paused) void video.play().catch(() => setStreamIsPlaying(false));
                else video?.pause();
                return;
              }
              if (Math.abs(dy) >= 70 && Math.abs(dy) > Math.abs(dx) * 1.3 && Date.now() - start.at < 1200) {
                suppressStreamClickUntil.current = Date.now() + 400;
                void handleSwitchStream(dy < 0 ? "next" : "prev");
              }
            }}
            onPointerCancel={() => { streamGestureRef.current = null; }}
            onClickCapture={event => {
              if (mobilePrototype && Date.now() < suppressStreamClickUntil.current && !(event.target as HTMLElement).closest("button, input")) { suppressStreamClickUntil.current = 0; event.preventDefault(); event.stopPropagation(); }
            }}
            onWheel={(e) => {
              e.preventDefault();
              if (streamWheelLockRef.current) return;
              if (Math.abs(e.deltaY) < 30) return;
              streamWheelLockRef.current = true;
              if (e.deltaY > 0) {
                handleSwitchStream("next");
              } else {
                handleSwitchStream("prev");
              }
              setTimeout(() => {
                streamWheelLockRef.current = false;
              }, 450);
            }}
          >
            {streamLoading && streamList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-32 text-slate-500 space-y-3">
                <RefreshCw className="w-8 h-8 text-rose-500 animate-spin" />
                <span className="text-sm">{t("正在加载沉浸式短剧推荐流...")}</span>
              </div>
            ) : streamList.length === 0 ? (
              <div className="text-center py-32 text-slate-500 text-sm">
                <p>{streamError ? localizeError(streamError) : t("暂无推荐短剧")}</p>
                <button className="mt-4 px-5 py-2 rounded-xl bg-rose-600 text-white" onClick={() => void streamFeedRef.current.retry().catch(() => {})}>{t("重试")}</button>
              </div>
            ) : (() => {
              const currentItem = streamList[streamIndex] || streamList[0];
              const isFav = favorites.some((f) => String(f.id) === String(currentItem.id));
              const streamLocked = !!streamCurrentEpisode && (streamEpisodeIndex >= 3 && !hasVipAccess || streamError === 'VIP_REQUIRED');
              const videoStreamUrl = !streamLocked && streamCurrentEpisode && streamQualityEpisodeId === streamCurrentEpisode.id
                ? streamSource.source?.url || ''
                : "";

              return (
                <div ref={mobilePrototype ? streamPlayerContainerRef : undefined} className={`relative w-full h-full overflow-clip bg-black flex flex-col justify-between group ${mobilePrototype ? "prototype-watch-stage" : ""}`}>
                  {streamLocked && <VipGate cover={currentItem.cover} loading={!accountState.session} onSubscribe={() => setAccountPanel('membership')} />}
                  {streamError && !streamLocked && <div role="alert" className="absolute top-3 start-3 z-50 bg-black/80 rounded-xl p-3 text-rose-200">{localizeError(streamError)} <button className="underline ms-3" onClick={retryStreamPlayback}>{t("重试")}</button></div>}
                  {/* 背景氛围虚化图 (彻底填充屏幕，消除任何黑边死角) */}
                  <div
                    className="absolute inset-0 bg-cover bg-center blur-3xl opacity-25 scale-110 pointer-events-none transition-all duration-700"
                    style={{ backgroundImage: `url(${currentItem.cover})` }}
                  />

                  {/* 核心视频播放器或封面兜底 */}
                  <div 
                    className="absolute inset-0 z-0 flex items-center justify-center cursor-pointer"
                    onClick={() => {
                      const video = streamVideoRef.current;
                      if (!video) return;
                      if (video.paused) {
                        video.play().then(() => setStreamIsPlaying(true)).catch(() => setStreamIsPlaying(false));
                      } else {
                        video.pause();
                        setStreamIsPlaying(false);
                      }
                    }}
                  >
                    {videoStreamUrl ? (
                      <video
                        ref={streamVideoRef}
                        key={`${currentItem.id}-${streamCurrentEpisode?.id || 0}-${streamPlaybackAttempt}`}
                        src={videoStreamUrl}
                        onError={() => { setStreamBuffering(false); setStreamError("无法播放媒体"); setStreamIsPlaying(false); }}
                        onWaiting={event => { if (!event.currentTarget.paused) setStreamBuffering(true); }}
                        onStalled={event => { if (!event.currentTarget.paused) setStreamBuffering(true); }}
                        autoPlay={!accountPanel}
                        playsInline
                        muted={mobilePrototype ? streamMuted : undefined}
                        onPlaying={() => {setStreamBuffering(false);setStreamIsPlaying(true);}}
                        className="w-full h-full object-contain transition-all duration-300"
                        onLoadedMetadata={(e) => {
                          const v = e.currentTarget;
                          v.playbackRate = streamPlaybackSpeed;
                          if (mobilePrototype) { v.volume = streamVolume; v.muted = streamMuted; }
                          if (v.videoWidth && v.videoHeight) {
                            setStreamIsLandscape(v.videoWidth > v.videoHeight);
                          }
                          if (streamQualitySwitchTimeRef.current !== null) {
                            if (streamQualitySwitchTimeRef.current > 0) v.currentTime = streamQualitySwitchTimeRef.current;
                            streamQualitySwitchTimeRef.current = null;
                          }
                          setStreamDuration(v.duration || 0);
                        }}
                        onTimeUpdate={() => {
                          const v = streamVideoRef.current;
                          if (v && !streamIsDraggingProgress && streamQualitySwitchTimeRef.current === null) {
                            const cur = v.currentTime;
                            setStreamCurrentTime(cur);
                            setStreamDuration(v.duration || 0);

                            // 每秒持久化待上传进度，再发送到后端
                            const sec = Math.floor(cur);
                            if (sec >= 0 && streamCurrentEpisode) {
                              saveProgress(currentItem.id, streamCurrentEpisode.id, sec, {
                                title: currentItem.title,
                                cover: currentItem.cover,
                                badge: currentItem.badge,
                                tags: currentItem.tags,
                                episodeNumber: streamCurrentEpisode.number || streamEpisodeIndex + 1,
                                duration: Math.floor(v.duration || 0),
                                completed: v.ended,
                              });
                            }
                          }
                        }}
                        onEnded={() => {
                          // 当前一集播放完毕，记录进度并自动无缝播放下一集
                          if (streamCurrentEpisode) {
                            saveProgress(currentItem.id, streamCurrentEpisode.id, Math.floor(streamDuration || 0), {
                              title: currentItem.title,
                              cover: currentItem.cover,
                              badge: currentItem.badge,
                              tags: currentItem.tags,
                              episodeNumber: streamCurrentEpisode.number || streamEpisodeIndex + 1,
                              duration: Math.floor(streamDuration || 0),
                              completed: true,
                            });
                            refreshHistory();
                          }
                          if (!mobilePrototype || autoPlayNext) handleStreamNextEpisode(true);
                        }}
                        onPlay={() => setStreamIsPlaying(true)}
                        onPause={() => {
                          setStreamBuffering(false);
                          setStreamIsPlaying(false);
                          const v = streamVideoRef.current;
                          if (v && streamCurrentEpisode) {
                            saveProgress(currentItem.id, streamCurrentEpisode.id, Math.floor(v.currentTime || 0), {
                              title: currentItem.title,
                              cover: currentItem.cover,
                              badge: currentItem.badge,
                              tags: currentItem.tags,
                              episodeNumber: streamCurrentEpisode.number || streamEpisodeIndex + 1,
                              duration: Math.floor(v.duration || 0),
                                completed: v.ended,
                            });
                            refreshHistory();
                          }
                        }}
                      />
                    ) : (
                      <img
                        src={currentItem.cover}
                        alt={currentItem.title}
                        className="w-full h-full object-contain transition-all duration-300"
                      />
                    )}

                    {/* 暂停时显示居中播放按钮（参考图二：精致半透明播放三角图标） */}
                    {(streamDetailLoading || streamQualitiesLoading || streamBuffering || streamSource.loading) && !streamError ? (
                      <div role="status" className="absolute inset-0 bg-black/35 flex flex-col gap-3 items-center justify-center pointer-events-none">
                        <RefreshCw className="w-8 h-8 animate-spin text-white" />
                        <span className="text-white">{t("加载中...")}</span>
                      </div>
                    ) : videoStreamUrl && !streamIsPlaying && !streamError && (
                      <div className="absolute inset-0 bg-black/35 backdrop-blur-[2px] flex items-center justify-center z-10">
                        <button type="button" aria-label={t("播放")} className="w-20 h-20 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-md border border-white/30 text-white flex items-center justify-center shadow-2xl scale-105 transition-transform">
                          <Play className="w-10 h-10 fill-white ms-1 text-white opacity-95" />
                        </button>
                      </div>
                    )}

                    {/* 顶部与底部渐变遮罩 (自然烘托文字) */}
                    <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/80 via-black/30 to-transparent pointer-events-none" />
                    <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/95 via-black/60 to-transparent pointer-events-none" />
                  </div>

                  {/* 顶部状态与控制栏：当前分集、倍速、清晰度 */}
                  <div className={`relative z-10 px-3 md:px-6 pt-5 flex flex-wrap gap-2 items-center justify-between text-xs text-white/90 pointer-events-none ${mobilePrototype ? "prototype-stream-top" : ""}`}>
                    <div className="flex items-center gap-2 pointer-events-auto">
                      <span className="px-3.5 py-1.5 rounded-full bg-rose-600/30 text-rose-300 border border-rose-500/40 font-bold text-xs backdrop-blur-md shadow-lg">
                        {t("第{{number}}集", { number: streamCurrentEpisode?.number || streamEpisodeIndex + 1 })}
                      </span>
                      {streamIsLandscape && !mobilePrototype && (
                        <span className="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[11px] font-bold backdrop-blur-md">{t("🖥️ 横屏剧")}</span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 pointer-events-auto">
                      {mobilePrototype ? <PlayerActions key={streamCurrentEpisode?.id || "loading"} unavailable={streamLocked} speed={streamPlaybackSpeed} quality={streamQuality} qualities={streamQualities} loading={streamQualitiesLoading} onSpeed={handleStreamSelectSpeed} onQuality={handleStreamSelectQuality} onSearch={() => openMobileSearch("recommend")} onFullscreen={() => void toggleMobileFullscreen(streamPlayerContainerRef.current, streamVideoRef.current)} autoplay={autoPlayNext} onAutoplay={() => setAutoPlayNext(value => !value)} muted={streamMuted} onMute={() => setStreamMuted(value => !value)} volume={streamVolume} onVolume={value => { if (streamVideoRef.current) streamVideoRef.current.volume = value; setStreamVolume(value); setStreamMuted(value === 0); }} /> : !streamLocked && <>
                      {/* ⚡ 倍速选择菜单 */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setStreamShowSpeedMenu(!streamShowSpeedMenu);
                            setStreamShowQualityMenu(false);
                          }}
                          className={`px-3 py-1.5 rounded-full backdrop-blur-md border text-xs font-bold transition flex items-center gap-1.5 shadow-lg cursor-pointer ${
                            streamPlaybackSpeed !== 1.0
                              ? "bg-amber-500/30 text-amber-300 border-amber-500/50"
                              : "bg-black/60 hover:bg-black/80 text-white/90 border-white/15"
                          }`}
                        >
                          <Gauge className="w-3.5 h-3.5 text-amber-400" />
                          <span>{streamPlaybackSpeed}x</span>
                        </button>

                        {streamShowSpeedMenu && (
                          <div 
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-10 end-0 bg-slate-900/95 border border-slate-700 rounded-2xl p-1.5 shadow-2xl backdrop-blur-md flex flex-col gap-1 w-24 z-40"
                          >
                            <div className="px-2 py-1 text-[10px] text-slate-400 font-bold border-b border-slate-800">{t("播放倍速")}</div>
                            {[0.75, 1.0, 1.25, 1.5, 2.0, 3.0].map((s) => (
                              <button
                                key={s}
                                type="button"
                                onClick={() => handleStreamSelectSpeed(s)}
                                className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                                  streamPlaybackSpeed === s
                                    ? "bg-rose-600 text-white font-bold"
                                    : "hover:bg-slate-800 text-slate-300"
                                }`}
                              >
                                <span>{s}x</span>
                                {streamPlaybackSpeed === s && <Check className="w-3.5 h-3.5" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 📺 官方清晰度选择菜单 */}
                      <div className="relative">
                        <button
                          type="button"
                          disabled={!streamCurrentEpisode || streamQualityEpisodeId !== streamCurrentEpisode.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setStreamShowQualityMenu(!streamShowQualityMenu);
                            setStreamShowSpeedMenu(false);
                          }}
                          className="px-3 py-1.5 rounded-full bg-black/60 hover:bg-black/80 backdrop-blur-md border border-white/15 text-xs font-bold text-rose-300 transition flex items-center gap-1.5 shadow-lg cursor-pointer"
                        >
                          <Sliders className="w-3.5 h-3.5 text-rose-400" />
                          <span>{streamCurrentEpisode && streamQualityEpisodeId === streamCurrentEpisode.id ? streamQuality : t("清晰度画质")}</span>
                        </button>

                        {streamShowQualityMenu && (
                          <div 
                            onClick={(e) => e.stopPropagation()}
                            className="absolute top-10 end-0 bg-slate-900/95 border border-slate-700 rounded-2xl p-1.5 shadow-2xl backdrop-blur-md flex flex-col gap-1 w-32 z-40"
                          >
                            <div className="px-2.5 py-1 text-[10px] text-slate-400 font-bold border-b border-slate-800 flex items-center justify-between">
                              <span>{t("清晰度画质")}</span>
                              {streamQualitiesLoading && <RefreshCw className="w-2.5 h-2.5 animate-spin text-rose-400" />}
                            </div>
                            {streamQualities.length > 0 ? (
                              streamQualities.map((q) => (
                                <button
                                  key={q.key}
                                  type="button"
                                  onClick={() => handleStreamSelectQuality(q.key)}
                                  className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                                    streamQuality === q.key
                                      ? "bg-rose-600 text-white font-bold"
                                      : "hover:bg-slate-800 text-slate-300"
                                  }`}
                                >
                                  <span>{localizeLabel(q.label)}</span>
                                  {streamQuality === q.key && <Check className="w-3.5 h-3.5" />}
                                </button>
                              ))
                            ) : <span className="px-2 py-2 text-xs text-slate-400">{t("加载中...")}</span>}
                          </div>
                        )}
                      </div>

                      <span className="hidden md:inline text-[11px] text-white/70 bg-black/50 px-3 py-1.5 rounded-full backdrop-blur-md border border-white/15 shadow-lg">{t("滚轮 / ↑↓ 键切剧")}</span>
                      </>}
                    </div>
                  </div>

                  {mobilePrototype && streamIsLandscape && videoStreamUrl && <FullscreenWatch key={streamCurrentEpisode?.id} videoRef={streamVideoRef} onClick={() => void toggleMobileFullscreen(streamPlayerContainerRef.current, streamVideoRef.current)} />}

                  {/* 👉 右侧纵向操作栏（严格参考图二排布：头像/追剧、爱心、评论、收藏、分享、切剧） */}
                  <div className="absolute end-3 md:end-6 bottom-20 z-20 flex flex-col items-center gap-4">
                    {/* 1. 作者/剧集头像 + 追剧加号小标 */}
                    <button type="button" data-gesture-exclude aria-label={t(isFav ? "已追剧" : "点击追剧")} aria-pressed={isFav}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleFav(currentItem);
                      }}
                      className="relative cursor-pointer group/avatar flex flex-col items-center mb-1"
                      title={isFav ? t("已追剧") : t("点击追剧")}
                    >
                      <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-white/90 shadow-2xl bg-slate-900 group-hover/avatar:scale-105 transition-transform">
                        <img src={currentItem.cover} alt={currentItem.title} className="w-full h-full object-cover" />
                      </div>
                      <div className={`absolute -bottom-1.5 w-5 h-5 rounded-full flex items-center justify-center text-white text-[12px] font-bold shadow-lg transition-transform ${
                        isFav ? "bg-slate-700 text-white" : "bg-rose-600 scale-110"
                      }`}>
                        {isFav ? "✓" : "+"}
                      </div>
                    </button>

                    {/* 点赞、评论和分享对应当前分集；封面入口继续负责追剧。 */}
                    {streamCurrentEpisode && <EpisodeInteractions key={streamCurrentEpisode.id} seriesId={currentItem.id} episodeId={streamCurrentEpisode.id} title={currentItem.title} session={accountState.session} onLogin={() => setAccountPanel('login')} />}

                    {/* 3. 悬浮切剧上/下按钮 (PC端便捷操作) */}
                    {mobilePrototype ? <PlayerSideAction label={t("下一集")} icon={<ChevronRight size={27} />} disabled={!streamDetail || streamEpisodeIndex >= streamDetail.episodes.length - 1} onClick={() => {
                      const next = streamDetail?.episodes[streamEpisodeIndex + 1];
                      if (next) void handleSelectSeries(currentItem, undefined, next.id);
                    }} /> : <div className="flex flex-col gap-2 pt-1 border-t border-white/10">
                      <button
                        type="button"
                        disabled={streamIndex === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSwitchStream("prev");
                        }}
                        className="w-9 h-9 rounded-full bg-black/45 hover:bg-black/75 disabled:opacity-20 disabled:cursor-not-allowed border border-white/15 flex items-center justify-center text-white transition cursor-pointer"
                        title={t("上一部短剧 (键盘↑)")}
                      >
                        <ChevronUp className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSwitchStream("next");
                        }}
                        className="w-9 h-9 rounded-full bg-black/45 hover:bg-black/75 border border-white/15 flex items-center justify-center text-white transition cursor-pointer"
                        title={t("下一部短剧 (键盘↓)")}
                      >
                        <ChevronDown className="w-5 h-5" />
                      </button>
                    </div>}
                  </div>

                  {/* 👈 左下角信息层与胶囊条（严格参考图二：@创作者/剧名、第X集、#标签、合集条） */}
                  <div data-gesture-exclude={mobilePrototype ? true : undefined} className={`relative ${streamLocked ? 'z-20' : 'z-10'} ps-4 pe-20 md:ps-8 md:pe-24 pb-10 space-y-2.5 max-w-[700px] pointer-events-auto ${mobilePrototype ? "prototype-stream-info" : ""}`}>
                    {/* 剧名与发布/集数信息 */}
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="min-w-0 flex-1 line-clamp-2 text-base md:text-xl font-black text-white leading-snug drop-shadow-md">
                          @{currentItem.title}
                        </h3>
                        {currentItem.badge && (
                          <span className="shrink-0 text-xs text-white/70 font-medium">
                            {localizeLabel(currentItem.badge)}
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-semibold text-white/90 drop-shadow line-clamp-2">
                        {t("第{{number}}集", { number: streamCurrentEpisode?.number || streamEpisodeIndex + 1 })} · <bdi>{currentItem.title}</bdi>
                      </p>
                      {mobilePrototype && <button className="prototype-info-toggle" aria-expanded={streamInfoOpen} onClick={() => setStreamInfoOpen(value => !value)}>{t(streamInfoOpen ? "收起剧集信息" : "展开剧集信息")}<ChevronDown size={14} /></button>}
                      {/* #标签 (参考图二黄色/主题高亮标签) */}
                      <div className={`${mobilePrototype && !streamInfoOpen ? "hidden" : "flex"} flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 max-h-12 overflow-y-auto`}>
                        <span className="text-xs font-bold text-amber-400 drop-shadow whitespace-nowrap">{t("#短剧")}</span>
                        {currentItem.tags?.split("/").map((tag, idx) => (
                          <span key={idx} className="text-xs font-bold text-amber-300 drop-shadow whitespace-nowrap">
                            #{localizeLabel(tag.trim())}
                          </span>
                        ))}
                      </div>
                    </div>

                    {/* 剧情简介（点击展开/折叠） */}
                    <div className={`max-w-[560px] ${mobilePrototype && !streamInfoOpen ? "hidden" : ""}`}>
                      <p 
                        onClick={() => setStreamDescriptionExpanded(!streamDescriptionExpanded)}
                        className={`text-xs text-slate-300/90 leading-relaxed drop-shadow cursor-pointer hover:text-white transition ${
                          streamDescriptionExpanded ? "max-h-28 overflow-y-auto" : "line-clamp-2"
                        }`}
                      >
                        {currentItem.description || t("精彩短剧连播，高潮迭起，逆袭反转不停歇！")}
                      </p>
                    </div>

                    {/* 🌟 底部合集胶囊胶囊条与集数控制 */}
                    <div className="flex items-center gap-3 pt-1 flex-wrap">
                      <button
                        type="button"
                        onClick={() => handleSelectSeries(currentItem)}
                        className="min-w-0 max-w-full px-3 py-2 rounded-xl bg-black/60 hover:bg-black/80 backdrop-blur-md border border-white/20 text-white text-xs font-bold flex items-center gap-2 shadow-xl hover:border-rose-500/60 transition group/col cursor-pointer"
                      >
                        <Layers className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        <span className="min-w-0 truncate" title={currentItem.title}>{t("合集：")}{currentItem.title}</span>
                        <span className="shrink-0 text-slate-400 text-[11px] font-normal border-s border-white/20 ps-2 ms-1">
                          {localizeLabel(currentItem.badge) || t("连载热播")}
                        </span>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-400 group-hover/col:translate-x-0.5 transition-transform" />
                      </button>

                      {/* 快捷下一集按钮 */}
                      {!mobilePrototype && streamDetail && streamDetail.episodes && streamDetail.episodes.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleStreamNextEpisode()}
                          className="px-3.5 py-2 rounded-xl bg-slate-900/80 hover:bg-slate-800 backdrop-blur-md border border-white/15 text-white text-xs font-bold flex items-center gap-1.5 shadow-lg transition cursor-pointer"
                        >
                          <ChevronRight className="w-4 h-4 text-rose-400" />
                          <span>{t("下一集")}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 🌟 底部绝对铺满全宽进度条 (从最左端横跨到最右端，满屏无留白) */}
                  {!streamLocked && <div className="absolute inset-x-0 bottom-0 z-30 flex flex-col group/fullbar pointer-events-auto bg-gradient-to-t from-black/80 via-black/30 to-transparent pt-2 px-0">
                    {/* 时间提示条：悬浮或平时在进度条上方显示 */}
                    <div className="px-6 flex items-center justify-between text-[11px] font-mono text-slate-400 mb-0.5 opacity-80 group-hover/fullbar:opacity-100 transition-opacity">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-bold">{formatTime(streamCurrentTime)}</span>
                        <span className="text-slate-500">/</span>
                        <span>{formatTime(streamDuration)}</span>
                      </div>
                      <span className="text-[10px] text-white/50 group-hover/fullbar:text-white/80 transition-colors">{t("可拖动或点击进度条快进快退")}</span>
                    </div>

                    {/* 满屏横跨可点击/拖拽进度条 */}
                    <div 
                      className="relative w-full h-3 flex items-center cursor-pointer px-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickPos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const newTime = clickPos * streamDuration;
                        if (streamVideoRef.current && streamDuration > 0) {
                          streamVideoRef.current.currentTime = newTime;
                          setStreamCurrentTime(newTime);
                          if (streamCurrentEpisode) {
                            saveProgress(currentItem.id, streamCurrentEpisode.id, Math.floor(newTime), {
                              title: currentItem.title,
                              cover: currentItem.cover,
                              badge: currentItem.badge,
                              tags: currentItem.tags,
                              episodeNumber: streamCurrentEpisode.number || streamEpisodeIndex + 1,
                              duration: Math.floor(streamDuration || 0),
                            });
                            refreshHistory();
                          }
                        }
                      }}
                    >
                      <input
                        type="range"
                        aria-label={t("播放进度")}
                        min={0}
                        max={streamDuration || 100}
                        step={0.1}
                        value={streamCurrentTime}
                        onMouseDown={() => setStreamIsDraggingProgress(true)}
                        onTouchStart={() => setStreamIsDraggingProgress(true)}
                        onChange={(e) => {
                          const newTime = parseFloat(e.target.value);
                          setStreamCurrentTime(newTime);
                          if (!streamIsDraggingProgress && streamVideoRef.current) {
                            streamVideoRef.current.currentTime = newTime;
                          }
                        }}
                        onMouseUp={(e) => {
                          setStreamIsDraggingProgress(false);
                          const newTime = parseFloat((e.target as HTMLInputElement).value);
                          if (streamVideoRef.current) {
                            streamVideoRef.current.currentTime = newTime;
                            if (streamCurrentEpisode) {
                              saveProgress(currentItem.id, streamCurrentEpisode.id, Math.floor(newTime), {
                                title: currentItem.title,
                                cover: currentItem.cover,
                                badge: currentItem.badge,
                                tags: currentItem.tags,
                                episodeNumber: streamCurrentEpisode.number || streamEpisodeIndex + 1,
                                duration: Math.floor(streamDuration || 0),
                              });
                              refreshHistory();
                            }
                          }
                        }}
                        onTouchEnd={(e) => {
                          setStreamIsDraggingProgress(false);
                          const newTime = parseFloat((e.target as HTMLInputElement).value);
                          if (streamVideoRef.current) {
                            streamVideoRef.current.currentTime = newTime;
                            if (streamCurrentEpisode) {
                              saveProgress(currentItem.id, streamCurrentEpisode.id, Math.floor(newTime), {
                                title: currentItem.title,
                                cover: currentItem.cover,
                                badge: currentItem.badge,
                                tags: currentItem.tags,
                                episodeNumber: streamCurrentEpisode.number || streamEpisodeIndex + 1,
                                duration: Math.floor(streamDuration || 0),
                              });
                              refreshHistory();
                            }
                          }
                        }}
                        className="w-full h-1.5 group-hover/fullbar:h-2.5 rounded-none appearance-none cursor-pointer accent-rose-500 bg-white/20 hover:bg-white/30 transition-all m-0 p-0"
                      />
                    </div>
                  </div>}
                </div>
              );
            })()}
          </div>
        )}

        {/* ======================= 3. 官方分类板块 (Category) ======================= */}
        {!activeSeries && tab === "category" && (
          <div className={`max-w-7xl mx-auto space-y-6 pb-14 ${mobilePrototype ? "prototype-category-content" : ""}`}>
            {mobilePrototype && currentBanner && <button className="prototype-featured" onClick={() => handleSelectSeries(currentBanner)}>
              <img src={currentBanner.backgroundCover || currentBanner.cover} alt="" /><div><span>{t("推荐")}</span><h3><bdi>{currentBanner.title}</bdi></h3><span className="prototype-featured-play"><Play size={14} fill="currentColor" />{t("立即观看")}</span></div>
            </button>}
            {mobilePrototype && <CategoryFilters key={selectedCatType} types={categoryTypes} tags={categoryTags} selectedType={selectedCatType} selectedTag={selectedCatTag} loading={categoryTagsLoading} onType={id => { setSelectedCatType(id); setSelectedCatTag(""); setCatPage(1); }} onTag={id => { setSelectedCatTag(id); setCatPage(1); }} />}
            {/* 分类标题与当前状态 */}
            {!mobilePrototype && <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
              <div>
                <h2 className="text-xl md:text-2xl font-extrabold flex items-center gap-2">
                  <Grid className="w-6 h-6 text-rose-500" />{t("官方题材全部分类")}</h2>
                <p className="text-xs text-slate-400 mt-1">
                  {categoryTagsLoading ? t("正在读取官网题材…") : t("分类说明", { count: categoryTags.length })}
                </p>
              </div>

              {/* 一级内容类型选择器 (真人剧 / 漫剧 / AI剧) */}
              <div className="flex items-center gap-2 bg-slate-900/90 p-1.5 rounded-2xl border border-slate-800">
                {categoryTypes.map((type) => (
                  <button
                    key={type.id}
                    onClick={() => {
                      setSelectedCatType(type.id);
                      setSelectedCatTag("");
                      setCatPage(1);
                    }}
                    className={`flex-1 min-w-0 px-2 md:px-4 py-2 rounded-xl text-xs md:text-sm font-bold transition-all outline-none focus:ring-4 focus:ring-rose-500/50 ${
                      selectedCatType === type.id
                        ? "bg-rose-600 text-white shadow-md shadow-rose-900/40"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {localizeLabel(type.name)}
                  </button>
                ))}
              </div>
            </div>}

            {categoryError&&<div role="alert" className="text-sm text-rose-300">{localizeError(categoryError)}<button className="ms-3 underline" onClick={()=>{void loadCategoryTags(selectedCatType);void fetchCategoryList(selectedCatType,selectedCatTag,catPage);}}>{t("重试")}</button></div>}
            {/* 题材以当前官网分类页面为准 */}
            {!mobilePrototype && <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-400">
                <Compass className="w-4 h-4 text-rose-500" />{t("题材筛选：")}</div>
              <div className="flex items-center gap-2 overflow-x-auto pb-2 no-scrollbar flex-wrap">
                <button
                  onClick={() => {
                    setSelectedCatTag("");
                    setCatPage(1);
                  }}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all outline-none focus:ring-2 focus:ring-rose-500 ${
                    selectedCatTag === ""
                      ? "bg-rose-600 text-white shadow-md shadow-rose-900/40"
                      : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                  }`}
                >{t("全部题材")}</button>
                {categoryTags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => {
                      setSelectedCatTag(tag.id);
                      setCatPage(1);
                    }}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all outline-none focus:ring-2 focus:ring-rose-500 ${
                      selectedCatTag === tag.id
                        ? "bg-rose-600 text-white shadow-md shadow-rose-900/40"
                        : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                    }`}
                  >
                    {localizeLabel(tag.name)}
                  </button>
                ))}
              </div>
            </div>}

            {/* 短剧列表网格 */}
            {catLoading ? (
              <div className="flex flex-col items-center justify-center py-28 text-slate-500 space-y-3">
                <RefreshCw className="w-8 h-8 text-rose-500 animate-spin" />
                <span className="text-sm">{t("正在加载官方分类片库...")}</span>
              </div>
            ) : categoryItems.length === 0 ? (
              <div className="text-center py-28 text-slate-500 text-sm">{t("当前筛选分类暂无收录短剧")}</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                {categoryItems.map((item) => (
                  <div
                    key={item.id}
                    tabIndex={0}
                    onClick={() => handleSelectSeries(item)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSelectSeries(item); }}
                    className="group flex flex-col rounded-2xl overflow-hidden bg-[#0a0f1d] border border-slate-800/80 hover:border-rose-500/60 hover:shadow-2xl hover:shadow-rose-950/30 hover:-translate-y-1 transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70"
                  >
                    <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                      <img
                        src={item.cover}
                        alt={item.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        loading="lazy"
                      />
                      {item.badge && (
                        <span className="absolute top-2.5 end-2.5 px-2.5 py-0.5 rounded-lg text-[10px] font-bold bg-rose-600/90 text-white shadow-md">
                          {localizeLabel(item.badge)}
                        </span>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3.5">
                        <span className="flex items-center gap-1.5 text-xs font-bold text-rose-300">
                          <Play className="w-4 h-4 fill-rose-300" />{t("点击播放")}</span>
                      </div>
                    </div>
                    <div className="p-3.5 flex flex-col flex-1 justify-between gap-1.5">
                      <h4 className="font-bold text-sm leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                        {item.title}
                      </h4>
                      <p className="text-xs text-slate-500 line-clamp-1">{localizeLabel(item.tags) || t("官方分类")}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 底部翻页控制器 */}
            <div className="flex items-center justify-center gap-4 pt-6 border-t border-slate-800/80">
              <button
                disabled={catPage <= 1 || catLoading}
                onClick={() => setCatPage((p) => Math.max(1, p - 1))}
                className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold transition outline-none focus:ring-2 focus:ring-rose-500"
              >
                <ChevronLeft className="w-4 h-4" />{t("上一页")}</button>
              <span className="text-xs font-bold font-mono px-4 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-300">
                {t("第{{number}}页", { number: catPage })}
              </span>
              <button
                disabled={catLoading || (categoryTotalPages>0?catPage>=categoryTotalPages:categoryItems.length<24)}
                onClick={() => setCatPage((p) => p + 1)}
                className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold transition outline-none focus:ring-4 focus:ring-rose-500/50 shadow-md shadow-rose-900/40"
              >{t("下一页")}<ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ======================= 4. 官方榜单板块 (Rank: 图一官网宏观风格 + 图二卡片式排布 + Top 100 分页) ======================= */}
        {!activeSeries && tab === "rank" && (
          <div className="max-w-7xl mx-auto space-y-6 pb-16">
            {/* 🌟 4.1 官方级热播榜顶部红色/金色神鸟国风 Banner (对应图一官网) */}
            <div className="relative rounded-3xl overflow-hidden border border-rose-900/40 shadow-2xl bg-gradient-to-r from-[#420d11] via-[#5c131a] to-[#2b080b] p-6 md:p-10 flex flex-col justify-between min-h-[170px] md:min-h-[210px]">
              {/* 背景装饰：右侧发光艺术飞鸟与云霞光效 */}
              <div className="absolute end-0 top-0 bottom-0 w-1/2 pointer-events-none overflow-hidden opacity-60 md:opacity-80">
                <div className="absolute end-12 top-1/2 -translate-y-1/2 w-64 h-64 rounded-full bg-gradient-to-tr from-amber-500/40 to-rose-500/20 blur-3xl" />
                <svg className="absolute end-6 md:end-16 top-1/2 -translate-y-1/2 w-60 h-40 text-amber-200/50 drop-shadow-[0_0_20px_rgba(251,191,36,0.6)]" viewBox="0 0 200 120" fill="currentColor">
                  <path d="M10 60 Q 50 10, 110 30 Q 150 45, 190 20 Q 160 70, 110 65 Q 60 60, 10 60 Z" opacity="0.4" />
                  <path d="M40 70 Q 90 20, 140 40 Q 170 55, 195 35 Q 160 85, 120 75 Q 70 70, 40 70 Z" opacity="0.7" />
                  <circle cx="180" cy="25" r="4" fill="#fef08a" />
                </svg>
              </div>

              {/* 面包屑导航与副标题 */}
              <div className="relative z-10 space-y-2">
                <div className="text-xs text-rose-300/80 font-medium flex items-center gap-1.5">
                  <span className="hover:text-white cursor-pointer" onClick={() => setTab("home")}>{t("首页")}</span>
                  <span>/</span>
                  <span className="text-rose-200 font-semibold">{localizeLabel(currentRankType.name)}</span>
                </div>

                {/* 类似图一官网的大书名号标题 */}
                <h2 className="text-2xl md:text-4xl font-black tracking-tight text-white drop-shadow-md">
                  {localizeLabel(currentRankType.name)}
                </h2>

                <p className="text-xs md:text-sm text-rose-200/80 font-medium pt-0.5">
                  {todayStr}{t("· 基于红果内观看/互动等综合热度排序 · 官方 Top 100")}</p>
              </div>
            </div>

            {/* 🌟 4.2 官方四大子榜单 Tab 切换栏 (对应图一官方标签：红果热播榜 / 真人剧热播榜 / AI剧热播榜 / 漫剧热播榜) */}
            <div className="flex items-center gap-3 border-b border-slate-800/80 pb-3 overflow-x-auto no-scrollbar">
              {rankTypes.map((rt) => {
                const isSelected = selectedRankSlug === rt.slug;
                return (
                  <button
                    key={rt.slug}
                    onClick={() => {
                      setSelectedRankSlug(rt.slug);
                      setRankPage(1);
                    }}
                    className={`px-5 py-2.5 rounded-xl text-xs md:text-sm font-bold transition-all shrink-0 outline-none focus:ring-4 focus:ring-rose-500/50 ${
                      isSelected
                        ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40 scale-105"
                        : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                    }`}
                  >
                    {localizeLabel(rt.name)}
                  </button>
                );
              })}
            </div>

            {/* 🌟 4.3 排行榜单项卡片列表 (采用图二现有卡片式排布，支持电视 TV 遥控与电脑鼠标) */}
            {rankLoading ? (
              <div className="flex flex-col items-center justify-center py-28 text-slate-500 space-y-3">
                <RefreshCw className="w-8 h-8 text-rose-500 animate-spin" />
                <span className="text-sm">{t("正在加载官方前 100 名热播短剧...")}</span>
              </div>
            ) : rankItems.length === 0 ? (
              <div className="text-center py-28 text-slate-500 text-sm">{t("当前榜单暂无数据")}</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4.5">
                {rankItems.map((item, index) => {
                  const rankNum = item.rank || (rankPage - 1) * 20 + index + 1;
                  const isTop1 = rankNum === 1;
                  const isTop2 = rankNum === 2;
                  const isTop3 = rankNum === 3;

                  let rankBadgeBg = "bg-slate-800 text-slate-300";
                  if (isTop1) rankBadgeBg = "bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950 font-black shadow-lg shadow-amber-500/40";
                  else if (isTop2) rankBadgeBg = "bg-gradient-to-r from-slate-200 to-slate-400 text-slate-950 font-black";
                  else if (isTop3) rankBadgeBg = "bg-gradient-to-r from-amber-700 to-amber-600 text-white font-black";

                  return (
                    <div
                      key={item.id}
                      tabIndex={0}
                      onClick={() => handleSelectSeries(item)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSelectSeries(item); }}
                      className={`group relative flex items-center gap-4 p-3.5 rounded-2xl bg-[#0a0f1d] border transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70 ${
                        isTop1
                          ? "border-amber-500/40 hover:border-amber-400 bg-gradient-to-r from-amber-950/20 via-[#0a0f1d] to-[#0a0f1d] hover:shadow-xl hover:shadow-amber-950/30"
                          : "border-slate-800/80 hover:border-rose-500/60 hover:shadow-xl hover:shadow-rose-950/20"
                      }`}
                    >
                      {/* 左侧封面海报与排名数字角标 */}
                      <div className="relative shrink-0 w-20 md:w-24 aspect-[3/4] rounded-xl overflow-hidden bg-slate-900 border border-slate-800">
                        <img
                          src={item.cover}
                          alt={item.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                          loading="lazy"
                        />
                        <div
                          className={`absolute top-0 start-0 min-w-6 h-6 px-1.5 flex items-center justify-center rounded-br-xl text-xs ${rankBadgeBg}`}
                        >
                          {rankNum}
                        </div>
                      </div>

                      {/* 右侧剧集详情与操作栏 */}
                      <div className="flex-1 flex flex-col justify-between py-0.5 min-w-0">
                        <div>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-md font-bold uppercase tracking-wider ${rankBadgeBg}`}
                            >
                              TOP {rankNum}
                            </span>
                            {item.badge && (
                              <span className="text-[10px] text-slate-400 font-medium bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                                {localizeLabel(item.badge)}
                              </span>
                            )}
                          </div>
                          <h4 className="font-bold text-sm md:text-base leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                            {item.title}
                          </h4>
                          <p className="text-xs text-slate-400 mt-1 line-clamp-2 leading-relaxed">
                            {item.description || item.tags || t("官方推荐榜首热剧")}
                          </p>
                        </div>

                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-[11px] text-rose-400/90 font-semibold flex items-center gap-1">
                            <Flame className="w-3.5 h-3.5 fill-rose-500 text-rose-500 shrink-0" />
                            {item.heatText || t("热播指数高")}
                          </span>
                          <span className="text-xs px-3 py-1 rounded-lg bg-rose-600/90 text-white font-bold group-hover:bg-rose-500 transition shadow">{t("立即播放")}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 🌟 4.4 底部官方前 100 名分页翻页控制器 (1~5 页，共 100 名) */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-slate-800/80">
              <div className="text-xs text-slate-400">
                {t("榜单范围", { start: (rankPage - 1) * 20 + 1, end: Math.min(100, rankPage * 20) })}
              </div>

              <div className="flex items-center gap-2">
                <button
                  disabled={rankPage <= 1 || rankLoading}
                  onClick={() => setRankPage((p) => Math.max(1, p - 1))}
                  className="flex items-center gap-1 px-4 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold transition outline-none focus:ring-2 focus:ring-rose-500"
                >
                  <ChevronLeft className="w-4 h-4" />{t("上一页")}</button>

                {[1, 2, 3, 4, 5].map((pageNum) => (
                  <button
                    key={pageNum}
                    disabled={rankLoading}
                    onClick={() => setRankPage(pageNum)}
                    className={`w-9 h-9 rounded-xl text-xs font-bold transition-all outline-none focus:ring-2 focus:ring-rose-500 ${
                      rankPage === pageNum
                        ? "bg-rose-600 text-white shadow-md shadow-rose-900/40 scale-105"
                        : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                    }`}
                  >
                    {pageNum}
                  </button>
                ))}

                <button
                  disabled={rankPage >= rankTotalPages || rankLoading}
                  onClick={() => setRankPage((p) => Math.min(rankTotalPages, p + 1))}
                  className="flex items-center gap-1 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold transition outline-none focus:ring-4 focus:ring-rose-500/50 shadow-md shadow-rose-900/40"
                >{t("下一页")}<ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ======================= 5. 搜索片库板块 (Search - 任务 06 全方位增强) ======================= */}
        {!activeSeries && tab === "search" && (
          <div className="max-w-6xl mx-auto space-y-7 pt-2 pb-14">
            {/* 1. 搜索表单与实时防抖下拉联想 */}
            <div className="relative max-w-3xl mx-auto">
              <form onSubmit={handleSearch} className="flex gap-3">
                <div className="relative flex-1">
                  <Search className="w-5 h-5 absolute start-4 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearchInputChange(e.target.value)}
                    onFocus={() => {
                      if (searchQuery.trim() && searchSuggestions.length === 0) {
                        handleSearchInputChange(searchQuery);
                      }
                    }}
                    placeholder={t("搜索短剧名、主角或关键词（如：太奶奶、反向拿捏、神豪、逆袭...）")}
                    className="w-full ps-12 pe-10 py-3.5 rounded-2xl bg-[#0a0f1d] border border-slate-800 focus:outline-none focus:border-rose-500 focus:ring-4 focus:ring-rose-500/20 text-sm font-medium transition placeholder:text-slate-500"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery("");
                        setShowSuggestions(false);
                        setSearchSuggestions([]);
                        setHasSearched(false);
                        setSearchResults([]);
                        refreshSearchHistory();
                        searchInputRef.current?.focus();
                      }}
                      className="absolute end-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1 rounded-lg transition cursor-pointer"
                      title={t("清除输入")}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={searchLoading}
                  className="px-8 py-3.5 rounded-2xl bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-sm font-bold transition shadow-lg shadow-rose-900/30 shrink-0 outline-none focus:ring-4 focus:ring-rose-500/50 flex items-center gap-2 cursor-pointer"
                >
                  {searchLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  <span>{t("搜索")}</span>
                </button>
              </form>

              {/* 实时输入联想下拉浮层 (Autocomplete Dropdown) */}
              {showSuggestions && searchQuery.trim() && (searchSuggestions.length > 0 || isSuggesting) && (
                <div className="absolute start-0 end-0 top-full mt-2 bg-[#0d1326] border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden z-40 backdrop-blur">
                  <div className="p-2 border-b border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 font-semibold px-3">
                    <span>{t("💡 相关剧集实时联想")}</span>
                    {isSuggesting && <RefreshCw className="w-3 h-3 animate-spin text-rose-400" />}
                  </div>
                  <div className="max-h-[320px] overflow-y-auto divide-y divide-slate-800/40">
                    {searchSuggestions.map((item) => (
                      <div
                        key={item.id}
                        onClick={() => handleSelectSuggestion(item)}
                        className="flex items-center gap-3 p-2.5 hover:bg-slate-800/70 transition cursor-pointer group"
                      >
                        <img
                          src={item.cover}
                          alt={item.title}
                          className="w-10 aspect-[3/4] object-cover rounded-lg shrink-0 bg-slate-900 border border-slate-800"
                        />
                        <div className="flex-1 min-w-0">
                          <h5 className="text-xs md:text-sm font-bold text-white group-hover:text-rose-400 transition truncate">
                            {item.title}
                          </h5>
                          <p className="text-[11px] text-slate-400 truncate mt-0.5">
                            {item.tags || item.badge || t("热门短剧")}
                          </p>
                        </div>
                        <span className="text-[10px] text-slate-500 group-hover:text-rose-400 font-semibold shrink-0 flex items-center gap-0.5">{t("即点即看")}<ChevronRight className="w-3 h-3" />
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 2. 空状态 / 未搜索时的探索区：热门搜索词 + 搜索历史 */}
            {!hasSearched && (
              <div className="max-w-3xl mx-auto space-y-6 pt-2">
                {/* 2.1 热门搜索榜 Top 10 */}
                <div className="bg-[#0a0f1d] border border-slate-800 rounded-2xl p-5 space-y-3.5">
                  <div className="flex items-center gap-2 text-sm font-extrabold text-white">
                    <Flame className="w-4 h-4 text-rose-500 fill-rose-500" />
                    <span>{t("热门搜索推荐")}</span>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    {hotSearchKeywords.map((kw, idx) => (
                      <button
                        key={kw}
                        type="button"
                        onClick={() => executeSearch(kw)}
                        className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-slate-900 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-500/50 text-xs font-semibold text-slate-300 hover:text-rose-400 transition cursor-pointer"
                      >
                        <span
                          className={`text-[10px] font-bold ${
                            idx < 3 ? "text-rose-400" : "text-slate-500"
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <span>{localizeLabel(kw)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 2.2 本地搜索历史 (最近 10 条，支持单条删除与一键清空) */}
                {searchHistoryList.length > 0 && (
                  <div className="bg-[#0a0f1d] border border-slate-800 rounded-2xl p-5 space-y-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-extrabold text-white">
                        <Clock className="w-4 h-4 text-slate-400" />
                        <span>{t("搜索历史")}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          clearSearchHistory();
                          setSearchHistoryList([]);
                          showToast("已清空搜索历史");
                        }}
                        className="text-xs text-slate-500 hover:text-rose-400 flex items-center gap-1 transition cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />{t("清空历史")}</button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {searchHistoryList.map((hist) => (
                        <div
                          key={hist}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800/80 text-xs font-semibold text-slate-300 group hover:border-slate-700 transition"
                        >
                          <span
                            onClick={() => executeSearch(hist)}
                            className="cursor-pointer hover:text-rose-400"
                          >
                            {hist}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const updated = removeSearchHistory(hist);
                              setSearchHistoryList(updated);
                            }}
                            className="text-slate-600 hover:text-slate-300 transition cursor-pointer ms-0.5"
                            title={t("删除")}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 3. 搜索结果展示区 */}
            {hasSearched && (
              <div className="space-y-5">
                {/* 3.1 搜索结果统计与题材快筛栏 */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-extrabold text-white">
                      {t("搜索结果", { query: searchQuery })}
                    </h3>
                    <span className="text-xs text-slate-400 font-mono">
                      {t("搜索结果数量", { count: searchResults.length })}
                    </span>
                  </div>

                  {/* 题材快筛微标签 */}
                  <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
                    {searchFilterTags.map((tag) => {
                      const isSelected = searchFilterTag === tag;
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSearchFilterTag(tag)}
                          className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                            isSelected
                              ? "bg-rose-600 text-white shadow-md shadow-rose-900/40"
                              : "bg-slate-900 border border-slate-800 text-slate-400 hover:text-white"
                          }`}
                        >
                          {localizeLabel(tag)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 3.2 搜索加载中与结果网格 */}
                {searchLoading ? (
                  <div className="flex flex-col items-center justify-center py-28 text-slate-500 space-y-3">
                    <RefreshCw className="w-8 h-8 text-rose-500 animate-spin" />
                    <span className="text-sm">{t("正在检索片库，请稍候...")}</span>
                  </div>
                ) : (
                  (() => {
                    const filteredItems = searchResults.filter((item) => {
                      if (searchFilterTag === "全部") return true;
                      const text = `${item.title} ${item.tags} ${item.description || ""}`;
                      return text.includes(searchFilterTag);
                    });

                    if (filteredItems.length === 0) {
                      return (
                        <div className="text-center py-24 text-slate-500 text-sm space-y-2 bg-[#0a0f1d] border border-slate-800 rounded-2xl">
                          <p>
                            {searchFilterTag === "全部"
                              ? t("搜索无结果", { query: searchQuery })
                              : t("筛选无结果", { genre: localizeLabel(searchFilterTag) })}
                          </p>
                          <p className="text-xs text-slate-600">{t("请尝试更换关键词（如：都市、逆袭、甜宠）或切换全部题材")}</p>
                        </div>
                      );
                    }

                    return (
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                        {filteredItems.map((item) => (
                          <div
                            key={item.id}
                            tabIndex={0}
                            onClick={() => handleSelectSeries(item)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSelectSeries(item);
                            }}
                            className="group flex flex-col rounded-2xl overflow-hidden bg-[#0a0f1d] border border-slate-800/80 hover:border-rose-500/60 hover:shadow-2xl hover:shadow-rose-950/30 hover:-translate-y-1 transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70"
                          >
                            <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                              <img
                                src={item.cover}
                                alt={item.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                loading="lazy"
                              />
                              {item.badge && (
                                <span className="absolute top-2.5 end-2.5 px-2.5 py-0.5 rounded-lg text-[10px] font-bold bg-rose-600/90 text-white shadow-md">
                                  {localizeLabel(item.badge)}
                                </span>
                              )}
                              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                                <span className="flex items-center gap-1.5 text-xs font-bold text-white">
                                  <Play className="w-4 h-4 fill-white text-white" />{t("点击播放")}</span>
                              </div>
                            </div>
                            <div className="p-3.5 flex flex-col flex-1 justify-between gap-1.5">
                              <h4 className="font-bold text-sm leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                                {item.title}
                              </h4>
                              <p className="text-xs text-slate-500 line-clamp-1">
                                {localizeLabel(item.tags) || t("全网高分短剧")}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()
                )}
              </div>
            )}
          </div>
        )}

        {/* ======================= 6. 我的追剧与观看历史板块 (Favorites & History) ======================= */}
        {!activeSeries && tab === "favorites" && !mobileSettingsOpen && (
          <div className={`max-w-7xl mx-auto pb-14 space-y-6 ${mobilePrototype ? "prototype-my-content" : ""}`}>
            {!mobilePrototype && favSubTab === "overview" && <div className="account-home-heading"><h2>{t('我的')}</h2><button aria-label={t('设置')} onClick={() => openPersonalPage('settings')}><SettingsIcon size={22}/></button></div>}
            {(mobilePrototype ? favSubTab !== 'settings' : favSubTab === 'overview') && <AccountHome {...personalAreaProps} profileOnly={mobilePrototype} histories={historyList} error={accountState.error} onRetry={() => void accountState.refresh()} onResume={history => void handleSelectSeries({ id: history.seriesId, title: history.title, cover: history.cover, badge: history.badge, tags: history.tags, description: "", contentType: history.contentType }, history)} />}
            {/* 个人内容切换栏与操作区。 */}
            {!mobilePrototype && favSubTab !== 'overview' && <button className="account-text-button" onClick={() => setFavSubTab("overview")}><ArrowLeft size={16} />{t("返回我的")}</button>}
            {personalContentTab !== "overview" && personalContentTab !== "settings" && <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-4 ${mobilePrototype ? "prototype-my-tabs" : ""}`}>
              <div role={mobilePrototype ? 'tablist' : undefined} aria-label={mobilePrototype ? t('我的') : undefined} className="account-library-tabs flex items-center gap-2 bg-[#0a0f1d] p-1.5 rounded-2xl border border-slate-800 w-fit" onKeyDown={event => {
                if (!mobilePrototype || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                const current = buttons.findIndex(button => button === document.activeElement);
                const step = (event.key === 'ArrowRight' ? 1 : -1) * (document.documentElement.dir === 'rtl' ? -1 : 1);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + step + buttons.length) % buttons.length;
                event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
              }}>
                <button
                  type="button"
                  role={mobilePrototype ? 'tab' : undefined} id="personal-tab-favorites" aria-selected={mobilePrototype ? personalContentTab === 'favorites' : undefined} aria-controls={mobilePrototype ? 'personal-content-panel' : undefined} tabIndex={mobilePrototype && personalContentTab !== 'favorites' ? -1 : 0}
                  onClick={() => setFavSubTab("favorites")}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs md:text-sm font-extrabold transition-all outline-none focus:ring-4 focus:ring-rose-500/50 cursor-pointer ${
                    personalContentTab === "favorites"
                      ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                      : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                  }`}
                >
                  <Heart className={`w-4 h-4 ${personalContentTab === "favorites" ? "fill-white" : ""}`} />
                  <span>{t("我的追剧")}</span>
                  {favorites.length > 0 && (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        personalContentTab === "favorites" ? "bg-white/20 text-white" : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {personalFavoriteCount}
                    </span>
                  )}
                </button>

                <button
                  type="button"
                  role={mobilePrototype ? 'tab' : undefined} id="personal-tab-history" aria-selected={mobilePrototype ? personalContentTab === 'history' : undefined} aria-controls={mobilePrototype ? 'personal-content-panel' : undefined} tabIndex={mobilePrototype && personalContentTab !== 'history' ? -1 : 0}
                  onClick={() => {
                    setFavSubTab("history");
                    refreshHistory();
                  }}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs md:text-sm font-extrabold transition-all outline-none focus:ring-4 focus:ring-rose-500/50 cursor-pointer ${
                    personalContentTab === "history"
                      ? "bg-rose-600 text-white shadow-lg shadow-rose-900/40"
                      : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                  }`}
                >
                  <Clock className="w-4 h-4" />
                  <span>{t("观看历史")}</span>
                  {historyList.length > 0 && (
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                        personalContentTab === "history" ? "bg-white/20 text-white" : "bg-slate-800 text-slate-300"
                      }`}
                    >
                      {personalHistoryCount}
                    </span>
                  )}
                </button>
                <button type="button" role={mobilePrototype ? 'tab' : undefined} id="personal-tab-likes" aria-selected={mobilePrototype ? personalContentTab === 'likes' : undefined} aria-controls={mobilePrototype ? 'personal-content-panel' : undefined} tabIndex={mobilePrototype && personalContentTab !== 'likes' ? -1 : 0} onClick={() => setFavSubTab('likes')} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs md:text-sm font-extrabold transition-all ${personalContentTab === 'likes' ? 'bg-rose-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}><ThumbsUp size={16}/><span>{t('我的点赞')}</span>{!!likesCount && <span className="text-[10px]">{likesCount}</span>}</button>
              </div>

              {/* 右侧操作按钮：仅在历史记录页且有记录时展示清空全部按钮 */}
              {personalContentTab === "history" && historyList.length > 0 && (
                <div className="flex items-center gap-3">
                  {showClearHistoryConfirm ? (
                    <div className="flex items-center gap-2 bg-slate-900 border border-rose-500/40 p-1.5 rounded-xl text-xs">
                      <span className="text-rose-400 font-semibold px-2">{t("确定清空观看历史?")}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void clearHistory().then(() => {
                            void refreshHistory(); setShowClearHistoryConfirm(false); showToast("已清空观看历史记录");
                          }).catch(() => showToast("清空失败，请检查后端连接后重试"));
                        }}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold transition cursor-pointer"
                      >{t("确认清空")}</button>
                      <button
                        type="button"
                        onClick={() => setShowClearHistoryConfirm(false)}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition cursor-pointer"
                      >{t("取消")}</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowClearHistoryConfirm(true)}
                      className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-rose-500/40 text-slate-400 hover:text-rose-400 text-xs font-semibold transition cursor-pointer outline-none focus:ring-2 focus:ring-rose-500/50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t("清空观看历史")}</span>
                    </button>
                  )}
                </div>
              )}
            </div>}
            {personalContentTab !== 'overview' && personalContentTab !== 'settings' && <div role={mobilePrototype ? 'tabpanel' : undefined} id="personal-content-panel" aria-labelledby={mobilePrototype ? `personal-tab-${personalContentTab}` : undefined}>
            {personalContentTab === 'likes' && <LikedEpisodes key={accountState.session?.user?.id || 'guest'} loggedIn={!!accountState.session?.user} onLogin={() => setAccountPanel('login')} onPlay={(series,episodeId) => void handleSelectSeries(series,undefined,episodeId)}/>}
            {/* A. 我的追剧列表 */}
            {personalContentTab === "favorites" && (
              <div>
                {favorites.length === 0 ? (
                  <div className="text-center py-28 text-slate-500 text-sm space-y-3">
                    <Heart className="w-10 h-10 mx-auto text-slate-700 stroke-[1.5]" />
                    <p>{t("暂无收藏短剧，快去官方首页、分类或热播榜单看看吧！")}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                    {favorites.map((item) => (
                      <div
                        key={item.id}
                        tabIndex={0}
                        onClick={() => handleSelectSeries(item)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleSelectSeries(item); }}
                        className="group flex flex-col rounded-2xl overflow-hidden bg-[#0a0f1d] border border-slate-800/80 hover:border-rose-500/60 hover:shadow-2xl hover:shadow-rose-950/30 hover:-translate-y-1 transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70 relative"
                      >
                        <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                          <img
                            src={item.cover}
                            alt={item.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            loading="lazy"
                          />
                          {item.badge && (
                            <span className="absolute top-2.5 end-2.5 px-2.5 py-0.5 rounded-lg text-[10px] font-bold bg-rose-600/90 text-white shadow-md">
                              {localizeLabel(item.badge)}
                            </span>
                          )}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-white">
                              <Play className="w-4 h-4 fill-white text-white" />{t("点击播放")}</span>
                          </div>
                        </div>
                        <div className="p-3.5 flex flex-col flex-1 justify-between gap-1.5">
                          <h4 className="font-bold text-sm leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                            {item.title}
                          </h4>
                          <p className="text-xs text-slate-500 line-clamp-1">{localizeLabel(item.tags) || t("全网高分短剧")}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* B. 观看历史列表 (带进度条、集数、时间百分比、一键续播、悬浮单条删除) */}
            {personalContentTab === "history" && (
              <div>
                {!mobilePrototype && <p className="mb-5 text-sm text-slate-400">{t("从最近观看的位置继续，记录保存在本地并按远程配置自动同步。")}</p>}
                {historyError && <div className="mb-5 text-rose-300">{localizeError(historyError)} <button className="underline" onClick={() => void refreshHistory()}>{t("重试")}</button></div>}
                {historyList.length === 0 ? (
                  <div className="text-center py-28 text-slate-500 text-sm space-y-3">
                    <Clock className="w-10 h-10 mx-auto text-slate-700 stroke-[1.5]" />
                    <p>{t("暂无观看历史记录，点击任意短剧即可自动保存您的播放足迹！")}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
                    {historyList.map((hist) => {
                      const seriesObj: Series = {
                        id: hist.seriesId,
                        contentType: hist.contentType,
                        title: hist.title || t("未知短剧"),
                        cover: hist.cover || "",
                        badge: hist.badge || "",
                        description: "",
                        tags: hist.tags || "",
                      };
                      const percent =
                        hist.duration && hist.duration > 0
                          ? Math.min(100, Math.round((hist.position / hist.duration) * 100))
                          : 0;

                      return (
                        <div
                          key={hist.seriesId}
                          tabIndex={0}
                          onClick={() => handleSelectSeries(seriesObj, hist)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleSelectSeries(seriesObj, hist);
                          }}
                          className="group flex flex-col rounded-2xl overflow-hidden bg-[#0a0f1d] border border-slate-800/80 hover:border-rose-500/60 hover:shadow-2xl hover:shadow-rose-950/30 hover:-translate-y-1 transition-all duration-300 cursor-pointer outline-none focus:ring-4 focus:ring-rose-500/70 relative"
                        >
                          {/* 封面与底部高亮进度条 */}
                          <div className="relative aspect-[3/4] w-full overflow-hidden bg-slate-900">
                            <img
                              src={hist.cover}
                              alt={hist.title}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                              loading="lazy"
                            />

                            {/* 悬浮删除单条按钮 */}
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                try { await removeHistoryItem(hist.seriesId); await refreshHistory(); showToast("已删除播放记录", { title: hist.title }); }
                                catch { showToast("删除失败，请检查后端连接后重试"); }
                              }}
                              className="absolute top-2.5 end-2.5 w-7 h-7 rounded-lg bg-black/60 hover:bg-rose-600 text-slate-300 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 z-20 cursor-pointer shadow-md"
                              title={t("删除此记录")}
                            >
                              <X className="w-4 h-4" />
                            </button>

                            {/* 角标 */}
                            {hist.badge && (
                              <span className="absolute top-2.5 start-2.5 px-2 py-0.5 rounded-lg text-[10px] font-bold bg-rose-600/90 text-white shadow-md">
                                {localizeLabel(hist.badge)}
                              </span>
                            )}

                            {/* 悬浮播放微浮层 */}
                            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-rose-600 text-white text-xs font-bold shadow-lg shadow-rose-950/50">
                                <Play className="w-3.5 h-3.5 fill-white text-white" />{t("继续观看")}</span>
                            </div>

                            {/* 底部红色进度条底衬 */}
                            <div className="absolute bottom-0 start-0 end-0 h-1.5 bg-slate-800/80">
                              <div
                                className="h-full bg-rose-500"
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </div>

                          {/* 详情描述区 */}
                          <div className="p-3.5 flex flex-col flex-1 justify-between gap-1.5">
                            <div>
                              <h4 className="font-bold text-sm leading-snug line-clamp-1 group-hover:text-rose-400 transition">
                                {hist.title || t("未知剧集")}
                              </h4>
                              {/* 观看进度与百分比标注 */}
                              <div className="flex items-center justify-between text-xs text-rose-400/90 font-medium mt-1">
                                <span>{t("看到第{{number}}集", { number: hist.episodeNumber || 1 })}</span>
                                <span className="font-mono text-[11px] text-slate-400">
                                  {formatTime(hist.position)}
                                  {percent > 0 ? ` (${percent}%)` : ""}
                                </span>
                              </div>
                            </div>

                            <div className="text-[10px] text-slate-500 flex items-center justify-between pt-1 border-t border-slate-800/60">
                              <span>
                                {hist.updatedAt
                                  ? formatDate(hist.updatedAt, {
                                      month: "numeric",
                                      day: "numeric", hour: "2-digit", minute: "2-digit",
                                    })
                                  : t("最近")}
                              </span>
                              <span className="text-slate-400 group-hover:text-rose-400 font-semibold transition">{t("一键续播 &gt;")}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {(['favorites','history'].includes(personalContentTab))&&getPersonalPagination(personalContentTab==='favorites'?'favorite':'history').next&&<button className="account-text-button" disabled={personalPageBusy} onClick={()=>void (async()=>{
              setPersonalPageBusy(true);try{await loadPersonalPage(personalContentTab==='favorites'?'favorite':'history');setFavorites(getFavorites());await refreshHistory();}catch{showToast('操作失败，请稍后重试');}finally{setPersonalPageBusy(false);}
            })()}>{t(personalPageBusy?'加载中...':'加载更多')}</button>}
            </div>}
          </div>
        )}

        {!activeSeries && (tab === "settings" || mobilePrototype && tab === "favorites" && favSubTab === "settings") && (
          <div className={`max-w-xl mx-auto space-y-6${mobilePrototype ? '' : ' pt-6'}`}>
            {!mobilePrototype && <button className="account-text-button" onClick={() => openPersonalPage('overview')}><ArrowLeft size={16}/>{t('返回我的')}</button>}
            {!mobilePrototype && <h2 className="text-xl font-bold flex items-center gap-2"><SettingsIcon className="w-5 h-5 text-rose-500" />{t("设置")}</h2>}
            <div className="bg-[#0a0f1d] border border-slate-800 rounded-2xl p-6 space-y-3">
              <label className="block text-sm font-semibold">
                {t("界面语言")}
                <select aria-label={t("界面语言")} value={language} onChange={event => changeLanguage(event.target.value)} className="block mt-2 w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 outline-none focus:ring-2 focus:ring-rose-500">
                  {languages.map(item => <option key={item.id} value={item.id} lang={item.locale}>{item.name}</option>)}
                </select>
              </label>
              <p className="text-xs text-slate-400 leading-relaxed">{t("语言说明")}</p>
            </div>
            <div className="bg-[#0a0f1d] border border-slate-800 rounded-2xl p-6 space-y-5">
              <h3 className="font-semibold">{t("推荐偏好")}</h3>
              <label className="block text-sm text-slate-300">{t("推荐内容")}<select aria-label={t("推荐内容")} value={recommendationMode} onChange={e => {const mode=e.target.value as RecommendationMode;setRecommendationMode(mode);savePlaybackPreference("recommendationMode", mode);showToast("推荐模式已保存，下次进入推荐页生效");}} className="block mt-2 w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-rose-500 outline-none">
                  <option value="mixed">{t("混合推荐")}</option><option value="real-drama">{t("仅真人剧")}</option><option value="comic-drama">{t("仅漫剧")}</option><option value="ai-drama">{t("仅 AI 剧")}</option>
                </select>
              </label>
              <p className="text-xs text-slate-400">{t("混合推荐包含真人剧、漫剧与 AI 剧，根据观看兴趣调整，并保留新内容探索。")}</p>
              {showRecommendationResetConfirm ? <div className="space-y-3 text-sm"><p>{t("确定重新学习推荐偏好？收藏和观看历史会保留。")}</p><div className="flex gap-3"><button className="px-4 py-2 rounded-xl bg-rose-600" onClick={() => {streamWatchRef.current.leave();resetRecommendationPreferences();setShowRecommendationResetConfirm(false);showToast("推荐偏好已重置，下次进入推荐页生效");}}>{t("确认重置")}</button><button className="px-4 py-2 rounded-xl bg-slate-800" onClick={() => setShowRecommendationResetConfirm(false)}>{t("取消")}</button></div></div> : <button className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700" onClick={() => setShowRecommendationResetConfirm(true)}>{t("重置推荐偏好")}</button>}
            </div>
            {accountState.session?.capabilities.librarySync ? <div className="bg-[#0a0f1d] border border-slate-800 rounded-2xl p-6 space-y-5">
              <p className="text-sm text-slate-400">{t("收藏、历史、搜索记录与播放偏好先保存在本地。配置远程服务后，连接同一家庭的设备可互相续播。")}</p>
              <div role="status" className="p-4 rounded-xl bg-slate-950 text-sm">
                <span className="text-rose-400 font-semibold">{localizeLabel({unconfigured:"未配置远程",pending:"待同步",syncing:"同步中",synced:"已同步",offline:"离线待同步"}[syncStatus.state] || "连接失败")}</span>
                {syncStatus.pending > 0 && <span className="ms-3 text-slate-400">{t("待同步数量", { count: syncStatus.pending })}</span>}
                {syncStatus.error && <p className="mt-2 text-amber-300">{localizeError(syncStatus.error)}</p>}
              </div>
              <label className="block text-sm text-slate-300">{t("远程服务地址")}<input dir="ltr" aria-label={t("远程服务地址")} value={remoteUrl} onChange={e=>{remoteUrlTouched.current=true;setRemoteUrl(e.target.value)}} placeholder="https://sync.example.com" className="mt-2 w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-rose-500 outline-none" /></label>
              <label className="block text-sm text-slate-300">{t("家庭共享密钥")}<input aria-label={t("家庭共享密钥")} type="password" autoComplete="new-password" value={remoteKey} onChange={e=>setRemoteKey(e.target.value)} placeholder={syncStatus.enabled?t("留空沿用当前地址已保存的密钥"):t("填写远程服务生成的共享密钥")} className="mt-2 w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 focus:border-rose-500 outline-none" /></label>
              <div className="flex gap-3">
                <button disabled={syncSaving} onClick={async()=>{setSyncSaving(true);try{await configureSync(remoteUrl,remoteKey);setRemoteKey("");setSyncStatus(getSyncStatus());showToast("远程连接已验证，开始同步")}catch(error:any){showToast(error.response?.data?.error||"连接失败，原配置已保留")}finally{setSyncSaving(false)}}} className="flex-1 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50">{t("验证并启用同步")}</button>
                {syncStatus.enabled && <button disabled={syncSaving} onClick={async()=>{try{await configureSync("","",false);setSyncStatus(getSyncStatus());showToast("已关闭远程同步，本地数据保留")}catch{showToast("配置保存失败")}}} className="px-4 py-3 rounded-xl bg-slate-800">{t("关闭同步")}</button>}
              </div>
              <p className="text-xs text-slate-500">{t("关闭同步后继续使用本地数据；更换地址需要重新验证连接。")}</p>
            </div> : <p className="text-sm text-slate-400 p-5 bg-[#0a0f1d] border border-slate-800 rounded-2xl">{t(accountState.session?.user ? '追剧、观看历史和偏好自动保存到你的账户' : '游客的追剧、观看历史和偏好仅属于当前浏览器')}</p>}
          </div>
        )}
      </main>
      <AccountDialogs panel={accountPanel} playbackReturn={playbackReturn} onPanel={panel => { setAccountPanel(panel); if (!panel) { const url = new URL(window.location.href); url.searchParams.delete("account"); url.searchParams.delete("token"); url.searchParams.delete("error"); url.searchParams.delete('plan'); window.history.replaceState(null, "", url); } }} session={accountState.session} sessionError={accountState.error} onRefresh={accountState.refresh} />
      {mobilePrototype && <nav className="prototype-bottom-nav" aria-label={t("主导航")}>
        <button className={tab === "recommend" || tab === "search" ? "active" : ""} onClick={() => { setTab("recommend"); setActiveSeries(null); loadStreamData(1, false); }}><Compass size={22} /><span>{t("推荐")}</span></button>
        <button className={tab === "category" || tab === "home" ? "active" : ""} onClick={() => { setTab("category"); setActiveSeries(null); if (!categoryItems.length) void fetchCategoryList(selectedCatType, selectedCatTag, catPage); }}><Grid size={22} /><span>{t("分类")}</span></button>
        <button className={tab === "rank" ? "active" : ""} onClick={() => { setTab("rank"); setActiveSeries(null); if (!rankItems.length) void fetchRankList(selectedRankSlug, rankPage); }}><Trophy size={22} /><span>{t("榜单")}</span></button>
        <button className={tab === "favorites" || tab === "settings" ? "active" : ""} onClick={() => openPersonalPage("overview")}><UserCheck size={22} /><span>{t("我的")}</span></button>
      </nav>}
    </div>
  );
}
