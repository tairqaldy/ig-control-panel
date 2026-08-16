import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { RefreshCw, TrendingUp, TrendingDown, Bookmark, Eye, Heart, MessageCircle, Share2, Users, Sparkles, ArrowRight, ExternalLink, Clapperboard, Images, Image as ImageIcon, Hash, Clock, BarChart3, ExternalLink as LinkIcon, X, Info } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { AnalyticsMedia, AnalyticsRange, AnalyticsResponse } from '../lib/types-instagram';
import { cn, fmtAgo, fmtNum } from '../lib/utils';
import { PageHeader, Tabs, Skeleton, Empty } from '../components/ui';
import { AccountBadge, startInstagramConnect, useIgAccount } from '../components/instagram';
import { AreaChart, HeatStrip, MixBar, WEEKDAYS, fmtHour, fmtWeekdays } from '../components/charts';

/* ---------- helpers ---------- */
/** engagement rates are percent of reach (server: `engagementRate: % of reach`) */
const pct = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);
const fmtPct = (v: number | null | undefined) => { const p = pct(v); return p === null ? '—' : `${p.toFixed(p < 10 ? 1 : 0)}%`; };
const sum = (a: Array<number | null | undefined>) => a.reduce<number>((s, v) => s + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
function firstLast(a: Array<number | null | undefined>): [number | null, number | null] {
  const nums = a.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? [nums[0], nums[nums.length - 1]] : [null, null];
}
function mediaKind(m: AnalyticsMedia): { label: string; icon: typeof Clapperboard } {
  const pt = (m.productType || '').toUpperCase(); const t = (m.type || '').toUpperCase();
  if (pt === 'REELS' || t === 'VIDEO') return { label: 'Reel', icon: Clapperboard };
  if (t === 'CAROUSEL_ALBUM') return { label: 'Carousel', icon: Images };
  return { label: 'Image', icon: ImageIcon };
}

async function fetchAnalytics(range: AnalyticsRange): Promise<AnalyticsResponse | { unavailable: true }> {
  // tzOffset = minutes east of UTC so best hours / weekdays come back in the viewer's local time
  try {
    const r = await api.get<AnalyticsResponse | string>(`/api/instagram/analytics?range=${range}&tzOffset=${-new Date().getTimezoneOffset()}`);
    // an older server answers unknown /api paths with the SPA html (200) — treat anything that is not JSON as "not there"
    if (!r || typeof r !== 'object' || !('series' in r || 'demo' in r)) return { unavailable: true };
    return r;
  } catch (e) { if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return { unavailable: true }; throw e; }
}

/** KPI tile. `primary` = the two headline numbers (followers, reach) get the larger figure; the rest sit one step down. */
function Kpi({ label, value, hint, delta, icon: Icon, index, primary = false, className }: { label: string; value: string; hint?: string; delta?: number | null; icon: typeof Users; index: number; primary?: boolean; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }} className={cn('card p-4 min-w-0', className)}>
      <div className="flex items-center justify-between gap-2"><span className="eyebrow truncate">{label}</span><Icon size={13} className={cn('shrink-0', primary ? 'text-accent' : 'text-muted')} /></div>
      <div className="mt-1.5 flex items-baseline gap-2 min-w-0">
        <span className={cn('display leading-none tabular truncate', primary ? 'text-[32px] text-ink' : 'text-[26px] text-ink-2')}>{value}</span>
        {delta !== undefined && delta !== null && delta !== 0 && (
          <span className={cn('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11.5px] tabular', delta > 0 ? 'text-accent bg-accent-soft' : 'text-danger bg-danger-soft')}>{delta > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}{delta > 0 ? '+' : ''}{fmtNum(delta)}</span>
        )}
      </div>
      {hint && <div className="mt-1 text-[11.5px] text-muted truncate tabular">{hint}</div>}
    </motion.div>
  );
}

const DEMO_DISMISS_KEY = 'rs-analytics-demo-dismissed';

function ConnectCta({ className, label = 'Connect Instagram', size = 'sm' }: { className?: string; label?: string; size?: 'sm' | 'md' }) {
  const acc = useIgAccount();
  const cls = cn('btn btn-primary', size === 'sm' && 'btn-sm', className);
  if (acc.data?.configured) return <button onClick={startInstagramConnect} className={cls}>{label} <ArrowRight size={12} /></button>;
  return <Link to="/settings#integrations" className={cls}>{label} <ArrowRight size={12} /></Link>;
}

export default function Analytics() {
  const qc = useQueryClient();
  const [range, setRange] = useState<AnalyticsRange>(30);
  const [topBy, setTopBy] = useState<'saves' | 'reach'>('saves');
  const [demoDismissed, setDemoDismissed] = useState<boolean>(() => { try { return sessionStorage.getItem(DEMO_DISMISS_KEY) === '1'; } catch { return false; } });
  const dismissDemo = () => { setDemoDismissed(true); try { sessionStorage.setItem(DEMO_DISMISS_KEY, '1'); } catch { /* private mode */ } };
  const q = useQuery({ queryKey: ['ig-analytics', range], queryFn: () => fetchAnalytics(range), staleTime: 60_000, retry: 1, refetchInterval: (qq) => { const d = qq.state.data as any; return d && d.refreshing ? 5000 : false; } });
  const refresh = useMutation({
    mutationFn: () => api.post<any>('/api/instagram/analytics/refresh'),
    onSuccess: () => { toast.success('Analytics refreshed'); qc.invalidateQueries({ queryKey: ['ig-analytics'] }); },
    onError: (e: any) => {
      const retryAt = e?.body?.retryAt as number | undefined;
      if (e?.status === 429 || retryAt) toast(`Refreshed recently — try again ${retryAt ? fmtAgo(retryAt > 1e12 ? Math.floor(retryAt / 1000) : retryAt) : 'in a bit'}`);
      else if (e?.status === 400 && e?.body?.code === 'not_connected') toast.error('Connect Instagram first — the sample data does not refresh.');
      else if (e?.status === 404) toast.error('Analytics are not available on this server yet.');
      else toast.error(e?.message || 'Refresh failed');
    },
  });

  const data = q.data && !('unavailable' in q.data) ? (q.data as AnalyticsResponse) : null;
  const unavailable = !!q.data && 'unavailable' in q.data;

  /* ---------- derived view model ---------- */
  const vm = useMemo(() => {
    if (!data) return null;
    const series = data.series || { days: [], followers: [], reach: [] };
    const [f0, f1] = firstLast(series.followers || []);
    const followers = data.account?.followers ?? f1;
    const followerDelta = f0 !== null && f1 !== null ? f1 - f0 : null;
    const reachTotal = sum(series.reach || []);
    const media = (data.media || []).slice();
    const derived = data.derived || ({} as AnalyticsResponse['derived']);
    // heat cells: outer product of day × hour scores, normalised; marks = my own posts by local weekday/hour
    const dayScore = new Array(7).fill(0); (derived.bestDays || []).forEach((d) => { if (d.weekday >= 0 && d.weekday < 7) dayScore[d.weekday] = d.score; });
    const hourScore = new Array(24).fill(0); (derived.bestHours || []).forEach((h) => { if (h.hour >= 0 && h.hour < 24) hourScore[h.hour] = h.score; });
    const dMax = Math.max(1e-9, ...dayScore), hMax = Math.max(1e-9, ...hourScore);
    let cells = dayScore.map((ds) => hourScore.map((hs) => (ds / dMax) * (hs / hMax)));
    const cMax = Math.max(1e-9, ...cells.flat());
    cells = cells.map((r) => r.map((v) => v / cMax));
    const marks: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const m of media) { if (m.timestamp) { const dt = new Date(m.timestamp * 1000); marks[dt.getDay()][dt.getHours()] += 1; } }
    const bestDay = dayScore.indexOf(Math.max(...dayScore));
    const bestHour = hourScore.indexOf(Math.max(...hourScore));
    // "Post Tue–Thu around 19:00": every weekday within 15% of the best one (max 3), plus where you actually post most
    const bestDays = dayScore.map((s, d) => ({ s, d })).filter((x) => x.s >= dMax * 0.85).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.d);
    if (!bestDays.includes(bestDay)) bestDays.push(bestDay);
    let usual: { day: number; hour: number; n: number } | null = null;
    marks.forEach((row, d) => row.forEach((n, h) => { if (n > 0 && (!usual || n > usual.n)) usual = { day: d, hour: h, n }; }));
    const byId = new Map(media.map((m) => [m.id, m]));
    const pick = (ids: string[] | undefined, key: 'saved' | 'reach') => {
      const fromIds = (ids || []).map((id) => byId.get(id)).filter((m): m is AnalyticsMedia => !!m);
      if (fromIds.length) return fromIds.slice(0, 6);
      return media.slice().sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 6);
    };
    const topSaves = pick(derived.topBySaves, 'saved');
    const topReach = pick(derived.topByReach, 'reach');
    const mix = derived.contentMix || { reels: 0, carousels: 0, images: 0 };
    const hashtags = (derived.hashtags || []).slice(0, 12);
    const engagement = derived.avgEngagementRate ?? (media.length ? media.reduce((s, m) => s + (m.engagementRate ?? 0), 0) / media.length : null);
    const topFormat = (['reels', 'carousels', 'images'] as const).map((k) => ({ k, v: mix[k] ?? 0 })).sort((a, b) => b.v - a.v)[0];
    const topFormatLabel = !topFormat || topFormat.v === 0 ? null : topFormat.k === 'reels' ? 'Reels' : topFormat.k === 'carousels' ? 'Carousels' : 'Images';
    return { series, followers, followerDelta, reachTotal, media, cells, marks, bestDay, bestHour, bestDays, usual: usual as { day: number; hour: number; n: number } | null, topSaves, topReach, mix, topFormatLabel, hashtags, engagement, cadence: derived.postingCadencePerWeek ?? null, totals: data.totals };
  }, [data]);

  const slot = vm ? `${fmtWeekdays(vm.bestDays)} around ${fmtHour(vm.bestHour)}` : '';
  const askQ = encodeURIComponent('Based on my analytics, what should I post this week?');
  const rangeTabs = [{ id: '7', label: '7d' }, { id: '30', label: '30d' }, { id: '90', label: '90d' }];
  const isDemo = !!data?.demo;

  return (
    <div>
      <PageHeader eyebrow="Analytics · Instagram" title={<>What your posts <em className="text-accent not-italic">actually</em> do</>}
        subtitle={isDemo
          ? <span className="inline-flex items-center gap-1.5"><Info size={13} className="text-warn shrink-0" /> Sample data from a demo account. Nothing on this page is yours until you connect Instagram.</span>
          : data?.account?.username
            ? <span className="inline-flex items-center gap-2"><AccountBadge size="sm" username={data.account.username} name={data.account.name} profilePictureUrl={data.account.profilePictureUrl} followers={data.account.followers} className="inline-flex" /> {data.refreshing ? <span className="text-muted inline-flex items-center gap-1"><RefreshCw size={11} className="animate-spin" /> refreshing…</span> : data.refreshedAt ? <span className="text-muted">· refreshed {fmtAgo(data.refreshedAt)}</span> : null}</span>
            : 'Followers, reach, best time to post, what gets saved. Numbers from the Instagram Graph API for your professional account.'}
        actions={<>
          <Tabs value={String(range)} onChange={(v) => setRange(Number(v) as AnalyticsRange)} tabs={rangeTabs} />
          {isDemo ? <ConnectCta size="md" /> : <button onClick={() => refresh.mutate()} disabled={refresh.isPending || unavailable} className="btn"><RefreshCw size={14} className={cn(refresh.isPending && 'animate-spin')} /> Refresh</button>}
        </>} />

      {/* demo banner: honest, dismissible for this session */}
      {isDemo && !demoDismissed && (
        <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn/40 bg-warn-soft/60 px-3.5 py-2 text-[12.5px] rise" role="status">
          <Sparkles size={14} className="text-warn shrink-0" />
          <span className="text-ink-2 min-w-0 flex-1">You are looking at sample data. Connect a professional Instagram account and this page fills with your own followers, reach and posts within a minute.</span>
          <span className="flex items-center gap-1 ml-auto"><ConnectCta /><button onClick={dismissDemo} className="btn btn-ghost btn-sm !px-1.5 text-muted" aria-label="Hide this note"><X size={14} /></button></span>
        </div>
      )}

      {unavailable && (
        <Empty icon={<BarChart3 size={28} />} title="Analytics are not on this server yet" body="This Resurfly build does not expose /api/instagram/analytics. Update the server; the page fills in on its own once it does." action={<Link to="/automations" className="btn">Go to Automations</Link>} />
      )}
      {q.isError && !unavailable && <Empty title="Could not load analytics" body={(q.error as any)?.message || 'Try again in a moment.'} action={<button onClick={() => q.refetch()} className="btn">Retry</button>} />}

      {q.isLoading && !data && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
          <div className="grid lg:grid-cols-2 gap-4"><Skeleton className="h-56" /><Skeleton className="h-56" /></div>
        </div>
      )}

      {data && vm && data.connected && !data.demo && vm.media.length === 0 && (vm.series.days?.length ?? 0) === 0 && (
        <div className="card-flat p-5 mb-5 flex flex-wrap items-center gap-3 text-[13px]"><Clock size={15} className="text-accent" /><span className="text-ink-2">Connected — the first refresh is filling in your numbers. It takes about a minute for a typical account.</span><button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="btn btn-sm ml-auto"><RefreshCw size={13} className={cn(refresh.isPending && 'animate-spin')} /> Refresh now</button></div>
      )}

      {data && vm && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
            <Kpi index={0} primary className="lg:col-span-2" label="Followers" value={vm.followers != null ? fmtNum(vm.followers) : '—'} delta={vm.followerDelta} hint={vm.followerDelta !== null ? `change over the last ${range} days` : `last ${range} days`} icon={Users} />
            <Kpi index={1} primary className="lg:col-span-2" label="Reach" value={fmtNum(vm.reachTotal)} hint={`accounts reached in ${range} days`} icon={Eye} />
            <Kpi index={2} label="Interactions" value={fmtNum(vm.totals?.interactions ?? 0)} hint={`${fmtNum(vm.totals?.likes ?? 0)} likes · ${fmtNum(vm.totals?.comments ?? 0)} comments`} icon={Heart} />
            <Kpi index={3} label="Saves" value={fmtNum(vm.totals?.saves ?? 0)} hint={`${fmtNum(vm.totals?.shares ?? 0)} shares`} icon={Bookmark} />
            <Kpi index={4} label="Profile views" value={fmtNum(vm.totals?.profileViews ?? 0)} hint={`${fmtNum(vm.totals?.websiteClicks ?? 0)} website clicks`} icon={ExternalLink} className="lg:col-span-1" />
            <Kpi index={5} label="Accounts engaged" value={fmtNum(vm.totals?.accountsEngaged ?? 0)} hint={`of ${fmtNum(vm.reachTotal)} reached`} icon={Users} className="lg:col-span-1" />
          </div>

          {/* charts */}
          <div className="grid lg:grid-cols-2 gap-4 mb-5">
            <div className="card p-5">
              <div className="flex items-baseline justify-between mb-2"><div><div className="eyebrow">Followers</div><div className="text-[13px] text-muted">daily, {range} days</div></div>{vm.followerDelta !== null && <span className={cn('font-mono text-[12px] tabular', vm.followerDelta >= 0 ? 'text-accent' : 'text-danger')}>{vm.followerDelta >= 0 ? '+' : ''}{vm.followerDelta.toLocaleString()}</span>}</div>
              {vm.series.days?.length ? <AreaChart days={vm.series.days} values={vm.series.followers} height={170} label="Followers" /> : <div className="h-[170px] grid place-items-center text-[12.5px] text-muted">No follower history yet.</div>}
            </div>
            <div className="card p-5">
              <div className="flex items-baseline justify-between mb-2"><div><div className="eyebrow">Reach</div><div className="text-[13px] text-muted">accounts reached per day</div></div><span className="font-mono text-[12px] tabular text-muted">{fmtNum(vm.reachTotal)} total</span></div>
              {vm.series.days?.length ? <AreaChart days={vm.series.days} values={vm.series.reach} height={170} label="Reach" fromZero /> : <div className="h-[170px] grid place-items-center text-[12.5px] text-muted">No reach history yet.</div>}
            </div>
          </div>

          {/* best time + content mix */}
          <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4 mb-5">
            <div className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <div><div className="eyebrow">Best time to post</div><div className="text-[13px] text-muted">engagement by weekday × hour (your time zone) · rings = when you posted</div></div>
                <div className="text-[13px]"><Clock size={13} className="inline -mt-0.5 mr-1 text-accent" />Post on <b>{WEEKDAYS_LONG[vm.bestDay]}</b> around <b>{fmtHour(vm.bestHour)}</b></div>
              </div>
              <HeatStrip cells={vm.cells} marks={vm.marks} best={{ day: vm.bestDay, hour: vm.bestHour }} />
            </div>
            <div className="card p-5 flex flex-col">
              <div className="eyebrow mb-1">Content mix</div>
              <div className="text-[13px] text-muted mb-3">last {vm.media.length} posts</div>
              <MixBar segments={[{ key: 'reels', label: 'Reels', value: vm.mix.reels ?? 0 }, { key: 'carousels', label: 'Carousels', value: vm.mix.carousels ?? 0 }, { key: 'images', label: 'Images', value: vm.mix.images ?? 0 }]} />
              <div className="mt-auto pt-4 grid grid-cols-2 gap-3">
                <div className="card-flat p-3"><div className="eyebrow mb-1">Engagement rate</div><div className="display text-[24px] leading-none tabular">{fmtPct(vm.engagement)}</div><div className="text-[11px] text-muted mt-1">interactions ÷ reach, avg per post</div></div>
                <div className="card-flat p-3"><div className="eyebrow mb-1">Cadence</div><div className="display text-[24px] leading-none tabular">{vm.cadence != null ? vm.cadence.toFixed(vm.cadence < 10 ? 1 : 0) : '—'}</div><div className="text-[11px] text-muted mt-1">posts per week</div></div>
              </div>
            </div>
          </div>

          {/* top posts */}
          <div className="card p-5 mb-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div><div className="eyebrow">Top posts</div><div className="text-[13px] text-muted">what people kept — saves are the strongest signal you have</div></div>
              <Tabs value={topBy} onChange={setTopBy} tabs={[{ id: 'saves', label: 'By saves' }, { id: 'reach', label: 'By reach' }]} />
            </div>
            {(topBy === 'saves' ? vm.topSaves : vm.topReach).length ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {(topBy === 'saves' ? vm.topSaves : vm.topReach).map((m, i) => {
                  const k = mediaKind(m);
                  return (
                    <motion.a key={m.id} href={m.permalink || undefined} target="_blank" rel="noreferrer" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} className="group block min-w-0">
                      <div className="relative aspect-[4/5] overflow-hidden rounded-xl border border-line bg-surface-2">
                        {m.thumb ? <img src={m.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" /> : <div className="h-full w-full grid place-items-center text-muted"><k.icon size={20} /></div>}
                        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-ink/75 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider text-bg"><k.icon size={10} />{k.label}</span>
                        <span className="absolute right-1.5 top-1.5 rounded-md bg-ink/75 px-1.5 py-0.5 font-mono text-[10px] text-bg tabular">#{i + 1}</span>
                        {m.permalink && <span className="absolute right-1.5 bottom-1.5 rounded-md bg-ink/75 p-1 text-bg opacity-0 group-hover:opacity-100 transition-opacity"><LinkIcon size={10} /></span>}
                      </div>
                      <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] tabular text-muted">
                        <span className="inline-flex items-center gap-0.5 text-ink"><Bookmark size={10} />{fmtNum(m.saved ?? 0)}</span>
                        <span className="inline-flex items-center gap-0.5"><Eye size={10} />{fmtNum(m.reach ?? 0)}</span>
                        <span className="inline-flex items-center gap-0.5"><Heart size={10} />{fmtNum(m.likes ?? 0)}</span>
                      </div>
                      {m.caption && <div className="mt-0.5 text-[11px] text-muted clamp-2 leading-snug">{m.caption}</div>}
                    </motion.a>
                  );
                })}
              </div>
            ) : <div className="text-[13px] text-muted">No posts in this range yet.</div>}
          </div>

          {/* hashtags + action */}
          <div className="grid lg:grid-cols-[1fr_360px] gap-4">
            <div className="card p-5">
              <div className="flex items-baseline justify-between mb-3"><div><div className="eyebrow">Hashtags</div><div className="text-[13px] text-muted">from your captions · average reach of the posts that used them</div></div><Hash size={14} className="text-muted" /></div>
              {vm.hashtags.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead><tr className="text-left text-[11px] font-mono uppercase tracking-wider text-muted"><th className="py-1.5 pr-3 font-normal">Tag</th><th className="py-1.5 pr-3 font-normal text-right">Uses</th><th className="py-1.5 pr-3 font-normal text-right">Avg reach</th><th className="py-1.5 font-normal w-[38%]"></th></tr></thead>
                    <tbody className="divide-y divide-line">
                      {(() => { const max = Math.max(1, ...vm.hashtags.map((h) => h.avgReach || 0)); return vm.hashtags.map((h) => (
                        <tr key={h.tag}>
                          <td className="py-1.5 pr-3 font-mono text-[12.5px]">#{h.tag.replace(/^#/, '')}</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular text-muted">{h.uses}</td>
                          <td className="py-1.5 pr-3 text-right font-mono tabular">{fmtNum(Math.round(h.avgReach || 0))}</td>
                          <td className="py-1.5"><div className="h-1.5 rounded-full bg-line overflow-hidden"><div className="h-full rounded-full bg-accent/80" style={{ width: `${Math.max(2, ((h.avgReach || 0) / max) * 100)}%` }} /></div></td>
                        </tr>
                      )); })()}
                    </tbody>
                  </table>
                </div>
              ) : <div className="text-[13px] text-muted">No hashtags found in the captions of this range.</div>}
            </div>
            <div className="card p-5 flex flex-col bg-accent-soft/40 border-accent/30">
              <div className="flex items-center gap-2 mb-1"><Sparkles size={15} className="text-accent" /><h3 className="text-[15px] font-semibold">Turn this into action</h3></div>
              <p className="text-[13px] text-ink-2 leading-relaxed">Ask reads these numbers together with your saved library — the formats you keep saving, the hooks you liked — and drafts a plan for the week.</p>
              <ul className="mt-3 space-y-1.5 text-[12.5px] text-muted">
                <li>· what to post on {WEEKDAYS[vm.bestDay]} at {fmtHour(vm.bestHour)}</li>
                <li>· which of your saved ideas fit your top format</li>
                <li>· a hook and an outline for each</li>
              </ul>
              <div className="mt-auto pt-4 flex flex-wrap gap-2">
                <Link to={`/ask?q=${askQ}`} className="btn btn-primary"><MessageCircle size={14} /> What should I post this week? <ArrowRight size={13} /></Link>
                <Link to={`/ask?q=${encodeURIComponent('Which of my saved reels have hooks I could adapt for my top-performing format?')}`} className="btn btn-ghost btn-sm text-muted"><Share2 size={12} /> Hooks from my saves</Link>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
