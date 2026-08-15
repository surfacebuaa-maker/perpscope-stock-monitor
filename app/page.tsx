"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Region = "US" | "KR";
type SortKey = "abs_pct" | "pct_desc" | "pct_asc" | "points" | "symbol" | "contracts";

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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  const stockGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const grouped = new Map<string, DeviationRow[]>();
    for (const row of snapshot?.rows ?? []) {
      grouped.set(row.stockSymbol, [...(grouped.get(row.stockSymbol) ?? []), row]);
    }

    return [...grouped.entries()]
      .map(([symbol, contracts]) => {
        const sortedContracts = [...contracts].sort((a, b) => Math.abs(b.deviationPct ?? 0) - Math.abs(a.deviationPct ?? 0));
        const pricedContracts = sortedContracts.filter((row) => row.deviationPct !== null);
        const maxAbs = pricedContracts[0] ?? sortedContracts[0];
        const maxPositive = pricedContracts.reduce((best, row) => Math.max(best, row.deviationPct ?? -Infinity), -Infinity);
        const minNegative = pricedContracts.reduce((best, row) => Math.min(best, row.deviationPct ?? Infinity), Infinity);
        const maxPoints = pricedContracts.reduce((best, row) => Math.max(best, Math.abs(row.priceDifference ?? 0)), 0);
        return {
          symbol,
          stockName: contracts[0].stockName,
          region: contracts[0].region,
          closePrice: contracts.find((row) => row.closePrice !== null)?.closePrice ?? null,
          closeSource: contracts.find((row) => row.closeSource)?.closeSource ?? null,
          contracts: sortedContracts,
          maxAbs,
          maxPositive,
          minNegative,
          maxPoints,
          alert: contracts.some((row) => row.alert),
        };
      })
      .filter((group) => region === "ALL" || group.region === region)
      .filter((group) => !alertsOnly || group.alert)
      .filter((group) => !normalized || `${group.symbol} ${group.stockName} ${group.contracts.map((row) => `${row.contractSymbol} ${row.venue}`).join(" ")}`.toLowerCase().includes(normalized))
      .sort((a, b) => {
        if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
        if (sort === "contracts") return b.contracts.length - a.contracts.length || a.symbol.localeCompare(b.symbol);
        if (sort === "pct_desc") return b.maxPositive - a.maxPositive;
        if (sort === "pct_asc") return a.minNegative - b.minNegative;
        if (sort === "points") return b.maxPoints - a.maxPoints;
        return Math.abs(b.maxAbs?.deviationPct ?? 0) - Math.abs(a.maxAbs?.deviationPct ?? 0);
      });
  }, [alertsOnly, query, region, snapshot?.rows, sort]);

  const allStockCount = useMemo(() => new Set((snapshot?.rows ?? []).map((row) => row.stockSymbol)).size, [snapshot?.rows]);
  const alertStockCount = useMemo(() => new Set((snapshot?.rows ?? []).filter((row) => row.alert).map((row) => row.stockSymbol)).size, [snapshot?.rows]);
  const allVisibleExpanded = stockGroups.length > 0 && stockGroups.every((group) => expanded.has(group.symbol));

  const toggleGroup = (symbol: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const group of stockGroups) {
        if (allVisibleExpanded) next.delete(group.symbol);
        else next.add(group.symbol);
      }
      return next;
    });
  };

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
          <p className="hero-copy">同一股票的所有交易所合约收在一张卡片里，美股对比 Nasdaq 收盘价，韩股对比 KRX 收盘价（按 USD/KRW 换算）。美股休市期间每 5 分钟刷新，绝对偏离达到 20% 自动标红警报。</p>
        </div>
        <div className={`hero-stat ${largest && (largest.deviationPct ?? 0) < 0 ? "negative" : ""}`}>
          <span>当前最大收盘偏离</span>
          <strong>{largest ? signed(largest.deviationPct, "%") : "—"}</strong>
          <small>{largest ? `${largest.stockSymbol} · ${largest.venue} · ${largest.contractSymbol}` : "等待实时行情"}</small>
        </div>
      </section>

      <section className="summary" aria-label="行情摘要">
        <div><span>股票标的</span><strong>{snapshot ? allStockCount : "—"}</strong><small>{snapshot?.rows.length ?? 0} 个交易所合约</small></div>
        <div><span>20% 警报</span><strong className="alert-number">{alertStockCount}</strong><small>{snapshot?.alertCount ?? 0} 个合约触发</small></div>
        <div><span>统一价覆盖</span><strong>{snapshot ? `${snapshot.referenceCoverage ?? 0}/${snapshot.rows.length}` : "—"}</strong><small>{snapshot?.closeProvider ?? "Nasdaq / KRX"} · {snapshot?.activeVenues ?? 0} 个市场</small></div>
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
              <option value="contracts">合约数量</option>
            </select>
          </label>
          <button className="expand-button" onClick={toggleAllVisible} disabled={stockGroups.length === 0}>
            {allVisibleExpanded ? "全部收起" : "全部展开"}
          </button>
          <button className="refresh-button" onClick={() => void load(true)} disabled={refreshing}>
            <span aria-hidden="true">↻</span>{refreshing ? "刷新中" : "立即刷新"}
          </button>
        </div>

        <div className="table-head group-head">
          <span>股票 / 中文名</span><span>统一收盘价</span><span>最大偏离合约</span><span>最大偏离</span><span>合约数</span>
        </div>
        <div className="rows" aria-live="polite">
          {loading && Array.from({ length: 6 }, (_, index) => <div className="loading-row" key={index} />)}
          {!loading && stockGroups.map((group, index) => {
            const isExpanded = expanded.has(group.symbol);
            const summaryDirection = group.maxAbs?.deviationPct === null || group.maxAbs?.deviationPct === undefined ? "neutral" : group.maxAbs.deviationPct >= 0 ? "positive" : "negative";
            return (
              <article className={`stock-card ${group.alert ? "alert" : ""} ${isExpanded ? "expanded" : ""}`} key={group.symbol}>
                <button className="stock-summary" onClick={() => toggleGroup(group.symbol)} aria-expanded={isExpanded}>
                  <span className="asset-cell">
                    <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                    <span className={`region-tag ${group.region.toLowerCase()}`}>{group.region}</span>
                    <span className="asset-title"><strong>{group.symbol}</strong><small>{group.stockName}</small></span>
                  </span>
                  <span className="close-cell"><strong>{group.closePrice === null ? "—" : price.format(group.closePrice)}</strong><small>{group.closeSource ? `${group.closeSource} 常规收盘价` : "统一源暂无数据"}</small></span>
                  <span className="contract-cell"><strong>{group.maxAbs?.venue ?? "—"}</strong><small>{group.maxAbs?.contractSymbol ?? "暂无合约"}</small></span>
                  <span className={`deviation ${summaryDirection}`}>
                    {group.alert && <b>警报</b>}
                    <strong>{signed(group.maxAbs?.deviationPct ?? null, "%")}</strong>
                  </span>
                  <span className="contract-count"><strong>{group.contracts.length}</strong><small>个合约</small><i aria-hidden="true">⌄</i></span>
                </button>
                {isExpanded && (
                  <div className="contract-list">
                    <div className="contract-list-head"><span>交易所 / 合约名</span><span>合约现价</span><span>价差</span><span>偏离百分比</span></div>
                    {group.contracts.map((row) => {
                      const direction = row.deviationPct === null ? "neutral" : row.deviationPct >= 0 ? "positive" : "negative";
                      return (
                        <div className={`contract-line ${row.alert ? "alert" : ""}`} key={row.id}>
                          <span className="contract-cell"><strong>{row.venue}</strong><small>{row.contractSymbol}</small></span>
                          <strong className="numeric current-price">{price.format(row.currentPrice)}</strong>
                          <strong className={`numeric difference ${direction}`}>{row.priceDifference === null ? "—" : signed(row.priceDifference)}</strong>
                          <span className={`deviation ${direction}`}>{row.alert && <b>警报</b>}<strong>{signed(row.deviationPct, "%")}</strong></span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </article>
            );
          })}
          {!loading && stockGroups.length === 0 && (
            <div className="empty-state">
              <strong>{(snapshot?.rows.length ?? 0) === 0 ? "正在等待可用交易所报价" : "没有符合条件的合约"}</strong>
              <span>{(snapshot?.rows.length ?? 0) === 0 ? "行情源恢复后会自动显示，无需重新设置。" : "试试关闭 20% 筛选或清空搜索词。"}</span>
            </div>
          )}
        </div>
      </section>

      <footer><span>价差 = 合约现价 − 最近常规收盘价 · 美股 Nasdaq · 韩股 KRX（USD/KRW 换算）</span><span>Binance · Bitget · Gate · Bybit · OKX · Hyperliquid</span></footer>
    </main>
  );
}
