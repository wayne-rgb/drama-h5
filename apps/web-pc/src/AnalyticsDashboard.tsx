import React, { useEffect, useState } from 'react';
import { ChevronRight, ArrowLeft } from 'lucide-react';
import { accountError, accountRequest } from './account';
import { MessageKey, useI18n } from './i18n';
import './analytics.css';

type Summary = { startedViewers: number; viewers: number; plays: number; watchMs: number; completionRate: number | null; gates: number; errorSessions: number; attempts: number };
type SeriesRow = Summary & { id: string; title: string; status: string; cover: string; episodeCount: number };
type Retention = { progress: number; viewers: number; rate: number | null };
type EpisodeGroup = Summary & { episodeId: string; number: number; title: string; current: boolean; continuationRate: number | null; continuationViewers: number; continuationBase: number; pendingViewers: number };
type EpisodeRow = EpisodeGroup & { assetId: string; retention: Retention[] };
type FeedbackCounts = { likesAdded: number; likesRemoved: number; commentsAdded: number };
type Report = {
  collected: boolean; collectionStartedAt: number; summary: Summary;
  timeline: (Summary & { date: string; collected: boolean })[];
  series: SeriesRow[]; episodes: EpisodeRow[]; episodeGroups: EpisodeGroup[];
  feedback: FeedbackCounts & { currentLikes: number; timeline: (FeedbackCounts & { date: string; collected: boolean })[];
    episodes: (FeedbackCounts & { episodeId: string; assetId: string })[];
    comments: { id: string; body: string; title: string; episode_id: string; created_at: number }[]; hasMoreComments: boolean };
};
const today = () => new Date().toISOString().slice(0, 10);
const before = (days: number) => new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
const versionKey = (episode: EpisodeRow) => `${episode.episodeId}:${episode.assetId}`;

export default function AnalyticsDashboard({ initialSeriesId = '' }: { initialSeriesId?: string }) {
  const { t, language, localizeError, formatDate } = useI18n();
  const [seriesId, setSeriesId] = useState(initialSeriesId), [episodeId, setEpisodeId] = useState('');
  const [start, setStart] = useState(before(7)), [end, setEnd] = useState(today());
  const [report, setReport] = useState<Report | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [revision, setRevision] = useState(0), [search, setSearch] = useState('');
  const [episodeKey, setEpisodeKey] = useState(''), [compareKey, setCompareKey] = useState(''), [commentPage, setCommentPage] = useState(1);
  const [seriesTitle, setSeriesTitle] = useState(''), [episodeTitle, setEpisodeTitle] = useState(''), [episodeNumber,setEpisodeNumber]=useState<number|null>(null);
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const percent = (value: number | null) => value === null ? '—' : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  const time = (value: number) => `${number(Math.round(value / 60000 * 10) / 10)} ${t('分钟')}`;
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setReport(null);
    const params = new URLSearchParams({ seriesId, episodeId, start, end, commentPage: String(commentPage) });
    accountRequest<Report>(`/api/analytics/report?${params}`).then(data => {
      if (!active) return;
      setReport(data);
      if (seriesId) setSeriesTitle(data.series[0]?.title || '');
      if (episodeId) {setEpisodeTitle(data.episodeGroups[0]?.title || '');setEpisodeNumber(data.episodeGroups[0]?.number || null);}
    }).catch(error => { if (active) setError(accountError(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [seriesId, episodeId, start, end, revision, commentPage]);
  const enterSeries = (id: string, title: string) => { setSeriesId(id); setSeriesTitle(title); setEpisodeId(''); setEpisodeKey(''); setCompareKey(''); setCommentPage(1); };
  const enterEpisode = (episode: EpisodeGroup) => { setEpisodeId(episode.episodeId); setEpisodeTitle(episode.title); setEpisodeNumber(episode.number); setEpisodeKey(''); setCompareKey(''); setCommentPage(1); };
  const backSeries = () => { setEpisodeId(''); setEpisodeKey(''); setCompareKey(''); setCommentPage(1); };
  const backList = () => { setSeriesId(''); setSeriesTitle(''); backSeries(); };
  const episodes = report?.episodes || [], selected = episodes.find(episode => versionKey(episode) === episodeKey) || episodes.find(episode => episode.current) || episodes[episodes.length-1];
  const comparison = episodes.find(episode => versionKey(episode) === compareKey && episode.episodeId === selected?.episodeId && versionKey(episode) !== versionKey(selected));
  const versionLabel = (episode: EpisodeRow) => episode.current ? t('当前版本') : `${t('历史版本')} ${number(episodes.filter(row => !row.current).findIndex(row => versionKey(row) === versionKey(episode)) + 1)}`;
  const metric = (value: string) => report?.collected ? value : t('尚未采集');
  const episodeHeading=episodeNumber ? `${t('第{{number}}集',{number:episodeNumber})}${episodeTitle&&episodeTitle!==`第${episodeNumber}集`?` · ${episodeTitle}`:''}` : t('集数暂不可用');
  const cards = (values: [MessageKey, string][]) => <div className="analytics-cards">{values.map(([label, value]) => <div key={label}><span>{t(label)}</span><strong>{value}</strong></div>)}</div>;
  const watchingCards = (summary: Summary) => cards([['有效观看人数', metric(number(summary.viewers))], ['有效观看次数', metric(number(summary.plays))], ['有效观看时长', metric(time(summary.watchMs))], ['分集完播率', metric(percent(summary.completionRate))]]);
  const trend = () => report && <details><summary>{t('每日趋势')}</summary><div className="analytics-table"><table><thead><tr><th>{t('日期')}</th><th>{t('开始观看人数')}</th><th>{t('有效观看人数')}</th><th>{t('有效观看次数')}</th><th>{t('有效观看时长')}</th></tr></thead><tbody>{report.timeline.map(day => <tr key={day.date}><td dir="ltr">{day.date}</td><td>{day.collected ? number(day.startedViewers) : t('尚未采集')}</td><td>{day.collected ? number(day.viewers) : t('尚未采集')}</td><td>{day.collected ? number(day.plays) : t('尚未采集')}</td><td>{day.collected ? time(day.watchMs) : t('尚未采集')}</td></tr>)}</tbody></table></div></details>;
  return <div className="analytics-dashboard">
    <nav className="analytics-breadcrumb" aria-label={t('内容层级')}>
      <button disabled={!seriesId} onClick={backList}>{t('剧列表')}</button>
      {seriesId && <><ChevronRight size={16}/><button disabled={!episodeId} dir="auto" onClick={backSeries}>{seriesTitle || t('短剧')}</button></>}
      {episodeId && <><ChevronRight size={16}/><strong dir="auto">{episodeHeading}</strong></>}
    </nav>
    <section className="admin-panel analytics-filters">
      <label>{t('开始日期')}<input type="date" max={end} value={start} onChange={event => { setStart(event.target.value); setCommentPage(1); }}/></label>
      <label>{t('结束日期')}<input type="date" min={start} max={today()} value={end} onChange={event => { setEnd(event.target.value); setCommentPage(1); }}/></label>
      <div className="analytics-presets">{([7, 30, 90] as const).map(days => <button key={days} onClick={() => { setStart(before(days)); setEnd(today()); setCommentPage(1); }}>{t(`最近${days}天`)}</button>)}<button disabled={loading} onClick={() => setRevision(value => value + 1)}>{t('刷新')}</button></div>
    </section>
    {error && <p className="account-error" role="alert">{localizeError(error)} <button onClick={() => setRevision(value => value + 1)}>{t('重试')}</button></p>}
    {loading && <p role="status">{t('加载中...')}</p>}
    {!loading && report && <>
      <p className="analytics-note">{t('数据采集开始于', { date: formatDate(report.collectionStartedAt, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) })}</p>
      {!seriesId ? <section className="admin-panel">
        <div className="admin-panel-title"><h2>{t('剧列表')}</h2><label className="analytics-search"><input aria-label={t('搜索短剧')} placeholder={t('搜索短剧')} value={search} onChange={event => setSearch(event.target.value)}/></label></div>
        <p className="analytics-note">{t('选择剧查看分析')}</p>
        <div className="analytics-series-list">{report.series.filter(item => item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(item => <button className="analytics-series-card" key={item.id} onClick={() => enterSeries(item.id, item.title)}>
          {item.cover ? <img src={item.cover} alt=""/> : <div className="analytics-cover-placeholder"/>}
          <div><strong dir="auto">{item.title}</strong><small>{t('共{{count}}集', { count: item.episodeCount })} · {t(item.status === 'published' ? '已上架' : '草稿')}</small><span>{t('有效观看人数')} {metric(number(item.viewers))} · {t('分集完播率')} {metric(percent(item.completionRate))}</span></div><ChevronRight size={20}/>
        </button>)}</div>
        {!report.series.length && <p className="analytics-empty">{t('尚无上传内容')}</p>}
      </section> : <>
        <section className="admin-panel">
          <div className="admin-panel-title"><button className="analytics-back" onClick={episodeId ? backSeries : backList}><ArrowLeft size={16}/>{t(episodeId ? '返回分集列表' : '返回剧列表')}</button><h2 dir="auto">{episodeId ? `${seriesTitle} · ${episodeHeading}` : seriesTitle}</h2></div>
          <p className="analytics-note">{t('开始观看人数')}：{metric(number(report.summary.startedViewers))}</p>
          {watchingCards(report.summary)}
          {!report.summary.attempts && <p className="analytics-empty">{t(report.collected ? '暂无观看数据' : '尚未采集')}</p>}
          <details><summary>{t('统计口径')}</summary><p className="analytics-note">{t('观看统计口径说明')}</p><p className="analytics-note">{t('身份统计说明')}</p></details>
          {trend()}
        </section>
        {!episodeId ? <section className="admin-panel"><h2>{t('分集分析')}</h2>
          <p className="analytics-note">{t('点击分集查看详情')}</p>
          <div className="analytics-table"><table><thead><tr><th>{t('分集')}</th><th>{t('开始观看人数')}</th><th>{t('有效观看人数')}</th><th>{t('有效观看次数')}</th><th>{t('分集完播率')}</th><th>{t('继续观看率')}</th><th>{t('会员门槛人数')}</th><th>{t('播放错误会话')}</th></tr></thead><tbody>{report.episodeGroups.map(episode => <tr key={episode.episodeId}>
            <td><button className="analytics-link" onClick={() => enterEpisode(episode)}>{t('第{{number}}集', { number: episode.number })}</button><small dir="auto">{episode.title}{!episode.current && ` · ${t('历史分集')}`}</small></td><td>{metric(number(episode.startedViewers))}</td><td>{metric(number(episode.viewers))}</td><td>{metric(number(episode.plays))}</td><td>{metric(percent(episode.completionRate))}</td><td>{metric(percent(episode.continuationRate))}<small>{number(episode.continuationViewers)} / {number(episode.continuationBase)} · {t('观察中')} {number(episode.pendingViewers)}</small></td><td>{number(episode.gates)}</td><td>{number(episode.errorSessions)}</td>
          </tr>)}</tbody></table></div><details><summary>{t('继续观看率')}</summary><p className="analytics-note">{t('续看统计说明')}</p></details>
        </section> : selected && <section className="admin-panel"><h2>{t('集内留存')}</h2>
          <div className="analytics-filters"><label>{t('视频版本')}<select value={versionKey(selected)} onChange={event => { setEpisodeKey(event.target.value); setCompareKey(''); }}>{episodes.map(episode => <option key={versionKey(episode)} value={versionKey(episode)}>{versionLabel(episode)}</option>)}</select></label><label>{t('对比版本')}<select value={comparison ? versionKey(comparison) : ''} onChange={event => setCompareKey(event.target.value)}><option value="">{t('不对比')}</option>{episodes.filter(episode => versionKey(episode) !== versionKey(selected)).map(episode => <option key={versionKey(episode)} value={versionKey(episode)}>{versionLabel(episode)}</option>)}</select></label></div>
          <p className="analytics-note">{versionLabel(selected)} · {t('有效观看人数')} {number(selected.viewers)} · {t('分集完播率')} {percent(selected.completionRate)}</p>
          <h3>{t('实际观看覆盖曲线')}</h3><p className="analytics-note">{t('覆盖统计说明')}</p><p className="analytics-note">{t('开播留存口径')}</p>
          {selected.startedViewers < 30 && <p className="analytics-warning">{t('样本较少提示')}</p>}
          {!selected.startedViewers ? <p className="analytics-empty">{t('暂无观看数据')}</p> : <div className="analytics-chart" role="img" aria-label={t('实际观看覆盖曲线')} dir="ltr">{selected.retention.map((bin, index) => <div className="analytics-bin" key={bin.progress} title={`${bin.progress}–${bin.progress + 5}%: ${percent(bin.rate)} (${number(bin.viewers)})`}><div className="analytics-bar"><span style={{ height: `${(bin.rate || 0) * 100}%` }}/>{comparison && <span className="analytics-compare" style={{ height: `${(comparison.retention[index].rate || 0) * 100}%` }}/>}</div><small>{bin.progress}%</small></div>)}</div>}
          <div className="analytics-legend"><span>{versionLabel(selected)} · {t('开始观看人数')} {number(selected.startedViewers)}</span>{comparison && <span>{versionLabel(comparison)} · {t('开始观看人数')} {number(comparison.startedViewers)}</span>}</div>
          <details><summary>{t('观看覆盖率')}</summary><div className="analytics-table"><table><thead><tr><th>{t('播放进度区间')}</th><th>{t('开始观看人数')}</th><th>{t('观看覆盖率')}</th>{comparison && <th>{t('对比版本')}</th>}</tr></thead><tbody>{selected.retention.map((bin, index) => <tr key={bin.progress}><td dir="ltr">{bin.progress}–{bin.progress + 5}%</td><td>{number(bin.viewers)}</td><td>{percent(bin.rate)}</td>{comparison && <td>{percent(comparison.retention[index].rate)} · {number(comparison.retention[index].viewers)}</td>}</tr>)}</tbody></table></div></details>
        </section>}
        <section className="admin-panel"><h2>{t('观众反馈')}</h2>
          {cards([['当前点赞数', number(report.feedback.currentLikes)], ['期间新增点赞', metric(number(report.feedback.likesAdded))], ['期间取消点赞', metric(number(report.feedback.likesRemoved))], ['期间新增评论', metric(number(report.feedback.commentsAdded))]])}
          <details><summary>{t('统计口径')}</summary><p className="analytics-note">{t('反馈统计说明')}</p></details>
          {!episodeId && <div className="analytics-table"><table><thead><tr><th>{t('分集')}</th><th>{t('期间新增点赞')}</th><th>{t('期间取消点赞')}</th><th>{t('期间新增评论')}</th></tr></thead><tbody>{report.episodeGroups.map(episode => {
            const feedback=report.feedback.episodes.filter(row=>row.episodeId===episode.episodeId);
            return <tr key={episode.episodeId}><td><button className="analytics-link" onClick={()=>enterEpisode(episode)}>{t('第{{number}}集',{number:episode.number})}</button></td><td>{number(feedback.reduce((sum,row)=>sum+row.likesAdded,0))}</td><td>{number(feedback.reduce((sum,row)=>sum+row.likesRemoved,0))}</td><td>{number(feedback.reduce((sum,row)=>sum+row.commentsAdded,0))}</td></tr>;
          })}</tbody></table></div>}
          <details><summary>{t('每日趋势')}</summary><div className="analytics-table"><table><thead><tr><th>{t('日期')}</th><th>{t('期间新增点赞')}</th><th>{t('期间取消点赞')}</th><th>{t('期间新增评论')}</th></tr></thead><tbody>{report.feedback.timeline.map(day => <tr key={day.date}><td dir="ltr">{day.date}</td><td>{day.collected ? number(day.likesAdded) : t('尚未采集')}</td><td>{day.collected ? number(day.likesRemoved) : t('尚未采集')}</td><td>{day.collected ? number(day.commentsAdded) : t('尚未采集')}</td></tr>)}</tbody></table></div></details>
          {!report.feedback.comments.length && <p className="analytics-empty">{t('暂无可见评论')}</p>}
          {report.feedback.comments.map(comment => <article className="admin-comment-row" key={comment.id}><div className="admin-comment-context"><strong dir="auto">{seriesTitle}</strong><span>{report.episodeGroups.find(ep => ep.episodeId === comment.episode_id)?.number ? t('第{{number}}集', { number: report.episodeGroups.find(ep => ep.episodeId === comment.episode_id)!.number }) : t('集数暂不可用')}</span></div><p dir="auto">{comment.body}</p><small>{formatDate(comment.created_at, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</small></article>)}
          {(commentPage > 1 || report.feedback.hasMoreComments) && <nav className="admin-pagination"><button disabled={commentPage === 1} onClick={() => setCommentPage(value => value - 1)}>{t('上一页')}</button><span>{t('第{{number}}页', { number: commentPage })}</span><button disabled={!report.feedback.hasMoreComments} onClick={() => setCommentPage(value => value + 1)}>{t('下一页')}</button></nav>}
        </section>
      </>}
    </>}
  </div>;
}
