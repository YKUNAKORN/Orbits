import { at, type Signal } from "./types.js";
import type { InstrumentSpec } from "./instrumentSpec.js";
import {
  computeNaturalResolutions,
  runScenario,
  type BacktestConfig,
  type NaturalResolution,
  type PreparedData,
} from "./backtestEngine.js";

// Deterministic PRNG (mulberry32) so a permutation run is exactly
// reproducible - re-running this file must reproduce the same 100 trials.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// For every real raw signal's anchor (bar2, bar0), constructs what the
// FROZEN entry/SL/TP formula (CLAUDE.md section 4) would produce for EACH
// possible direction at that exact same bar - not a synthetic/resampled
// SL distance, the same real bar2.low/bar2.high the real signal used.
// null means that direction is degenerate at this anchor (SL lands on the
// wrong side of entry, same guard signal.ts itself applies) and so could
// never have been a real signal there either way.
//
// This is the null-hypothesis construction for "does the 3-strong-candle +
// EMA pattern predict DIRECTION, or would a coin flip at the same moments,
// with the same entry price / SL distance / R:R / sizing formula, do just
// as well": everything about the trade is held fixed except which way it
// points.
export interface DirectionalVariants {
  longSignalsBySegment: (Signal | null)[][];
  shortSignalsBySegment: (Signal | null)[][];
  longResolutionsBySegment: (NaturalResolution | null)[][];
  shortResolutionsBySegment: (NaturalResolution | null)[][];
}

export function buildDirectionalVariants(prepared: PreparedData, spec: InstrumentSpec): DirectionalVariants {
  const longSignalsBySegment: (Signal | null)[][] = [];
  const shortSignalsBySegment: (Signal | null)[][] = [];
  const rawLongResolutionsBySegment: NaturalResolution[][] = [];
  const rawShortResolutionsBySegment: NaturalResolution[][] = [];

  for (let s = 0; s < prepared.segments.length; s++) {
    const segment = at(prepared.segments, s);
    const realSignals = at(prepared.signalsBySegment, s);
    const tsToIndex = new Map<number, number>();
    segment.forEach((c, i) => tsToIndex.set(c.ts, i));

    const longSignals: (Signal | null)[] = [];
    const shortSignals: (Signal | null)[] = [];
    for (const real of realSignals) {
      const entryIndex = tsToIndex.get(real.time);
      if (entryIndex === undefined || entryIndex < 2) {
        // Can't happen for a real signal (warmup guarantees >=500 prior
        // bars), but stay defensive rather than crash on an index that
        // isn't there.
        longSignals.push(null);
        shortSignals.push(null);
        continue;
      }
      const bar0 = at(segment, entryIndex);
      const bar2 = at(segment, entryIndex - 2);
      const entry = bar0.close;

      const longSl = bar2.low;
      longSignals.push(
        longSl < entry ? { side: "long", time: bar0.ts, entry, sl: longSl, tp: entry + 2 * (entry - longSl) } : null,
      );

      const shortSl = bar2.high;
      shortSignals.push(
        shortSl > entry
          ? { side: "short", time: bar0.ts, entry, sl: shortSl, tp: entry - 2 * (shortSl - entry) }
          : null,
      );
    }

    longSignalsBySegment.push(longSignals);
    shortSignalsBySegment.push(shortSignals);
    rawLongResolutionsBySegment.push(
      computeNaturalResolutions(segment, longSignals.filter((s): s is Signal => s !== null), spec.tickSz),
    );
    rawShortResolutionsBySegment.push(
      computeNaturalResolutions(segment, shortSignals.filter((s): s is Signal => s !== null), spec.tickSz),
    );
  }

  // computeNaturalResolutions only saw the non-null signals, so its output
  // is shorter than the (Signal|null)[] arrays above. Re-expand back to
  // parallel, null-aligned arrays so index k means "the k-th anchor" in
  // both the signal and resolution arrays.
  const reExpand = (
    signals: readonly (Signal | null)[][],
    resolutions: readonly NaturalResolution[][],
  ): (NaturalResolution | null)[][] =>
    signals.map((segSignals, s) => {
      const segResolutions = at(resolutions, s);
      let cursor = 0;
      return segSignals.map((sig) => (sig === null ? null : at(segResolutions, cursor++)));
    });

  return {
    longSignalsBySegment,
    shortSignalsBySegment,
    longResolutionsBySegment: reExpand(longSignalsBySegment, rawLongResolutionsBySegment),
    shortResolutionsBySegment: reExpand(shortSignalsBySegment, rawShortResolutionsBySegment),
  };
}

export interface PermutationTrialResult {
  n: number;
  wins: number;
  winRate: number;
  expectancyR: number;
}

// Runs ONE random-direction trial through backtestEngine.ts's real
// runScenario - not a reimplementation of the walk, the literal same
// function real scenarios use - so one-position-at-a-time, position
// sizing, and equity compounding are structurally identical to the real
// backtest. Only which (long|short) variant is picked at each anchor is
// random.
export function runPermutationTrial(
  prepared: PreparedData,
  variants: DirectionalVariants,
  spec: InstrumentSpec,
  rng: () => number,
  startingEquityUsdt: number,
): PermutationTrialResult {
  const trialSignalsBySegment: Signal[][] = [];
  const trialResolutionsBySegment: NaturalResolution[][] = [];

  for (let s = 0; s < prepared.segments.length; s++) {
    const longs = at(variants.longSignalsBySegment, s);
    const shorts = at(variants.shortSignalsBySegment, s);
    const longRes = at(variants.longResolutionsBySegment, s);
    const shortRes = at(variants.shortResolutionsBySegment, s);

    const signals: Signal[] = [];
    const resolutions: NaturalResolution[] = [];
    for (let k = 0; k < longs.length; k++) {
      const pickLong = rng() < 0.5;
      const sig = pickLong ? at(longs, k) : at(shorts, k);
      const res = pickLong ? at(longRes, k) : at(shortRes, k);
      if (sig === null || res === null) continue; // degenerate in the coin-flip's chosen direction at this anchor
      signals.push(sig);
      resolutions.push(res);
    }
    trialSignalsBySegment.push(signals);
    trialResolutionsBySegment.push(resolutions);
  }

  const trialPrepared: PreparedData = {
    segments: prepared.segments,
    signalsBySegment: trialSignalsBySegment,
    naturalResolutionsBySegment: trialResolutionsBySegment,
    totalSignalCount: trialSignalsBySegment.reduce((n, s) => n + s.length, 0),
    firstTs: prepared.firstTs,
    lastTs: prepared.lastTs,
  };

  const config: BacktestConfig = {
    startingEquityUsdt,
    slippageTicks: 0,
    ambiguousBound: "lower",
    feeModel: "limit-tp",
    takerFeeRate: 0,
    makerFeeRate: 0,
    fundingRateForCost: null,
  };

  const run = runScenario(trialPrepared, spec, config);
  const n = run.trades.length;
  const wins = run.trades.filter((t) => t.netPnlUsdt > 0).length; // fee=0 -> net === gross
  return {
    n,
    wins,
    winRate: n > 0 ? wins / n : NaN,
    expectancyR: n > 0 ? run.trades.reduce((sum, t) => sum + t.rMultiple, 0) / n : NaN,
  };
}

export function runPermutationTrials(
  prepared: PreparedData,
  variants: DirectionalVariants,
  spec: InstrumentSpec,
  startingEquityUsdt: number,
  trialCount: number,
  seed: number,
): PermutationTrialResult[] {
  const rng = mulberry32(seed);
  const trials: PermutationTrialResult[] = [];
  for (let i = 0; i < trialCount; i++) {
    trials.push(runPermutationTrial(prepared, variants, spec, rng, startingEquityUsdt));
  }
  return trials;
}

// Fraction of `sample` at or below `value`, as a percentile (0-100). Used
// to place the real system's win rate/expectancy within the random
// distribution.
export function percentileRankOf(value: number, sample: readonly number[]): number {
  if (sample.length === 0) return NaN;
  const countAtOrBelow = sample.filter((s) => s <= value).length;
  return (countAtOrBelow / sample.length) * 100;
}
