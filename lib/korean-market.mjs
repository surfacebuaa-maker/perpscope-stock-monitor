const NAVER_HEADERS = {
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
  referer: "https://m.stock.naver.com/",
  "user-agent": "Mozilla/5.0",
};

function marketNumber(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function seoulParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function selectLastCompletedKoreanClose(rows, now = Date.now()) {
  const valid = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: String(row?.localTradedAt ?? "").slice(0, 10),
      close: marketNumber(row?.closePrice),
    }))
    .filter((row) => row.date && row.close > 0);
  if (!valid.length) return null;

  const parts = seoulParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = marketNumber(parts.hour) * 60 + marketNumber(parts.minute);
  const regularCloseSettled = minutes >= 15 * 60 + 35;
  if (!regularCloseSettled && valid[0].date === today) return valid[1] ?? null;
  return valid[0];
}

export function koreanCloseInUsd(closeKrw, usdKrw) {
  if (!(closeKrw > 0) || !(usdKrw > 0)) return null;
  return closeKrw / usdKrw;
}

async function attempt(label, task) {
  try {
    return { value: await task, error: null };
  } catch (error) {
    return { value: null, error: `${label}: ${error instanceof Error ? error.message : "读取失败"}` };
  }
}

export async function fetchKoreanCloses({ catalog, fetchJson, now = Date.now() }) {
  const entries = catalog instanceof Map ? [...catalog.entries()] : Object.entries(catalog ?? {});
  const koreanStocks = entries.filter(([, item]) => item?.region === "KR" && item?.referenceSymbol);
  const fxAttempt = await attempt(
    "USD/KRW 汇率",
    fetchJson(
      "https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW",
      { headers: NAVER_HEADERS },
    ),
  );
  const fxResult = fxAttempt.value?.result ?? {};
  const usdKrw = marketNumber(fxResult.calcPrice) || marketNumber(fxResult.closePrice);
  const errors = [fxAttempt.error].filter(Boolean);
  if (!(usdKrw > 0)) {
    errors.push("USD/KRW 汇率: 暂无有效报价");
    return { closes: new Map(), sources: new Map(), asOf: null, usdKrw: null, errors };
  }

  const results = await Promise.all(koreanStocks.map(async ([symbol, item]) => {
    const result = await attempt(
      `KRX ${symbol}`,
      fetchJson(
        `https://m.stock.naver.com/api/stock/${item.referenceSymbol}/price?pageSize=3&page=1`,
        { headers: NAVER_HEADERS },
      ),
    );
    return { symbol, result };
  }));

  const closes = new Map();
  const sources = new Map();
  const dates = [];
  for (const { symbol, result } of results) {
    if (result.error) errors.push(result.error);
    const selected = selectLastCompletedKoreanClose(result.value, now);
    const close = selected ? koreanCloseInUsd(selected.close, usdKrw) : null;
    if (!close) {
      if (!result.error) errors.push(`KRX ${symbol}: 暂无有效收盘价`);
      continue;
    }
    closes.set(symbol, close);
    sources.set(symbol, "KRX · USD/KRW");
    dates.push(selected.date);
  }

  const latestDate = dates.sort().at(-1) ?? null;
  const fxAsOf = String(fxResult.localTradedAt ?? "").slice(0, 16) || null;
  return {
    closes,
    sources,
    asOf: [latestDate && `KRX ${latestDate}`, fxAsOf && `USD/KRW ${fxAsOf}`].filter(Boolean).join(" · ") || null,
    usdKrw,
    errors,
  };
}
