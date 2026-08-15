import { appendFile, readFile, writeFile } from "node:fs/promises";
import { fetchKoreanCloses } from "../lib/korean-market.mjs";

const SOURCE_SITE = "https://perpscope-spread-monitor.surface-buaa139523.chatgpt.site/api/spreads?v=7";
const OUTPUT = new URL("../github-pages/data.json", import.meta.url);
const CATALOG_SOURCE = new URL("../lib/stock-catalog.ts", import.meta.url);
const TIMEOUT_MS = 20_000;

const EXCHANGE_LABELS = {
  binance: "Binance",
  bitget: "Bitget",
};

const ALIASES = {
  AMDSTOCK: "AMD", APPSTOCK: "APP", CATSTOCK: "CAT", DIASTOCK: "DIA",
  GMESTOCK: "GME", NOKIA: "NOK", NOKSTOCK: "NOK", PENGSTOCK: "PENG",
  QNT: "QNTX", SKHX: "SKHYNIX", SMSN: "SAMSUNG", STXSTOCK: "STX",
  VRTXSTOCK: "VRTX", WENSTOCK: "WEN",
};

const CLOSE_SYMBOLS = { BRKB: "BRK/B" };

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function marketNumber(value) {
  return numeric(String(value ?? "").replaceAll("$", "").replaceAll(",", "").replaceAll("%", "").trim());
}

function directCanonical(raw) {
  let value = String(raw ?? "").toUpperCase().replaceAll("-", "").replaceAll("_", "").trim();
  if (ALIASES[value]) value = ALIASES[value];
  if (value.endsWith("STOCK")) value = value.slice(0, -5);
  return ALIASES[value] ?? value;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function attempt(label, task) {
  try {
    return { value: await task, error: null };
  } catch (error) {
    return { value: null, error: `${label}: ${error instanceof Error ? error.message : "未知错误"}` };
  }
}

async function readCatalog() {
  const source = await readFile(CATALOG_SOURCE, "utf8");
  const usSymbols = source.match(/const US_SYMBOLS = `([\s\S]*?)`/)?.[1].trim().split(/\s+/) ?? [];
  const krxBlock = source.match(/export const KRX_SYMBOLS:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const krxSymbols = new Map();
  for (const match of krxBlock.matchAll(/^\s*([A-Z0-9]+):\s*"([0-9]+)",?$/gm)) krxSymbols.set(match[1], match[2]);
  const namesBlock = source.match(/const NAMES:[\s\S]*?= \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const names = new Map();
  for (const match of namesBlock.matchAll(/^\s*([A-Z0-9]+):\s*"([^"]*)",?$/gm)) names.set(match[1], match[2]);
  return new Map([
    ...usSymbols.map((symbol) => [symbol, { region: "US", name: names.get(symbol) ?? `${symbol} 股票` }]),
    ...[...krxSymbols].map(([symbol, referenceSymbol]) => [symbol, {
      region: "KR",
      name: names.get(symbol) ?? `${symbol} 股票`,
      referenceSymbol,
    }]),
  ]);
}

function fallbackMarketState() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minutes = numeric(values.hour) * 60 + numeric(values.minute);
  const open = !["Sat", "Sun"].includes(values.weekday) && minutes >= 570 && minutes < 960;
  return { open, label: open ? "美股开市 · 等待休市" : "美股休市 · 监控中", nextTransitionAt: null, source: "fallback" };
}

async function fetchUnifiedCloses(marketOpen, catalog) {
  const headers = {
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.nasdaq.com",
    referer: "https://www.nasdaq.com/market-activity/stocks/screener",
    "user-agent": "Mozilla/5.0",
  };
  const [stocks, etfs, korean] = await Promise.all([
    attempt("Nasdaq 股票收盘价", fetchJson("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true", { headers })),
    attempt("Nasdaq ETF 收盘价", fetchJson("https://api.nasdaq.com/api/screener/etf?tableonly=true&limit=10000&download=true", { headers })),
    fetchKoreanCloses({ catalog, fetchJson }),
  ]);
  const stockData = stocks.value?.data ?? {};
  const etfEnvelope = etfs.value?.data ?? {};
  const etfData = etfEnvelope.data ?? {};
  const rows = [
    ...((stockData.rows ?? []).map((row) => ({ symbol: row.symbol, last: marketNumber(row.lastsale), change: marketNumber(row.netchange) }))),
    ...((etfData.rows ?? []).map((row) => ({ symbol: row.symbol, last: marketNumber(row.lastSalePrice), change: marketNumber(row.netChange) }))),
  ];
  const byMarketSymbol = new Map();
  for (const row of rows) {
    if (!row.symbol || row.last <= 0) continue;
    const close = marketOpen ? row.last - row.change : row.last;
    if (close > 0) byMarketSymbol.set(String(row.symbol).toUpperCase(), close);
  }

  const closes = new Map(korean.closes);
  const sources = new Map(korean.sources);
  for (const [canonical, item] of catalog) {
    if (item.region !== "US" || item.name.includes("主题合约")) continue;
    const close = byMarketSymbol.get(CLOSE_SYMBOLS[canonical] ?? canonical);
    if (!close) continue;
    closes.set(canonical, close);
    sources.set(canonical, "Nasdaq");
  }
  return {
    closes,
    sources,
    asOf: [stockData.dataAsOf ?? etfEnvelope.dataAsOf, korean.asOf].filter(Boolean).join(" · ") || null,
    errors: [stocks.error, etfs.error, ...korean.errors].filter(Boolean),
  };
}

function closeFor(canonical, catalogItem, closes) {
  if (catalogItem?.name?.includes("主题合约")) return null;
  return closes.get(canonical) ?? null;
}

function buildRow({ canonical, region, exchange, symbol, price, closePrice, closeSource, timestamp }) {
  const difference = closePrice === null ? null : price - closePrice;
  const deviationPct = closePrice === null ? null : (difference / closePrice) * 100;
  return {
    id: `${exchange}:${symbol}`,
    stockSymbol: canonical,
    stockName: null,
    region,
    exchange,
    venue: EXCHANGE_LABELS[exchange],
    contractSymbol: symbol,
    currentPrice: price,
    closePrice,
    closeSource: closePrice === null ? null : closeSource,
    priceDifference: difference,
    deviationPct,
    alert: deviationPct !== null && Math.abs(deviationPct) >= 20,
    timestamp,
  };
}

async function fetchBinance(catalog, closes, sources) {
  const [instrumentsPayload, pricesPayload] = await Promise.all([
    fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex"),
  ]);
  const prices = new Map((pricesPayload ?? []).map((row) => [row.symbol, { price: numeric(row.markPrice), time: numeric(row.time) }]));
  return (instrumentsPayload.symbols ?? []).flatMap((item) => {
    if (item.contractType !== "TRADIFI_PERPETUAL" || item.status !== "TRADING" || !["EQUITY", "KR_EQUITY"].includes(item.underlyingType)) return [];
    const canonical = directCanonical(item.baseAsset);
    const quote = prices.get(item.symbol);
    if (!quote?.price) return [];
    const catalogItem = catalog.get(canonical);
    return [buildRow({
      canonical,
      region: item.underlyingType === "KR_EQUITY" ? "KR" : catalogItem?.region ?? "US",
      exchange: "binance",
      symbol: item.symbol,
      price: quote.price,
      closePrice: closeFor(canonical, catalogItem, closes),
      closeSource: sources.get(canonical) ?? null,
      timestamp: quote.time || Date.now(),
    })];
  });
}

async function fetchBitget(catalog, closes, sources) {
  const [instrumentsPayload, pricesPayload] = await Promise.all([
    fetchJson("https://api.bitget.com/api/v3/market/instruments?category=USDT-FUTURES"),
    fetchJson("https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES"),
  ]);
  const prices = new Map((pricesPayload.data ?? []).map((row) => [row.symbol, { price: numeric(row.markPrice) || numeric(row.lastPrice), time: numeric(row.ts) }]));
  return (instrumentsPayload.data ?? []).flatMap((item) => {
    if (item.status !== "online" || String(item.isRwa).toUpperCase() !== "YES") return [];
    const canonical = directCanonical(item.baseCoin);
    const quote = prices.get(item.symbol);
    if (!quote?.price) return [];
    const catalogItem = catalog.get(canonical);
    if (!catalogItem) return [];
    return [buildRow({
      canonical,
      region: catalogItem?.region ?? "US",
      exchange: "bitget",
      symbol: item.symbol,
      price: quote.price,
      closePrice: closeFor(canonical, catalogItem, closes),
      closeSource: sources.get(canonical) ?? null,
      timestamp: quote.time || Date.now(),
    })];
  });
}

async function setActionOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const catalog = await readCatalog();
const baseAttempt = await attempt("基础行情", fetchJson(`${SOURCE_SITE}&pages=${Math.floor(Date.now() / 300000)}`));
const base = baseAttempt.value ?? { rows: [], errors: [], market: fallbackMarketState() };
const market = base.market ?? fallbackMarketState();

if (market.open && process.env.GITHUB_EVENT_NAME === "schedule") {
  await setActionOutput("deploy", "false");
  console.log("US regular session is open; scheduled collection skipped.");
  process.exit(0);
}

const closeResult = await fetchUnifiedCloses(Boolean(market.open), catalog);
const [binance, bitget] = await Promise.all([
  attempt("Binance", fetchBinance(catalog, closeResult.closes, closeResult.sources)),
  attempt("Bitget", fetchBitget(catalog, closeResult.closes, closeResult.sources)),
]);

const baseRows = (base.rows ?? [])
  .filter((row) => !["binance", "bitget"].includes(row.exchange))
  .map((row) => {
    const catalogItem = catalog.get(row.stockSymbol);
    const closePrice = closeFor(row.stockSymbol, catalogItem, closeResult.closes);
    const closeSource = closeResult.sources.get(row.stockSymbol) ?? null;
    const priceDifference = closePrice === null ? null : row.currentPrice - closePrice;
    const deviationPct = closePrice === null ? null : (priceDifference / closePrice) * 100;
    return { ...row, closePrice, closeSource: closePrice === null ? null : closeSource, priceDifference, deviationPct, alert: deviationPct !== null && Math.abs(deviationPct) >= 20 };
  });

const rows = [...baseRows, ...(binance.value ?? []), ...(bitget.value ?? [])]
  .map((row) => ({ ...row, stockName: catalog.get(row.stockSymbol)?.name ?? row.stockName ?? `${row.stockSymbol} 股票` }))
  .filter((row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index)
  .sort((a, b) => Math.abs(b.deviationPct ?? 0) - Math.abs(a.deviationPct ?? 0));

const errors = [
  ...(base.errors ?? []).filter((error) => !String(error).startsWith("Binance") && !String(error).startsWith("Bitget")),
  baseAttempt.error,
  binance.error,
  bitget.error,
  ...closeResult.errors,
].filter(Boolean);

const snapshot = {
  generatedAt: Date.now(),
  refreshSeconds: 300,
  market,
  closeProvider: "Nasdaq / KRX",
  closeAsOf: closeResult.asOf,
  rows,
  venues: ["Binance", "Bitget", "Gate", "Bybit", "OKX", "Hyperliquid"],
  activeVenues: new Set(rows.map((row) => row.exchange)).size,
  referenceCoverage: rows.filter((row) => row.closePrice !== null).length,
  alertCount: rows.filter((row) => row.alert).length,
  stockCatalog: Object.fromEntries(catalog),
  unifiedCloses: Object.fromEntries(
    [...catalog.entries()].map(([symbol, item]) => [symbol, closeFor(symbol, item, closeResult.closes)]),
  ),
  errors,
};

await writeFile(OUTPUT, `${JSON.stringify(snapshot, null, 2)}\n`);
await setActionOutput("deploy", "true");
console.log(JSON.stringify({
  rows: rows.length,
  activeVenues: snapshot.activeVenues,
  binanceRows: rows.filter((row) => row.exchange === "binance").length,
  bitgetRows: rows.filter((row) => row.exchange === "bitget").length,
  errors,
}));
