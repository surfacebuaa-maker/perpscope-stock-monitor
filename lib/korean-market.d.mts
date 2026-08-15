export type KoreanCatalogItem = {
  region: string;
  name: string;
  referenceSymbol?: string;
};

export type KoreanCloseResult = {
  closes: Map<string, number>;
  sources: Map<string, string>;
  asOf: string | null;
  usdKrw: number | null;
  errors: string[];
};

export function selectLastCompletedKoreanClose(
  rows: unknown,
  now?: number,
): { date: string; close: number } | null;

export function koreanCloseInUsd(closeKrw: number, usdKrw: number): number | null;

export function fetchKoreanCloses(options: {
  catalog: Map<string, KoreanCatalogItem> | Record<string, KoreanCatalogItem>;
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
  now?: number;
}): Promise<KoreanCloseResult>;
