import { FIFTEEN_MIN_MS, FIVE_MIN_MS, FOUR_HOUR_MS, ONE_HOUR_MS, ONE_MIN_MS } from "./types.js";

// OKX candle "bar" query params this codebase fetches/backtests. Every
// value here is also a valid OKX API bar string as-is - no translation
// layer needed between the CLI, the fetch endpoint, and the data filename.
export const SUPPORTED_BARS = ["1m", "5m", "15m", "1H", "4H"] as const;
export type Bar = (typeof SUPPORTED_BARS)[number];

export function isBar(value: string): value is Bar {
  return (SUPPORTED_BARS as readonly string[]).includes(value);
}

export function barIntervalMs(bar: Bar): number {
  switch (bar) {
    case "1m":
      return ONE_MIN_MS;
    case "5m":
      return FIVE_MIN_MS;
    case "15m":
      return FIFTEEN_MIN_MS;
    case "1H":
      return ONE_HOUR_MS;
    case "4H":
      return FOUR_HOUR_MS;
  }
}
