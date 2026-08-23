import { at, type Candle } from "./types.js";

export interface DuplicateTs {
  ts: number;
  count: number;
}

export interface OutOfOrderPair {
  index: number;
  prevTs: number;
  ts: number;
}

export interface Gap {
  afterTs: number;
  beforeTs: number;
  missingCount: number;
}

export interface OhlcViolation {
  ts: number;
  index: number;
  reason: string;
}

export interface ValidationReport {
  intervalMs: number;
  candleCount: number;
  duplicates: DuplicateTs[];
  outOfOrder: OutOfOrderPair[];
  gaps: Gap[];
  ohlcViolations: OhlcViolation[];
}

export function validateCandles(candles: readonly Candle[], intervalMs: number): ValidationReport {
  const duplicates: DuplicateTs[] = [];
  const outOfOrder: OutOfOrderPair[] = [];
  const gaps: Gap[] = [];
  const ohlcViolations: OhlcViolation[] = [];

  const seen = new Map<number, number>();
  for (const c of candles) seen.set(c.ts, (seen.get(c.ts) ?? 0) + 1);
  for (const [ts, count] of seen) {
    if (count > 1) duplicates.push({ ts, count });
  }
  duplicates.sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < candles.length; i++) {
    const c = at(candles, i);
    const maxOc = Math.max(c.open, c.close);
    const minOc = Math.min(c.open, c.close);
    if (c.high < maxOc) {
      ohlcViolations.push({ ts: c.ts, index: i, reason: `high ${c.high} < max(open,close) ${maxOc}` });
    }
    if (c.low > minOc) {
      ohlcViolations.push({ ts: c.ts, index: i, reason: `low ${c.low} > min(open,close) ${minOc}` });
    }

    if (i === 0) continue;
    const prev = at(candles, i - 1);
    const diff = c.ts - prev.ts;
    if (diff <= 0) {
      outOfOrder.push({ index: i, prevTs: prev.ts, ts: c.ts });
      continue;
    }
    if (diff !== intervalMs) {
      gaps.push({ afterTs: prev.ts, beforeTs: c.ts, missingCount: Math.round(diff / intervalMs) - 1 });
    }
  }

  return { intervalMs, candleCount: candles.length, duplicates, outOfOrder, gaps, ohlcViolations };
}

// Splits into runs with no gap, duplicate, or out-of-order break, so a signal
// window built from one segment can never straddle missing or bad data.
export function splitIntoContiguousSegments(
  candles: readonly Candle[],
  intervalMs: number,
): Candle[][] {
  if (candles.length === 0) return [];
  const segments: Candle[][] = [];
  let current: Candle[] = [at(candles, 0)];
  for (let i = 1; i < candles.length; i++) {
    const c = at(candles, i);
    const prev = at(candles, i - 1);
    if (c.ts - prev.ts === intervalMs) {
      current.push(c);
    } else {
      segments.push(current);
      current = [c];
    }
  }
  segments.push(current);
  return segments;
}
