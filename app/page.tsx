"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Region = "US" | "KR";
type SortKey = "pct" | "abs" | "venues" | "symbol";

type Quote = {
  exchange: string;
  venue: string;
  symbol: string;
  price: number;
  timestamp: number;
};

type SpreadRow = {
  symbol: string;
  stockName: string;
  region: Region;
  low: Quote;
  high: Quote;
  absoluteSpread: number;
  spreadPct: number;
  venueCount: number;
  quotes: Quote[];
};

type Snapshot = {
  generatedAt: number;
  refreshSeconds: number;
  rows: SpreadRow[];
  venues: string[];
  activeVenues?: number;
  errors: string[];
  market?: {
    open: boolean;
    label: string;
    nextTransitionAt: number | null;
  };
};

const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Snapshot>;
  return Array.isArray(candidate.rows) && Array.isArray(candidate.errors) && typeof candidate.generatedAt === "number";
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<"ALL" | Region>("ALL");
  const [sort, setSort] = useState<SortKey>("pct");
  const [minVenues, setMinVenues] = useState(2);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(300);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    setLoadError("");
    try {
      const response = await fetch("/api/spreads?v=3", { cache: manual ? "no-store" : "default" });
      const payload: unknown = await response.json();
      if (!response.ok || !isSnapshot(payload)) throw new Error("行情服务暂时不可用");
      setSnapshot(payload);
      setSecondsLeft(payload.refreshSeconds || 300);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "读取行情失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!snapshot || snapshot.market?.open) return;
    const refreshMs = (snapshot.refreshSeconds || 300) * 1000;
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => window.clearInterval(timer);
  }, [load, snapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => current > 0 ? current - 1 : snapshot?.refreshSeconds || 300);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.refreshSeconds]);

  useEffect(() => {
    if (!snapshot?.market?.open || !snapshot.market.nextTransitionAt) return;
    const delay = snapshot.market.nextTransitionAt - Date.now() + 1500;
    if (delay <= 0) return;
    const timer = window.setTimeout(() => void load(), Math.min(delay, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [load, snapshot]);

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...(snapshot?.rows ?? [])]
      .filter((row) => region === "ALL" || row.region === region)
      .filter((row) => row.venueCount >= minVenues)
      .filter((row) => !normalized || `${row.symbol} ${row.stockName}`.toLowerCase().includes(normalized))
      .sort((a, b) => {
        if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
        if (sort === "venues") return b.venueCount - a.venueCount || b.spreadPct - a.spreadPct;
        return sort === "pct" ? b.spreadPct - a.spreadPct : b.absoluteSpread - a.absoluteSpread;
      });
  }, [minVenues, query, region, snapshot?.rows, sort]);

  const largest = rows[0] ?? snapshot?.rows?.[0];
  const marketLabel = snapshot?.market?.label ?? "正在确认美股时段";
  const nextRefresh = snapshot?.market?.open ? "休市后自动恢复" : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Δ</span>
          <div>
            <strong>PerpScope</strong>
            <span>全球股票合约价差</span>
          </div>
        </div>
        <div className={`market-status ${snapshot?.market?.open ? "open" : ""}`}><span /> {marketLabel}</div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">CROSS-VENUE SPREAD MONITOR</p>
          <h1>价差，一眼排清。</h1>
          <p className="hero-copy">聚合六家交易所的美股与韩股合约标记价。美股休市期间每 5 分钟刷新，开市后自动暂停轮询。</p>
        </div>
        <div className="hero-stat">
          <span>当前最大价差</span>
          <strong>{largest ? `${largest.spreadPct.toFixed(2)}%` : "—"}</strong>
          <small>{largest ? `${largest.symbol} · ${money.format(largest.absoluteSpread)} 点` : "等待实时行情"}</small>
        </div>
      </section>

      <section className="summary" aria-label="行情摘要">
        <div><span>跨所标的</span><strong>{snapshot?.rows.length ?? "—"}</strong><small>至少两个有效报价</small></div>
        <div><span>当前榜单</span><strong>{rows.length}</strong><small>符合筛选条件</small></div>
        <div><span>有效市场</span><strong>{snapshot?.activeVenues ?? 0}</strong><small>当前有可用报价</small></div>
        <div><span>下次刷新</span><strong className="timer">{nextRefresh}</strong><small>{snapshot ? `更新于 ${clock.format(snapshot.generatedAt)}` : "北京时间"}</small></div>
      </section>

      {(loadError || (snapshot?.errors.length ?? 0) > 0) && (
        <div className="notice" role="status">
          <strong>{(snapshot?.rows.length ?? 0) > 0 ? "部分市场受限，已自动降级" : "行情源暂时不可用"}</strong>
          <span>{loadError || `${snapshot?.errors.slice(0, 2).join("；")}${(snapshot?.errors.length ?? 0) > 2 ? " 等" : ""}`}</span>
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索股票代码或名称" />
          </label>
          <div className="segment" aria-label="区域筛选">
            {(["ALL", "US", "KR"] as const).map((value) => (
              <button className={region === value ? "active" : ""} key={value} onClick={() => setRegion(value)}>
                {value === "ALL" ? "全部" : value === "US" ? "美股" : "韩股"}
              </button>
            ))}
          </div>
          <label className="sort-select">
            <span>报价</span>
            <select value={minVenues} onChange={(event) => setMinVenues(Number(event.target.value))}>
              <option value={2}>2 家以上</option>
              <option value={3}>3 家以上</option>
              <option value={5}>5 家以上</option>
            </select>
          </label>
          <label className="sort-select">
            <span>排序</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="pct">价差百分比</option>
              <option value="abs">绝对价差</option>
              <option value="venues">报价数量</option>
              <option value="symbol">股票代码</option>
            </select>
          </label>
          <button className="refresh-button" onClick={() => void load(true)} disabled={refreshing}>
            <span aria-hidden="true">↻</span>{refreshing ? "刷新中" : "立即刷新"}
          </button>
        </div>

        <div className="table-head">
          <span>股票 / 中文名</span><span>最低价合约</span><span>最高价合约</span><span>绝对价差</span><span>价差比例</span><span>报价数</span>
        </div>
        <div className="rows" aria-live="polite">
          {loading && Array.from({ length: 5 }, (_, index) => <div className="loading-row" key={index} />)}
          {!loading && rows.map((row, index) => {
            const isExpanded = expanded === row.symbol;
            return (
              <article className={`spread-row-wrap ${isExpanded ? "expanded" : ""}`} key={row.symbol}>
                <button className="spread-row" onClick={() => setExpanded(isExpanded ? null : row.symbol)} aria-expanded={isExpanded}>
                  <span className="asset-cell">
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`region-tag ${row.region.toLowerCase()}`}>{row.region}</span>
                    <span className="asset-title"><strong>{row.symbol}</strong><small>{row.stockName}</small></span>
                  </span>
                  <span className="price-cell"><strong>{money.format(row.low.price)}</strong><small>{row.low.venue}</small><em>{row.low.symbol}</em></span>
                  <span className="price-cell high"><strong>{money.format(row.high.price)}</strong><small>{row.high.venue}</small><em>{row.high.symbol}</em></span>
                  <strong className="spread-abs">{money.format(row.absoluteSpread)}</strong>
                  <strong className="spread-pct">+{row.spreadPct.toFixed(2)}%</strong>
                  <span className="venue-count"><b>{row.venueCount}</b><span>个报价</span><i aria-hidden="true">⌄</i></span>
                </button>
                {isExpanded && (
                  <div className="quote-strip">
                    {row.quotes.map((quote, quoteIndex) => (
                      <div key={`${quote.exchange}-${quote.symbol}`}>
                        <span>{quoteIndex === 0 ? "最低" : quoteIndex === row.quotes.length - 1 ? "最高" : `#${quoteIndex + 1}`}</span>
                        <strong>{quote.venue}</strong>
                        <b>{money.format(quote.price)}</b>
                        <small>{quote.symbol}</small>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          {!loading && rows.length === 0 && (
            <div className="empty-state">
              <strong>{(snapshot?.rows.length ?? 0) === 0 ? "正在等待可用交易所报价" : "没有符合条件的价差"}</strong>
              <span>{(snapshot?.rows.length ?? 0) === 0 ? "行情源恢复后会自动显示，无需重新设置。" : "试试放宽区域、报价数量或搜索条件。"}</span>
            </div>
          )}
        </div>
      </section>

      <footer><span>仅在美股休市期间自动刷新 · 行情仅供监控参考</span><span>Binance · Bitget · Gate · Bybit · OKX · Hyperliquid</span></footer>
    </main>
  );
}
