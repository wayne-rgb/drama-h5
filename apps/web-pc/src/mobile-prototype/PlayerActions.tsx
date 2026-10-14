import React, { useEffect, useRef, useState } from "react";
import { Check, Maximize, MoreHorizontal, Search, X } from "lucide-react";
import { useI18n } from "../i18n";
import { VideoQualityItem } from "../types";

type Props = {
  speed: number;
  quality: string;
  qualities: VideoQualityItem[];
  loading?: boolean;
  unavailable?: boolean;
  onSpeed: (speed: number) => void;
  onQuality: (quality: string) => void;
  onSearch: () => void;
  onFullscreen: () => void;
  autoplay: boolean;
  onAutoplay: () => void;
  muted: boolean;
  onMute: () => void;
  volume: number;
  onVolume: (value: number) => void;
  onPrevious?: () => void;
  previousDisabled?: boolean;
  onRelated?: () => void;
};

export function PlayerActions(props: Props) {
  const { t, localizeLabel } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.unavailable) setOpen(false); }, [props.unavailable]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className="prototype-player-actions" ref={root} data-gesture-exclude onClick={event => event.stopPropagation()}>
    <button className="prototype-action-icon" aria-label={t("搜索")} onClick={props.onSearch}><Search size={21} /></button>
    <button className="prototype-action-icon" disabled={props.unavailable} title={props.unavailable ? t('VIP_REQUIRED') : undefined} aria-label={t("播放设置")} aria-expanded={open} aria-controls="mobile-playback-options" onClick={() => setOpen(value => !value)}><MoreHorizontal size={25} /></button>
    {open && <div className="prototype-playback-menu" id="mobile-playback-options" role="region" aria-label={t("播放设置")}>
      <div className="prototype-menu-heading"><strong>{t("播放设置")}</strong><button aria-label={t("关闭")} onClick={() => setOpen(false)}><X size={18} /></button></div>
      <h4>{t("播放倍速")}</h4>
      <div className="prototype-speed-options">{[0.75, 1, 1.25, 1.5, 2, 3].map(speed => <button key={speed} aria-pressed={speed === props.speed} onClick={() => props.onSpeed(speed)}>{speed}x</button>)}</div>
      <h4>{t("清晰度画质")}</h4>
      <div className="prototype-quality-options">{props.qualities.length ? props.qualities.map(quality => <button key={quality.key} aria-pressed={quality.key === props.quality} onClick={() => props.onQuality(quality.key)}>{localizeLabel(quality.label)}{quality.key === props.quality && <Check size={15} />}</button>) : <span>{t(props.loading ? "加载中..." : "视频源暂不可用，请重试")}</span>}</div>
      <button className="prototype-menu-row" aria-pressed={props.autoplay} onClick={props.onAutoplay}><span>{t("自动连播")}</span><strong>{t(props.autoplay ? "开" : "关")}</strong></button>
      <button className="prototype-menu-row" onClick={props.onMute}><span>{t("静音切换")}</span><strong>{t(props.muted ? "已静音" : "声音开启")}</strong></button>
      <label className="prototype-menu-volume"><span>{t("音量调节")}</span><input type="range" min="0" max="1" step="0.05" value={props.muted ? 0 : props.volume} aria-label={t("音量调节")} onChange={event => props.onVolume(Number(event.target.value))} /></label>
      {props.onPrevious && <button className="prototype-menu-row" disabled={props.previousDisabled} onClick={() => { setOpen(false); props.onPrevious?.(); }}>{t("上一集")}</button>}
      <button className="prototype-menu-row" onClick={() => { setOpen(false); props.onFullscreen(); }}><span>{t("全屏")}</span><Maximize size={17} /></button>
      {props.onRelated && <button className="prototype-menu-row" onClick={() => { setOpen(false); props.onRelated?.(); }}>{t("为你推荐")}</button>}
    </div>}
  </div>;
}

export function PlayerSideAction({ icon, label, ariaLabel = label, active = false, disabled = false, onClick }: { icon: React.ReactNode; label: string; ariaLabel?: string; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button className={`prototype-side-action${active ? " is-active" : ""}`} aria-label={ariaLabel} disabled={disabled} onClick={event => { event.stopPropagation(); onClick(); }} onDoubleClick={event => event.stopPropagation()}>
    <span className="prototype-side-action-icon">{icon}</span><span>{label}</span>
  </button>;
}

// 按视频的真实尺寸计算画面下沿，入口随视口变化移动，避开顶部状态栏。
export function FullscreenWatch({ videoRef, onClick }: { videoRef: React.RefObject<HTMLVideoElement>; onClick: () => void }) {
  const { t } = useI18n();
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      const pictureHeight = Math.min(video.clientHeight, video.clientWidth * video.videoHeight / video.videoWidth);
      setTop((video.clientHeight + pictureHeight) / 2 + 8);
    };
    const resize = new ResizeObserver(update);
    resize.observe(video);
    video.addEventListener("loadedmetadata", update);
    update();
    return () => { resize.disconnect(); video.removeEventListener("loadedmetadata", update); };
  }, [videoRef]);
  if (top === null) return null;
  return <button className="prototype-fullscreen-watch" style={{ top }} data-gesture-exclude onClick={event => { event.stopPropagation(); onClick(); }} onDoubleClick={event => event.stopPropagation()}><Maximize size={15} /><span>{t("全屏观看")}</span></button>;
}

// 使用浏览器原生弹层保留焦点与关闭行为，内部沿用现有选集和同系列内容。
export function PlayerPanel({ enabled, open, label, onClose, children }: { enabled: boolean; open: boolean; label: string; onClose: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => { if (element.open) element.close(); };
  }, [open, enabled]);
  if (!enabled) return <>{children}</>;
  return <dialog className="prototype-player-panel" ref={dialog} aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <div className="prototype-panel-heading"><strong>{label}</strong><button aria-label={t("关闭")} onClick={onClose}><X size={21} /></button></div>
    <div className="prototype-panel-body">{children}</div>
  </dialog>;
}
