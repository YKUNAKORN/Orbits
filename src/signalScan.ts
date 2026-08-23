import type { Candle, Signal } from "./types.js";
import { computeSignal, SIGNAL_MIN_WARMUP_BARS } from "./signal.js";

// Slides a trailing window (capped at SIGNAL_MIN_WARMUP_BARS) across a
// contiguous segment, calling computeSignal at every bar. Capping the
// window keeps this O(n) instead of O(n^2) over a multi-year 5m series.
export function generateSignals(segment: readonly Candle[]): Signal[] {
  const signals: Signal[] = [];
  for (let i = 0; i < segment.length; i++) {
    const start = Math.max(0, i - SIGNAL_MIN_WARMUP_BARS + 1);
    const window = segment.slice(start, i + 1);
    const signal = computeSignal(window);
    if (signal) signals.push(signal);
  }
  return signals;
}
