export const ONE_MIN_MS = 60_000;
export const FIVE_MIN_MS = 5 * ONE_MIN_MS;
export const FIFTEEN_MIN_MS = 15 * ONE_MIN_MS;
export const ONE_HOUR_MS = 60 * ONE_MIN_MS;
export const FOUR_HOUR_MS = 4 * ONE_HOUR_MS;

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = "long" | "short";

export interface Signal {
  side: Side;
  time: number;
  entry: number;
  sl: number;
  tp: number;
}

export function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`index ${index} out of bounds (length ${arr.length})`);
  }
  return value;
}
