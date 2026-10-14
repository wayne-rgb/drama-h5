import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../i18n";
import { CategoryTag, CategoryType } from "../types";
import { PlayerPanel } from "./PlayerActions";

export function CategoryFilters({ types, tags, selectedType, selectedTag, loading, onType, onTag }: {
  types: CategoryType[];
  tags: CategoryTag[];
  selectedType: string;
  selectedTag: string;
  loading: boolean;
  onType: (id: string) => void;
  onTag: (id: string) => void;
}) {
  const { t, localizeLabel, language } = useI18n();
  const [open, setOpen] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const genres = [{ id: "", name: t("全部题材") }, ...tags];

  useEffect(() => {
    if (!rail.current || !selectedButton.current) return;
    const viewport = rail.current.getBoundingClientRect();
    const button = selectedButton.current.getBoundingClientRect();
    // 仅移动题材栏，避免选择题材时带动整页滚动；物理坐标同时适用于左右阅读方向。
    const offset = button.left < viewport.left ? button.left - viewport.left : button.right > viewport.right ? button.right - viewport.right : 0;
    if (offset) rail.current.scrollBy({ left: offset });
  }, [selectedTag, tags, language]);

  const selectTag = (id: string) => {
    onTag(id);
    setOpen(false);
  };

  return <section className="prototype-category-filters">
    <div className="prototype-category-types">
      {types.map(type => <button key={type.id} type="button" aria-pressed={selectedType === type.id} onClick={() => onType(type.id)}>{localizeLabel(type.name)}</button>)}
    </div>
    <div className="prototype-category-genre-row">
      <div className="prototype-category-genre-rail no-scrollbar" ref={rail} role="group" aria-label={t("题材筛选：")}>
        {genres.map(tag => <button key={tag.id} type="button" ref={selectedTag === tag.id ? selectedButton : undefined} aria-pressed={selectedTag === tag.id} onClick={() => selectTag(tag.id)}>{localizeLabel(tag.name)}</button>)}
      </div>
      <button className="prototype-category-more" type="button" aria-expanded={open} aria-haspopup="dialog" disabled={loading && !tags.length} onClick={() => setOpen(true)}>{t("更多题材")}<ChevronDown size={16} /></button>
    </div>
    {loading && <p className="prototype-category-loading" role="status">{t("正在读取官网题材…")}</p>}
    <PlayerPanel enabled open={open} label={t("全部题材")} onClose={() => setOpen(false)}>
      <div className="prototype-category-genre-sheet">
        {genres.map(tag => <button key={tag.id} type="button" aria-pressed={selectedTag === tag.id} onClick={() => selectTag(tag.id)}>{localizeLabel(tag.name)}</button>)}
      </div>
    </PlayerPanel>
  </section>;
}
