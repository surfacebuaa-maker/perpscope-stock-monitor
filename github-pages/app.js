const state = {
  snapshot: null,
  query: "",
  region: "ALL",
  sort: "abs_pct",
  alertsOnly: false,
  expanded: new Set(),
  loading: false,
};

const aliases = {
  AMDSTOCK: "AMD", APPSTOCK: "APP", CATSTOCK: "CAT", DIASTOCK: "DIA",
  GMESTOCK: "GME", NOKIA: "NOK", NOKSTOCK: "NOK", PENGSTOCK: "PENG",
  QNT: "QNTX", SKHX: "SKHYNIX", SMSN: "SAMSUNG", STXSTOCK: "STX",
  VRTXSTOCK: "VRTX", WENSTOCK: "WEN",
};

const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function signed(value, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function direction(value) {
  if (value === null || value === undefined) return "neutral";
  return value >= 0 ? "positive" : "negative";
}

function canonical(raw) {
  let value = String(raw ?? "").toUpperCase().replaceAll("-", "").replaceAll("_", "").trim();
  if (aliases[value]) value = aliases[value];
  if (value.endsWith("STOCK")) value = value.slice(0, -5);
  return aliases[value] ?? value;
}

async function binanceInstruments() {
  const cacheKey = "perpscope-binance-instruments-v1";
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) ?? "null");
    if (cached?.expiresAt > Date.now() && Array.isArray(cached.items)) return cached.items;
  } catch { /* ignore a damaged local cache */ }
  const response = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const items = (payload.symbols ?? []).filter((item) => item.contractType === "TRADIFI_PERPETUAL" && item.status === "TRADING" && ["EQUITY", "KR_EQUITY"].includes(item.underlyingType));
  try { localStorage.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + 3_600_000, items })); } catch { /* storage is optional */ }
  return items;
}

async function mergeBrowserBinance(snapshot) {
  if ((snapshot.rows ?? []).some((row) => row.exchange === "binance")) return snapshot;
  try {
    const [instruments, pricesResponse] = await Promise.all([
      binanceInstruments(),
      fetch("https://fapi.binance.com/fapi/v1/premiumIndex"),
    ]);
    if (!pricesResponse.ok) throw new Error(`HTTP ${pricesResponse.status}`);
    const priceRows = await pricesResponse.json();
    const prices = new Map(priceRows.map((row) => [row.symbol, { price: Number(row.markPrice), time: Number(row.time) }]));
    const directRows = instruments.flatMap((item) => {
      const stockSymbol = canonical(item.baseAsset);
      const catalogItem = snapshot.stockCatalog?.[stockSymbol];
      const quote = prices.get(item.symbol);
      if (!catalogItem || !quote?.price) return [];
      const closePrice = snapshot.unifiedCloses?.[stockSymbol] ?? null;
      const priceDifference = closePrice === null ? null : quote.price - closePrice;
      const deviationPct = closePrice === null ? null : (priceDifference / closePrice) * 100;
      return [{
        id: `binance:${item.symbol}`,
        stockSymbol,
        stockName: catalogItem.name,
        region: item.underlyingType === "KR_EQUITY" ? "KR" : catalogItem.region,
        exchange: "binance",
        venue: "Binance",
        contractSymbol: item.symbol,
        currentPrice: quote.price,
        closePrice,
        closeSource: closePrice === null ? null : (catalogItem.region === "KR" ? "KRX · USD/KRW" : "Nasdaq"),
        priceDifference,
        deviationPct,
        alert: deviationPct !== null && Math.abs(deviationPct) >= 20,
        timestamp: quote.time || Date.now(),
      }];
    });
    snapshot.rows = [...snapshot.rows.filter((row) => row.exchange !== "binance"), ...directRows];
    snapshot.activeVenues = new Set(snapshot.rows.map((row) => row.exchange)).size;
    snapshot.referenceCoverage = snapshot.rows.filter((row) => row.closePrice !== null).length;
    snapshot.alertCount = snapshot.rows.filter((row) => row.alert).length;
    snapshot.errors = (snapshot.errors ?? []).filter((error) => !String(error).startsWith("Binance"));
  } catch (error) {
    const message = `Binance 浏览器直连: ${error instanceof Error ? error.message : "读取失败"}`;
    if (!(snapshot.errors ?? []).some((item) => String(item).startsWith("Binance"))) snapshot.errors = [...(snapshot.errors ?? []), message];
  }
  return snapshot;
}

function groupsFromRows() {
  const grouped = new Map();
  for (const row of state.snapshot?.rows ?? []) grouped.set(row.stockSymbol, [...(grouped.get(row.stockSymbol) ?? []), row]);
  const normalized = state.query.trim().toLowerCase();
  return [...grouped.entries()]
    .map(([symbol, contracts]) => {
      const sorted = [...contracts].sort((a, b) => Math.abs(b.deviationPct ?? 0) - Math.abs(a.deviationPct ?? 0));
      const priced = sorted.filter((row) => row.deviationPct !== null);
      return {
        symbol,
        stockName: contracts[0].stockName,
        region: contracts[0].region,
        closePrice: contracts.find((row) => row.closePrice !== null)?.closePrice ?? null,
        closeSource: contracts.find((row) => row.closeSource)?.closeSource ?? null,
        contracts: sorted,
        maxAbs: priced[0] ?? sorted[0],
        maxPositive: priced.length ? Math.max(...priced.map((row) => row.deviationPct)) : null,
        minNegative: priced.length ? Math.min(...priced.map((row) => row.deviationPct)) : null,
        maxPoints: priced.length ? Math.max(...priced.map((row) => Math.abs(row.priceDifference ?? 0))) : 0,
        alert: contracts.some((row) => row.alert),
      };
    })
    .filter((group) => state.region === "ALL" || group.region === state.region)
    .filter((group) => !state.alertsOnly || group.alert)
    .filter((group) => !normalized || `${group.symbol} ${group.stockName} ${group.contracts.map((row) => `${row.contractSymbol} ${row.venue}`).join(" ")}`.toLowerCase().includes(normalized))
    .sort((a, b) => {
      if (state.sort === "symbol") return a.symbol.localeCompare(b.symbol);
      if (state.sort === "contracts") return b.contracts.length - a.contracts.length || a.symbol.localeCompare(b.symbol);
      if (state.sort === "pct_desc") return (b.maxPositive ?? -Infinity) - (a.maxPositive ?? -Infinity);
      if (state.sort === "pct_asc") return (a.minNegative ?? Infinity) - (b.minNegative ?? Infinity);
      if (state.sort === "points") return b.maxPoints - a.maxPoints;
      return Math.abs(b.maxAbs?.deviationPct ?? 0) - Math.abs(a.maxAbs?.deviationPct ?? 0);
    });
}

function contractLine(row) {
  const tone = direction(row.deviationPct);
  return `<div class="contract-line ${row.alert ? "alert" : ""}">
    <span class="contract-cell"><strong>${escapeHtml(row.venue)}</strong><small>${escapeHtml(row.contractSymbol)}</small></span>
    <strong class="numeric current-price">${price.format(row.currentPrice)}</strong>
    <strong class="numeric difference ${tone}">${signed(row.priceDifference)}</strong>
    <span class="deviation ${tone}">${row.alert ? "<b>警报</b>" : ""}<strong>${signed(row.deviationPct, "%")}</strong></span>
  </div>`;
}

function groupCard(group, index) {
  const open = state.expanded.has(group.symbol);
  const tone = direction(group.maxAbs?.deviationPct ?? null);
  return `<article class="stock-card ${group.alert ? "alert" : ""} ${open ? "expanded" : ""}">
    <button class="stock-summary" data-symbol="${escapeHtml(group.symbol)}" aria-expanded="${open}">
      <span class="asset-cell"><span class="rank">${String(index + 1).padStart(2, "0")}</span><span class="region-tag ${group.region.toLowerCase()}">${group.region}</span><span class="asset-title"><strong>${escapeHtml(group.symbol)}</strong><small>${escapeHtml(group.stockName)}</small></span></span>
      <span class="close-cell"><strong>${group.closePrice === null ? "—" : price.format(group.closePrice)}</strong><small>${group.closeSource ? `${escapeHtml(group.closeSource)} 常规收盘价` : "统一源暂无数据"}</small></span>
      <span class="contract-cell"><strong>${escapeHtml(group.maxAbs?.venue ?? "—")}</strong><small>${escapeHtml(group.maxAbs?.contractSymbol ?? "暂无合约")}</small></span>
      <span class="deviation ${tone}">${group.alert ? "<b>警报</b>" : ""}<strong>${signed(group.maxAbs?.deviationPct ?? null, "%")}</strong></span>
      <span class="contract-count"><strong>${group.contracts.length}</strong><small>个合约</small><i aria-hidden="true">⌄</i></span>
    </button>
    ${open ? `<div class="contract-list"><div class="contract-list-head"><span>交易所 / 合约名</span><span>合约现价</span><span>价差</span><span>偏离百分比</span></div>${group.contracts.map(contractLine).join("")}</div>` : ""}
  </article>`;
}

function render() {
  if (!state.snapshot) return;
  const groups = groupsFromRows();
  const allRows = state.snapshot.rows ?? [];
  const stockCount = new Set(allRows.map((row) => row.stockSymbol)).size;
  const alertStocks = new Set(allRows.filter((row) => row.alert).map((row) => row.stockSymbol)).size;
  const largest = [...allRows].filter((row) => row.deviationPct !== null).sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct))[0];

  $("#stock-count").textContent = stockCount;
  $("#contract-count").textContent = `${allRows.length} 个交易所合约`;
  $("#alert-count").textContent = alertStocks;
  $("#alert-detail").textContent = `${state.snapshot.alertCount ?? 0} 个合约触发`;
  $("#coverage").textContent = `${state.snapshot.referenceCoverage ?? 0}/${allRows.length}`;
  $("#venue-count").textContent = `${state.snapshot.closeProvider ?? "Nasdaq / KRX"} · ${state.snapshot.activeVenues ?? 0} 个市场`;
  $("#updated-at").textContent = `更新于 ${clock.format(state.snapshot.generatedAt)}`;

  const market = $("#market-status");
  market.classList.toggle("open", Boolean(state.snapshot.market?.open));
  market.innerHTML = `<span></span> ${escapeHtml(state.snapshot.market?.label ?? "美股时段未知")}`;

  const hero = $("#hero-stat");
  hero.classList.toggle("negative", Boolean(largest && largest.deviationPct < 0));
  hero.innerHTML = `<span>当前最大收盘偏离</span><strong>${largest ? signed(largest.deviationPct, "%") : "—"}</strong><small>${largest ? `${escapeHtml(largest.stockSymbol)} · ${escapeHtml(largest.venue)} · ${escapeHtml(largest.contractSymbol)}` : "等待行情数据"}</small>`;

  const notice = $("#notice");
  if ((state.snapshot.errors ?? []).length) {
    notice.classList.remove("hidden");
    notice.querySelector("strong").textContent = allRows.length ? "部分市场受限，已保留可用报价" : "行情源暂时不可用";
    notice.querySelector("span").textContent = state.snapshot.errors.slice(0, 3).join("；");
  } else notice.classList.add("hidden");

  $("#rows").innerHTML = groups.length
    ? groups.map(groupCard).join("")
    : `<div class="empty-state"><strong>${allRows.length ? "没有符合条件的合约" : "正在等待首次行情采集"}</strong><span>${allRows.length ? "试试关闭 20% 筛选或清空搜索词。" : "GitHub Actions 完成后会自动显示。"}</span></div>`;
  $("#expand-all").textContent = groups.length && groups.every((group) => state.expanded.has(group.symbol)) ? "全部收起" : "全部展开";
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  $("#refresh").disabled = true;
  try {
    const response = await fetch(`./data.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.snapshot = await response.json();
    render();
    state.snapshot = await mergeBrowserBinance(state.snapshot);
    render();
  } catch (error) {
    const notice = $("#notice");
    notice.classList.remove("hidden");
    notice.querySelector("strong").textContent = "行情数据暂时不可用";
    notice.querySelector("span").textContent = error instanceof Error ? error.message : "读取失败";
  } finally {
    state.loading = false;
    $("#refresh").disabled = false;
  }
}

$("#search").addEventListener("input", (event) => { state.query = event.target.value; render(); });
$("#sort").addEventListener("change", (event) => { state.sort = event.target.value; render(); });
$("#alerts-only").addEventListener("click", (event) => { state.alertsOnly = !state.alertsOnly; event.currentTarget.classList.toggle("active", state.alertsOnly); render(); });
document.querySelectorAll("[data-region]").forEach((button) => button.addEventListener("click", () => {
  state.region = button.dataset.region;
  document.querySelectorAll("[data-region]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  render();
}));
$("#rows").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-symbol]");
  if (!button) return;
  const symbol = button.dataset.symbol;
  if (state.expanded.has(symbol)) state.expanded.delete(symbol); else state.expanded.add(symbol);
  render();
});
$("#expand-all").addEventListener("click", () => {
  const groups = groupsFromRows();
  const allOpen = groups.length && groups.every((group) => state.expanded.has(group.symbol));
  groups.forEach((group) => allOpen ? state.expanded.delete(group.symbol) : state.expanded.add(group.symbol));
  render();
});
$("#refresh").addEventListener("click", load);

setInterval(() => {
  if (!state.snapshot) return;
  const age = Math.floor((Date.now() - state.snapshot.generatedAt) / 1000);
  const remaining = Math.max(0, 300 - age);
  $("#refresh-timer").textContent = remaining ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "待更新";
}, 1000);
setInterval(() => { if (!state.snapshot?.market?.open) void load(); }, 300_000);
void load();
