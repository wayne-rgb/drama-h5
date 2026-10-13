// 播放地址只保存真实内容标识，进度仍从现有资料库恢复。
export function readPlaybackLocation(href: string) {
  const params = new URL(href).searchParams;
  const series = params.get("series") || "";
  const episode = params.get("episode") || "";
  return {
    seriesId: /^\d+$/.test(series) ? series : "",
    episodeId: /^\d+$/.test(episode) ? episode : "",
  };
}

export function playbackLocation(href: string, seriesId = "", episodeId = "") {
  const url = new URL(href);
  url.searchParams.delete("series");
  url.searchParams.delete("episode");
  if (/^\d+$/.test(seriesId)) {
    url.searchParams.set("series", seriesId);
    if (/^\d+$/.test(episodeId)) url.searchParams.set("episode", episodeId);
  }
  return url.href;
}
