import { STOCK_CATALOG, type StockRegion } from "@/lib/stock-catalog";
import { activeHyperliquidMarkets } from "@/lib/hyperliquid-market.mjs";
import { fetchKoreanCloses } from "@/lib/korean-market.mjs";

type JsonRecord = Record<string, unknown>;

type Region = StockRegion;
type Exchange = "binance" | "bitget" | "gate" | "bybit" | "okx" | "hyperliquid";

type Instrument = {
  canonical: string;
  region: Region;
  exchange: Exchange;
  symbol: string;
  dex?: string;
};

type Quote = {
  exchange: Exchange;
  venue: string;
  symbol: string;
  price: number;
  timestamp: number;
  volume?: number;
};

type CloseResult = {
  closes: Map<string, number>;
  sources: Map<string, string>;
  asOf: string | null;
  errors: string[];
};

type DiscoveryResult = {
  instruments: Instrument[];
  errors: string[];
};

type MarketState = {
  open: boolean;
  label: string;
  nextTransitionAt: number | null;
  source: "schedule" | "fallback";
};

const EXCHANGE_LABELS: Record<Exchange, string> = {
  binance: "Binance",
  bitget: "Bitget",
  gate: "Gate",
  bybit: "Bybit",
  okx: "OKX",
  hyperliquid: "Hyperliquid",
};

const ALIASES: Record<string, string> = {
  AMDSTOCK: "AMD",
  APPSTOCK: "APP",
  CATSTOCK: "CAT",
  DIASTOCK: "DIA",
  GMESTOCK: "GME",
  NOKIA: "NOK",
  NOKSTOCK: "NOK",
  PENGSTOCK: "PENG",
  QNT: "QNTX",
  SKHX: "SKHYNIX",
  SMSN: "SAMSUNG",
  STXSTOCK: "STX",
  VRTXSTOCK: "VRTX",
  WENSTOCK: "WEN",
};

const UNIFIED_CLOSE_SYMBOLS: Record<string, string> = {
  BRKB: "BRK/B",
};

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 55 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;

let discoveryCache: { expiresAt: number; value: DiscoveryResult } | null = null;
let snapshotCache: { expiresAt: number; value: JsonRecord } | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function marketNumber(value: unknown): number {
  return number(text(value).replaceAll("$", "").replaceAll(",", "").replaceAll("%", "").trim());
}

function objectAt(value: unknown, key: string): JsonRecord {
  if (!isRecord(value)) return {};
  return isRecord(value[key]) ? value[key] : {};
}

function arrayAt(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  return Array.isArray(value[key]) ? value[key] : [];
}

function directCanonical(raw: string): string {
  let value = raw.toUpperCase().replaceAll("-", "").replaceAll("_", "").trim();
  if (ALIASES[value]) value = ALIASES[value];
  if (value.endsWith("STOCK")) value = value.slice(0, -5);
  return ALIASES[value] ?? value;
}

function normalizeUnderlying(raw: string, known: Set<string>): string | null {
  const value = directCanonical(raw);
  const candidates = [value, ALIASES[value]];
  for (const candidate of candidates) {
    if (candidate && known.has(candidate)) return candidate;
  }
  return null;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function attempt<T>(label: string, task: Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await task, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return { value: null, error: `${label}: ${message}` };
  }
}

async function fetchBybitInstruments(): Promise<JsonRecord[]> {
  const result: JsonRecord[] = [];
  let cursor = "";
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const url = new URL("https://api.bybit.com/v5/market/instruments-info");
    url.searchParams.set("category", "linear");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const payload = await fetchJson(url.toString());
    if (number(isRecord(payload) ? payload.retCode : 1) !== 0) {
      throw new Error(text(isRecord(payload) ? payload.retMsg : "接口错误"));
    }
    const resultObject = objectAt(payload, "result");
    result.push(...records(resultObject.list));
    const next = text(resultObject.nextPageCursor);
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return result;
}

async function discover(): Promise<DiscoveryResult> {
  const now = Date.now();
  if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.value;

  const [binance, bitget, gate, bybit, okx, hyperliquid] = await Promise.all([
    attempt("Binance 标的", fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo")),
    attempt("Bitget 标的", fetchJson("https://api.bitget.com/api/v3/market/instruments?category=USDT-FUTURES")),
    attempt("Gate 标的", fetchJson("https://api.gateio.ws/api/v4/futures/usdt/contracts")),
    attempt("Bybit 标的", fetchBybitInstruments()),
    attempt("OKX 标的", fetchJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP")),
    attempt(
      "Hyperliquid 标的",
      fetchJson("https://api.hyperliquid.xyz/info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "perpCategories" }),
      }),
    ),
  ]);

  const errors = [binance.error, bitget.error, gate.error, bybit.error, okx.error, hyperliquid.error].filter(
    (value): value is string => Boolean(value),
  );
  const regions = new Map<string, Region>(
    Object.entries(STOCK_CATALOG).map(([symbol, item]) => [symbol, item.region]),
  );
  const raw: Array<Omit<Instrument, "region">> = [];

  for (const item of records(isRecord(binance.value) ? binance.value.symbols : [])) {
    const underlyingType = text(item.underlyingType);
    if (
      text(item.contractType) !== "TRADIFI_PERPETUAL" ||
      text(item.status) !== "TRADING" ||
      !["EQUITY", "KR_EQUITY"].includes(underlyingType)
    ) continue;
    const canonical = directCanonical(text(item.baseAsset));
    regions.set(canonical, underlyingType === "KR_EQUITY" ? "KR" : "US");
    raw.push({ canonical, exchange: "binance", symbol: text(item.symbol) });
  }

  const known = new Set(regions.keys());
  const bybitItems = Array.isArray(bybit.value) ? bybit.value : [];
  for (const item of bybitItems) {
    if (text(item.status) !== "Trading" || text(item.symbolType) !== "stock") continue;
    const canonical = normalizeUnderlying(text(item.baseCoin), known);
    if (canonical) raw.push({ canonical, exchange: "bybit", symbol: text(item.symbol) });
  }

  const okxData = records(isRecord(okx.value) ? okx.value.data : []);
  for (const item of okxData) {
    if (text(item.state) !== "live" || text(item.instCategory) !== "3") continue;
    const canonical = normalizeUnderlying(text(item.ctValCcy), known);
    if (canonical) raw.push({ canonical, exchange: "okx", symbol: text(item.instId) });
  }

  if (Array.isArray(hyperliquid.value)) {
    for (const row of hyperliquid.value) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const symbol = text(row[0]);
      const category = text(row[1]).toLowerCase();
      if (!["stock", "stocks"].includes(category) || !symbol.includes(":")) continue;
      const [dex, underlying] = symbol.split(":", 2);
      const canonical = normalizeUnderlying(underlying, known);
      if (canonical) raw.push({ canonical, exchange: "hyperliquid", symbol, dex });
    }
  }

  const bitgetData = records(isRecord(bitget.value) ? bitget.value.data : []);
  for (const item of bitgetData) {
    if (text(item.status) !== "online" || text(item.isRwa).toUpperCase() !== "YES") continue;
    const canonical = normalizeUnderlying(text(item.baseCoin), known);
    if (canonical) raw.push({ canonical, exchange: "bitget", symbol: text(item.symbol) });
  }

  const gateItems = Array.isArray(gate.value) ? records(gate.value) : [];
  const gateExactSymbols = new Set(
    gateItems
      .filter((item) => text(item.contract_type) === "stocks")
      .map((item) => text(item.name))
      .filter((symbol) => symbol.endsWith("_USDT"))
      .map((symbol) => directCanonical(symbol.slice(0, -5))),
  );
  for (const item of gateItems) {
    const symbol = text(item.name);
    if (
      Boolean(item.in_delisting) ||
      text(item.status) !== "trading" ||
      text(item.contract_type) !== "stocks" ||
      !symbol.endsWith("_USDT")
    ) continue;
    const rawUnderlying = symbol.slice(0, -5);
    const exact = directCanonical(rawUnderlying);
    let canonical = known.has(exact) ? exact : null;
    if (!canonical && rawUnderlying.endsWith("X")) {
      const withoutVenueSuffix = directCanonical(rawUnderlying.slice(0, -1));
      if (known.has(withoutVenueSuffix) && !gateExactSymbols.has(withoutVenueSuffix)) {
        canonical = withoutVenueSuffix;
      }
    }
    if (canonical) raw.push({ canonical, exchange: "gate", symbol });
  }

  const unique = new Map<string, Instrument>();
  for (const item of raw) {
    if (!item.symbol || !regions.has(item.canonical)) continue;
    const instrument: Instrument = { ...item, region: regions.get(item.canonical) ?? "US" };
    unique.set(`${item.exchange}:${item.symbol}`, instrument);
  }
  const value = { instruments: [...unique.values()], errors };
  discoveryCache = { expiresAt: now + DISCOVERY_TTL_MS, value };
  return value;
}

function pointsFromRows(
  instruments: Instrument[],
  rows: JsonRecord[],
  symbolKey: string,
  priceKeys: string[],
  options?: { timestampKey?: string },
): Quote[] {
  const wanted = new Map(instruments.map((item) => [item.symbol, item]));
  const now = Date.now();
  const result: Quote[] = [];
  for (const row of rows) {
    const instrument = wanted.get(text(row[symbolKey]));
    if (!instrument) continue;
    const price = priceKeys.map((key) => number(row[key])).find((value) => value > 0) ?? 0;
    if (!price) continue;
    result.push({
      exchange: instrument.exchange,
      venue: EXCHANGE_LABELS[instrument.exchange],
      symbol: instrument.symbol,
      price,
      timestamp: options?.timestampKey ? number(row[options.timestampKey]) || now : now,
    });
  }
  return result;
}

async function fetchHyperliquidPrices(instruments: Instrument[]): Promise<Quote[]> {
  const byDex = new Map<string, Instrument[]>();
  for (const item of instruments) {
    const dex = item.dex ?? "";
    byDex.set(dex, [...(byDex.get(dex) ?? []), item]);
  }
  const now = Date.now();
  const requests = [...byDex.entries()].map(async ([dex, items]) => {
    const payload = await fetchJson("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex }),
    });
    const wanted = new Map(items.map((item) => [item.symbol, item]));
    return activeHyperliquidMarkets(payload).flatMap((market): Quote[] => {
      const instrument = wanted.get(market.name);
      if (!instrument) return [];
      return [{
        exchange: "hyperliquid",
        venue: dex ? `Hyperliquid · ${dex}` : "Hyperliquid",
        symbol: instrument.symbol,
        price: market.price,
        timestamp: now,
        volume: market.volume,
      }];
    });
  });
  return (await Promise.all(requests)).flat();
}

async function fetchPrices(instruments: Instrument[]): Promise<{ quotes: Map<string, Quote[]>; errors: string[] }> {
  const groups = new Map<Exchange, Instrument[]>();
  for (const item of instruments) groups.set(item.exchange, [...(groups.get(item.exchange) ?? []), item]);

  const tasks: Array<Promise<{ exchange: Exchange; value: Quote[] | null; error: string | null }>> = [];
  const enqueue = (exchange: Exchange, promise: Promise<Quote[]>) => {
    tasks.push(attempt(EXCHANGE_LABELS[exchange], promise).then((result) => ({ exchange, ...result })));
  };

  if (groups.has("binance")) enqueue("binance", (async () => {
    const payload = await fetchJson("https://fapi.binance.com/fapi/v1/premiumIndex");
    return pointsFromRows(groups.get("binance") ?? [], records(payload), "symbol", ["markPrice"], { timestampKey: "time" });
  })());
  if (groups.has("bitget")) enqueue("bitget", (async () => {
    const payload = await fetchJson("https://api.bitget.com/api/v3/market/tickers?category=USDT-FUTURES");
    return pointsFromRows(groups.get("bitget") ?? [], records(isRecord(payload) ? payload.data : []), "symbol", ["markPrice", "lastPrice"], { timestampKey: "ts" });
  })());
  if (groups.has("gate")) enqueue("gate", (async () => {
    const payload = await fetchJson("https://api.gateio.ws/api/v4/futures/usdt/tickers");
    return pointsFromRows(groups.get("gate") ?? [], records(payload), "contract", ["mark_price", "last"]);
  })());
  if (groups.has("bybit")) enqueue("bybit", (async () => {
    const payload = await fetchJson("https://api.bybit.com/v5/market/tickers?category=linear");
    const list = arrayAt(objectAt(payload, "result"), "list");
    return pointsFromRows(groups.get("bybit") ?? [], records(list), "symbol", ["markPrice", "lastPrice"]);
  })());
  if (groups.has("okx")) enqueue("okx", (async () => {
    const payload = await fetchJson("https://www.okx.com/api/v5/public/mark-price?instType=SWAP");
    return pointsFromRows(groups.get("okx") ?? [], records(isRecord(payload) ? payload.data : []), "instId", ["markPx"], { timestampKey: "ts" });
  })());
  if (groups.has("hyperliquid")) enqueue("hyperliquid", fetchHyperliquidPrices(groups.get("hyperliquid") ?? []));

  const settled = await Promise.all(tasks);
  const errors = settled.map((item) => item.error).filter((value): value is string => Boolean(value));
  const byCanonical = new Map<string, Quote[]>();
  const instrumentIndex = new Map(instruments.map((item) => [`${item.exchange}:${item.symbol}`, item]));
  for (const result of settled) {
    for (const quote of result.value ?? []) {
      const instrument = instrumentIndex.get(`${quote.exchange}:${quote.symbol}`);
      if (!instrument) continue;
      byCanonical.set(instrument.canonical, [...(byCanonical.get(instrument.canonical) ?? []), quote]);
    }
  }
  return { quotes: byCanonical, errors };
}

async function fetchUnifiedCloses(marketOpen: boolean): Promise<CloseResult> {
  const headers = {
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.nasdaq.com",
    referer: "https://www.nasdaq.com/market-activity/stocks/screener",
    "user-agent": "Mozilla/5.0",
  };
  const [stocks, etfs, korean] = await Promise.all([
    attempt(
      "Nasdaq 股票收盘价",
      fetchJson("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true", { headers }),
    ),
    attempt(
      "Nasdaq ETF 收盘价",
      fetchJson("https://api.nasdaq.com/api/screener/etf?tableonly=true&limit=10000&download=true", { headers }),
    ),
    fetchKoreanCloses({ catalog: STOCK_CATALOG, fetchJson }),
  ]);

  const stockData = objectAt(stocks.value, "data");
  const etfEnvelope = objectAt(etfs.value, "data");
  const etfData = objectAt(etfEnvelope, "data");
  const marketRows = [
    ...records(stockData.rows).map((row) => ({
      symbol: text(row.symbol),
      last: marketNumber(row.lastsale),
      change: marketNumber(row.netchange),
    })),
    ...records(etfData.rows).map((row) => ({
      symbol: text(row.symbol),
      last: marketNumber(row.lastSalePrice),
      change: marketNumber(row.netChange),
    })),
  ];

  const byMarketSymbol = new Map<string, number>();
  for (const row of marketRows) {
    if (!row.symbol || row.last <= 0) continue;
    const close = marketOpen ? row.last - row.change : row.last;
    if (close > 0) byMarketSymbol.set(row.symbol.toUpperCase(), close);
  }

  const closes = new Map<string, number>(korean.closes);
  const sources = new Map<string, string>(korean.sources);
  for (const [canonical, catalogItem] of Object.entries(STOCK_CATALOG)) {
    if (catalogItem.region !== "US" || catalogItem.name.includes("主题合约")) continue;
    const marketSymbol = UNIFIED_CLOSE_SYMBOLS[canonical] ?? canonical;
    const close = byMarketSymbol.get(marketSymbol);
    if (close) {
      closes.set(canonical, close);
      sources.set(canonical, "Nasdaq");
    }
  }

  return {
    closes,
    sources,
    asOf: [text(stockData.dataAsOf) || text(etfEnvelope.dataAsOf), korean.asOf].filter(Boolean).join(" · ") || null,
    errors: [stocks.error, etfs.error, ...korean.errors].filter((value): value is string => Boolean(value)),
  };
}

async function marketState(): Promise<MarketState> {
  const now = Date.now();
  try {
    const payload = await fetchJson("https://fapi.binance.com/fapi/v1/tradingSchedule");
    const marketSchedules = objectAt(payload, "marketSchedules");
    const equity = objectAt(marketSchedules, "EQUITY");
    const sessions = records(equity.sessions)
      .filter((item) => text(item.type) === "REGULAR")
      .map((item) => ({ start: number(item.startTime), end: number(item.endTime) }))
      .filter((item) => item.start > 0 && item.end > 0)
      .sort((a, b) => a.start - b.start);
    const current = sessions.find((session) => session.start <= now && now < session.end);
    if (current) return { open: true, label: "美股开市 · 等待休市", nextTransitionAt: current.end, source: "schedule" };
    const next = sessions.find((session) => session.start > now);
    return { open: false, label: "美股休市 · 监控中", nextTransitionAt: next?.start ?? null, source: "schedule" };
  } catch {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const minutes = number(values.hour) * 60 + number(values.minute);
    const weekday = values.weekday;
    const open = !["Sat", "Sun"].includes(weekday) && minutes >= 570 && minutes < 960;
    return { open, label: open ? "美股开市 · 等待休市" : "美股休市 · 监控中", nextTransitionAt: null, source: "fallback" };
  }
}

async function buildSnapshot(): Promise<JsonRecord> {
  const now = Date.now();
  if (snapshotCache && snapshotCache.expiresAt > now) return snapshotCache.value;
  const discovery = await discover();
  const market = await marketState();
  const [{ quotes, errors }, closeResult] = await Promise.all([
    fetchPrices(discovery.instruments),
    fetchUnifiedCloses(market.open),
  ]);
  const regions = new Map(discovery.instruments.map((item) => [item.canonical, item.region]));

  const rows = [...quotes.entries()].flatMap(([canonical, rawQuotes]) => {
    const bestByExchange = new Map<Exchange, Quote>();
    for (const quote of rawQuotes) {
      const current = bestByExchange.get(quote.exchange);
      if (!current || (quote.volume ?? 0) > (current.volume ?? 0)) bestByExchange.set(quote.exchange, quote);
    }
    const allQuotes = [...bestByExchange.values()];
    const closePrice = closeResult.closes.get(canonical) ?? null;
    const closeSource = closeResult.sources.get(canonical) ?? null;

    return allQuotes.map((quote) => {
      const priceDifference = closePrice === null ? null : quote.price - closePrice;
      const deviationPct = closePrice === null ? null : (priceDifference! / closePrice) * 100;
      return {
        id: `${quote.exchange}:${quote.symbol}`,
        stockSymbol: canonical,
        stockName: STOCK_CATALOG[canonical]?.name ?? `${canonical} 股票`,
        region: regions.get(canonical) ?? "US",
        exchange: quote.exchange,
        venue: quote.venue,
        contractSymbol: quote.symbol,
        currentPrice: quote.price,
        closePrice,
        closeSource: closePrice === null ? null : closeSource,
        priceDifference,
        deviationPct,
        alert: deviationPct !== null && Math.abs(deviationPct) >= 20,
        timestamp: quote.timestamp,
      };
    });
  }).sort((a, b) => {
    const bMagnitude = b.deviationPct === null ? -1 : Math.abs(b.deviationPct);
    const aMagnitude = a.deviationPct === null ? -1 : Math.abs(a.deviationPct);
    return bMagnitude - aMagnitude;
  });

  const value: JsonRecord = {
    generatedAt: now,
    refreshSeconds: 300,
    market,
    closeProvider: "Nasdaq / KRX",
    closeAsOf: closeResult.asOf,
    rows,
    venues: Object.values(EXCHANGE_LABELS),
    referenceCoverage: rows.filter((row) => row.closePrice !== null).length,
    alertCount: rows.filter((row) => row.alert).length,
    activeVenues: new Set(rows.map((row) => row.exchange)).size,
    errors: [...discovery.errors, ...errors, ...closeResult.errors],
  };
  snapshotCache = { expiresAt: now + SNAPSHOT_TTL_MS, value };
  return value;
}

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await buildSnapshot();
    return Response.json(payload, {
      headers: {
        "Cache-Control": "public, max-age=45, s-maxage=300, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取行情";
    return Response.json(
      { generatedAt: Date.now(), rows: [], errors: [message], refreshSeconds: 300 },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
