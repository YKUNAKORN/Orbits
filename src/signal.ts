import { at, type Candle, type Signal } from "./types.js";

const EMA_FAST = 12;
const EMA_MID = 26;
const EMA_SLOW = 100;
// 500 bars: (1 - 2/101)^500 ~= 5e-5, so a fresh EMA100 seed's error is negligible by then.
const MIN_WARMUP_BARS = 500;

function ema(values: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out = new Array<number>(values.length);
  out[0] = at(values, 0);
  for (let i = 1; i < values.length; i++) {
    out[i] = at(values, i) * k + at(out, i - 1) * (1 - k);
  }
  return out;
}

function isStrong(bar: Candle): boolean {
  const range = bar.high - bar.low;
  return range > 0 && Math.abs(bar.close - bar.open) > 0.5 * range;
}

function isStrongUp(bar: Candle): boolean {
  return isStrong(bar) && bar.close > bar.open;
}

function isStrongDown(bar: Candle): boolean {
  return isStrong(bar) && bar.close < bar.open;
}

// candles must be oldest-to-newest; the last element is bar[0], the signal bar.
export function computeSignal(candles: readonly Candle[]): Signal | null {
  if (candles.length < MIN_WARMUP_BARS) return null;

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, EMA_FAST);
  const emaMid = ema(closes, EMA_MID);
  const emaSlow = ema(closes, EMA_SLOW);

  const last = candles.length - 1;
  const bar0 = at(candles, last);
  const bar1 = at(candles, last - 1);
  const bar2 = at(candles, last - 2); // first candle of the three (oldest)

  const eFast = at(emaFast, last);
  const eMid = at(emaMid, last);
  const eSlow = at(emaSlow, last);

  const longTrend = eFast > eMid && eMid > eSlow;
  const shortTrend = eFast < eMid && eMid < eSlow;

  if (longTrend && isStrongUp(bar0) && isStrongUp(bar1) && isStrongUp(bar2)) {
    const entry = bar0.close;
    const sl = bar2.low;
    if (sl >= entry) return null; // degenerate: SL on wrong side of entry
    const tp = entry + 2 * (entry - sl);
    return { side: "long", time: bar0.ts, entry, sl, tp };
  }

  if (shortTrend && isStrongDown(bar0) && isStrongDown(bar1) && isStrongDown(bar2)) {
    const entry = bar0.close;
    const sl = bar2.high;
    if (sl <= entry) return null; // degenerate: SL on wrong side of entry
    const tp = entry - 2 * (sl - entry);
    return { side: "short", time: bar0.ts, entry, sl, tp };
  }

  return null;
}

export const SIGNAL_MIN_WARMUP_BARS = MIN_WARMUP_BARS;
