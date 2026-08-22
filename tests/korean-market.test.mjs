import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fetchKoreanCloses,
  koreanCloseInUsd,
  selectLastCompletedKoreanClose,
} from "../lib/korean-market.mjs";
import { activeHyperliquidMarkets } from "../lib/hyperliquid-market.mjs";

const rows = [
  { localTradedAt: "2026-08-14", closePrice: "79,200" },
  { localTradedAt: "2026-08-13", closePrice: "78,000" },
];

test("uses the previous completed KRX session while Korea is still trading", () => {
  const selected = selectLastCompletedKoreanClose(rows, Date.parse("2026-08-14T10:00:00+09:00"));
  assert.deepEqual(selected, { date: "2026-08-13", close: 78_000 });
});

test("uses today's KRX close after the regular session has settled", () => {
  const selected = selectLastCompletedKoreanClose(rows, Date.parse("2026-08-14T16:00:00+09:00"));
  assert.deepEqual(selected, { date: "2026-08-14", close: 79_200 });
});

test("converts the native KRW close into the USDT contract price scale", () => {
  assert.equal(koreanCloseInUsd(79_200, 1_418.5), 79_200 / 1_418.5);
});

test("fetches a converted close and source for a catalogued Korean stock", async () => {
  const catalog = new Map([
    ["DOOSBOT", { region: "KR", name: "斗山机器人", referenceSymbol: "454910" }],
  ]);
  const fetchJson = async (url) => {
    if (url.includes("marketIndex/productDetail")) {
      return { result: { calcPrice: "1,400.00", localTradedAt: "2026-08-14T16:00:00+09:00" } };
    }
    assert.match(url, /\/454910\/price/);
    return rows;
  };

  const result = await fetchKoreanCloses({
    catalog,
    fetchJson,
    now: Date.parse("2026-08-14T16:00:00+09:00"),
  });

  assert.equal(result.closes.get("DOOSBOT"), 79_200 / 1_400);
  assert.equal(result.sources.get("DOOSBOT"), "KRX · USD/KRW");
  assert.deepEqual(result.errors, []);
});

test("the stock catalog includes both Bitget Doosan contracts", async () => {
  const source = await readFile(new URL("../lib/stock-catalog.ts", import.meta.url), "utf8");
  assert.match(source, /DOOSBOT:\s*"454910"/);
  assert.match(source, /DOOSENER:\s*"034020"/);
});

test("the stock catalog includes the missing Gate Korean contracts", async () => {
  const source = await readFile(new URL("../lib/stock-catalog.ts", import.meta.url), "utf8");
  assert.match(source, /SKSQUARE:\s*"402340"/);
  assert.match(source, /HPSP:\s*"403870"/);
  assert.match(source, /JUSUNG:\s*"036930"/);
});

test("the GitHub Pages collector refreshes Gate without a Sites rebuild", async () => {
  const source = await readFile(new URL("../scripts/collect-pages.mjs", import.meta.url), "utf8");
  assert.match(source, /api\.gateio\.ws\/api\/v4\/futures\/usdt\/contracts/);
  assert.match(source, /api\.gateio\.ws\/api\/v4\/futures\/usdt\/tickers/);
  assert.match(source, /\["binance", "bitget", "gate"\]/);
});

test("ignores delisted Hyperliquid markets that still expose a mark price", () => {
  const markets = activeHyperliquidMarkets([
    {
      universe: [
        { name: "km:BMNR", isDelisted: true },
        { name: "xyz:NVDA" },
      ],
    },
    [
      { markPx: "15.749", dayNtlVlm: "0.0" },
      { markPx: "175.25", dayNtlVlm: "12345.67" },
    ],
  ]);

  assert.deepEqual(markets, [
    { name: "xyz:NVDA", price: 175.25, volume: 12345.67 },
  ]);
});

test("the stock catalog includes instruments launched after the last sync", async () => {
  const source = await readFile(new URL("../lib/stock-catalog.ts", import.meta.url), "utf8");
  const catalogSymbols = new Set(source.match(/const US_SYMBOLS = `([\s\S]*?)`/)?.[1].trim().split(/\s+/) ?? []);
  const symbols = [
    "GDX", "NET", "VST", "SHOP", "LYTE", "FUTU", "JD", "OUST", "ISRG", "ADI", "PDD",
    "MOONSHOT", "DDOG", "ANET", "CXMT", "UNITREE", "MRNA", "TEM", "MRK", "MNST", "PURR",
  ];

  for (const symbol of symbols) {
    assert.ok(catalogSymbols.has(symbol), `${symbol} is missing from US_SYMBOLS`);
  }
});
