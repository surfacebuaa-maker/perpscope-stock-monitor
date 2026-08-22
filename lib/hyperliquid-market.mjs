function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function marketNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function activeHyperliquidMarkets(payload) {
  if (!Array.isArray(payload) || payload.length !== 2 || !isRecord(payload[0])) return [];

  const universe = Array.isArray(payload[0].universe) ? payload[0].universe : [];
  const contexts = Array.isArray(payload[1]) ? payload[1] : [];

  return universe.flatMap((meta, index) => {
    if (!isRecord(meta) || meta.isDelisted === true) return [];

    const context = contexts[index];
    if (!isRecord(context)) return [];

    const name = typeof meta.name === "string" ? meta.name : "";
    const price = marketNumber(context.markPx);
    if (!name || !(price > 0)) return [];

    return [{
      name,
      price,
      volume: marketNumber(context.dayNtlVlm),
    }];
  });
}
