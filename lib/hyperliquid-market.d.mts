export type ActiveHyperliquidMarket = {
  name: string;
  price: number;
  volume: number;
};

export function activeHyperliquidMarkets(payload: unknown): ActiveHyperliquidMarket[];
