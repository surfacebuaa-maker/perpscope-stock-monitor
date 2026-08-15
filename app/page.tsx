"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Region = "US" | "KR";
type SortKey = "abs_pct" | "pct_desc" | "pct_asc" | "points" | "symbol" | "exchange";

type DeviationRow = {
  id: string;
  stockSymbol: string;
  stockName: string;
  region: Region;
  exchange: string;
  venue: string;
  contractSymbol: string;
  currentPrice: number;
  closePrice: number | null;
  closeSource: string | null;
  priceDifference: number | null;
  deviationPct: number | null;
  alert: boolean;
  timestamp: number;
};

type Snapshot = {
  generatedAt: number;
  refreshSeconds: number;
  rows: DeviationRow[];
  venues: string[];
  activeVenues?: number;
  referenceCoverage?: number;
  alertCount?: number;
  closeProvider?: string;
  closeAsOf?: string | null;
  errors: string[];
  market?: {
    open: boolean;
    label: string;
    nextTransitionAt: number | null;
  };
};

const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
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

function signed(value: number | null, suffix = "") {
  if (value === null) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}${suffix}`;
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<"ALL" | Region>("ALL");
  const [sort, setSort] = useState<SortKey>("abs_pct");
  const [alertsOnly, setAlertsOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(300);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    setLoadError("");
    try {
      const response = await fetch("/api/spreads?v=7", { cache: manual ? "no-store" : "default" });
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
      .filter((row) => !alertsOnly || row.alert)
      .filter((row) => !normalized || `${row.stockSymbol} ${row.stockName} ${row.contractSymbol} ${row.venue}`.toLowerCase().includes(normalized))
      .sort((a, b) => {
        if (sort === "symbol") return a.stockSymbol.localeCompare(b.stockSymbol) || a.venue.localeCompare(b.venue);
        if (sort === "exchange") return a.venue.localeCompare(b.venue) || a.stockSymbol.localeCompare(b.stockSymbol);
        if (sort === "pct_desc") return (b.deviationPct ?? -Infinity) - (a.deviationPct ?? -Infinity);
        if (sort === "pct_asc") return (a.deviationPct ?? Infinity) - (b.deviationPct ?? Infinity);
        if (sort === "points") return Math.abs(b.priceDifference ?? 0) - Math.abs(a.priceDifference ?? 0);
        return Math.abs(b.deviationPct ?? 0) - Math.abs(a.deviationPct ?? 0);
      });
  }, [alertsOnly, query, region, snapshot?.rows, sort]);

  const largest = useMemo(
    () => [...(snapshot?.rows ?? [])]
      .filter((row) => row.deviationPct !== null)
      .sort((a, b) => Math.abs(b.deviationPct ?? 0) - Math.abs(a.deviationPct ?? 0))[0],
    [snapshot?.rows],
  );
  const marketLabel = snapshot?.market?.label ?? "正在确认美股时段";
  const nextRefresh = snapshot?.market?.open
    ? "休市后恢复"
    : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Δ</span>
          <div>
            <strong>PerpScope</strong>
            <span>股票合约收盘偏离监控</span>
          </div>
        </div>
        <div className={`market-status ${snapshot?.market?.open ? "open" : ""}`}><span /> {marketLabel}</div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">CONTRACT VS. STOCK CLOSE</p>
          <h1>偏离收盘，一眼排清。</h1>
          <p className="hero-copy">每一行比较该交易所的股票合约现价与统一 Nasdaq 常规收盘价。美股休市期间每 5 分钟刷新，绝对偏离达到 20% 自动标红警报，不使用任何交易所 oracle 作为基准。</p>
        </div>
        <div className={`hero-stat ${largest && (largest.deviationPct ?? 0) < 0 ? "negative" : ""}`}>
          <span>当前最大收盘偏离</span>
          <strong>{largest ? signed(largest.deviationPct, "%") : "—"}</strong>
          <small>{largest ? `${largest.stockSymbol} · ${largest.venue} · ${largest.contractSymbol}` : "等待实时行情"}</small>
        </div>
      </section>

      <section className="summary" aria-label="行情摘要">
        <div><span>有效合约</span><strong>{snapshot?.rows.length ?? "—"}</strong><small>一行一个交易所合约</small></div>
        <div><span>20% 警报</span><strong className="alert-number">{snapshot?.alertCount ?? 0}</strong><small>按绝对偏离计算</small></div>
        <div><span>统一价覆盖</span><strong>{snapshot ? `${snapshot.referenceCoverage ?? 0}/${snapshot.rows.length}` : "—"}</strong><small>{snapshot?.closeProvider ?? "Nasdaq"} · {snapshot?.activeVenues ?? 0} 个市场</small></div>
        <div><span>下次刷新</span><strong className="timer">{nextRefresh}</strong><small>{snapshot ? `更新于 ${clock.format(snapshot.generatedAt)}` : "北京时间"}</small></div>
      </section>

      {(loadError || (snapshot?.errors.length ?? 0) > 0) && (
        <div className="notice" role="status">
          <strong>{(snapshot?.rows.length ?? 0) > 0 ? "部分市场受限，已保留可用报价" : "行情源暂时不可用"}</strong>
          <span>{loadError || `${snapshot?.errors.slice(0, 2).join("；")}${(snapshot?.errors.length ?? 0) > 2 ? " 等" : ""}`}</span>
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索股票、合约名或交易所" />
          </label>
          <div className="segment" aria-label="区域筛选">
            {(["ALL", "US", "KR"] as const).map((value) => (
              <button className={region === value ? "active" : ""} key={value} onClick={() => setRegion(value)}>
                {value === "ALL" ? "全部" : value === "US" ? "美股" : "韩股"}
              </button>
            ))}
          </div>
          <button className={`alert-filter ${alertsOnly ? "active" : ""}`} onClick={() => setAlertsOnly((value) => !value)}>
            <span>!</span> 仅看 ≥20%
          </button>
          <label className="sort-select">
            <span>排序</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="abs_pct">偏离幅度（绝对值）</option>
              <option value="pct_desc">偏离百分比：高到低</option>
              <option value="pct_asc">偏离百分比：低到高</option>
              <option value="points">价差点数（绝对值）</option>
              <option value="symbol">股票代码</option>
              <option value="exchange">交易所</option>
            </select>
          </label>
          <button className="refresh-button" onClick={() => void load(true)} disabled={refreshing}>
            <span aria-hidden="true">↻</span>{refreshing ? "刷新中" : "立即刷新"}
          </button>
        </div>

        <div className="table-head">
          <span>股票 / 中文名</span><span>交易所 / 合约名</span><span>合约现价</span><span>统一收盘价</span><span>价差</span><span>偏离百分比</span>
        </div>
        <div className="rows" aria-live="polite">
          {loading && Array.from({ length: 6 }, (_, index) => <div className="loading-row" key={index} />)}
          {!loading && rows.map((row, index) => {
            const direction = row.deviationPct === null ? "neutral" : row.deviationPct >= 0 ? "positive" : "negative";
            return (
              <article className={`spread-row ${row.alert ? "alert" : ""}`} key={row.id}>
                <span className="asset-cell">
                  <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                  <span className={`region-tag ${row.region.toLowerCase()}`}>{row.region}</span>
                  <span className="asset-title"><strong>{row.stockSymbol}</strong><small>{row.stockName}</small></span>
                </span>
                <span className="contract-cell"><strong>{row.venue}</strong><small>{row.contractSymbol}</small></span>
                <strong className="numeric current-price">{price.format(row.currentPrice)}</strong>
                <span className="close-cell"><strong>{row.closePrice === null ? "—" : price.format(row.closePrice)}</strong><small>{row.closeSource ? `${row.closeSource} 常规收盘价` : "统一源暂无数据"}</small></span>
                <strong className={`numeric difference ${direction}`}>{row.priceDifference === null ? "—" : signed(row.priceDifference)}</strong>
                <span className={`deviation ${direction}`}>
                  {row.alert && <b>警报</b>}
                  <strong>{signed(row.deviationPct, "%")}</strong>
                </span>
              </article>
            );
          })}
          {!loading && rows.length === 0 && (
            <div className="empty-state">
              <strong>{(snapshot?.rows.length ?? 0) === 0 ? "正在等待可用交易所报价" : "没有符合条件的合约"}</strong>
              <span>{(snapshot?.rows.length ?? 0) === 0 ? "行情源恢复后会自动显示，无需重新设置。" : "试试关闭 20% 筛选或清空搜索词。"}</span>
            </div>
          )}
        </div>
      </section>

      <footer><span>价差 = 合约现价 − Nasdaq 最近常规收盘价 · 不使用交易所 oracle · 休市期每 5 分钟刷新</span><span>Binance · Bitget · Gate · Bybit · OKX · Hyperliquid</span></footer>
    </main>
  );
}
