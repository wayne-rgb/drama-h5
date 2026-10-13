import { useEffect, useState } from "react";

// 正式入口按视口选择布局；独立预览入口仍可固定为手机布局。
export function useMobileLayout(forced?: boolean) {
  const [matches, setMatches] = useState(() => window.matchMedia("(max-width: 767px), (pointer: coarse) and (max-width: 1023px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px), (pointer: coarse) and (max-width: 1023px)");
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return forced ?? matches;
}
