import { at, type Candle, type Side, type Signal } from "./types.js";
import type { InstrumentSpec } from "./instrumentSpec.js";
import { SIGNAL_MIN_WARMUP_BARS } from "./signal.js";
import { computeFixedRiskPositionSize } from "./positionSizing.js";
import { sum } from "./stats.js";
import {
  computeNaturalResolutions,
  runScenario,
  type BacktestConfig,
  type NaturalResolution,
  type PreparedData,
  type SizingFn,
} from "./backtestEngine.js";

// Deterministic PRNG (mulberry32) so a permutation run is exactly
// reproducible - re-running this file must reproduce the same trials.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Null hypothesis: random ENTRY TIMING, not random direction ----------
//
// The previous version of this file (buildDirectionalVariants +
// runPermutationTrial) held each real signal's anchor fixed and re-drew only
// long-vs-short by a fair coin, reusing the SAME bar2/bar0 the real pattern
// picked. The auditor found that construction geometrically broken: after
// three consecutive strong candles in one direction, the OPPOSITE
// direction's SL (bar2.high for a would-be short at a real long anchor, or
// vice versa) is degenerate at essentially every anchor (auditor-measured:
// valid at 0.345% of 5m anchors). Each "trial" ended up close to a random
// ~50% subsample of the real system's own trades, not a coin-flip baseline -
// a subsample of a strategy's own trades is centered on that strategy's own
// mean by construction, so the test had almost no power to detect anything.
//
// This version keeps the anchor's PRICE LEVELS out of the null entirely and
// instead randomizes WHICH BAR is treated as the signal bar: draw as many
// random, distinct bar0 positions as there are real signals, from the same
// warm-up-eligible universe real signals are drawn from, assign them the
// exact real long/short split (not a per-anchor coin, so every trial
// reproduces the real ratio exactly rather than a noisy approximation of
// it), and construct entry/SL/TP with the FROZEN formula (CLAUDE.md section
// 4) at that random bar0/bar2 - unlike the direction-flip null, a random
// bar0 has no systematic relationship to its own bar2, so degeneracy should
// be rare (measured, not assumed - see ANCHOR_VALIDITY_MIN_PCT below). The
// question this answers: does the pattern's chosen timing beat picking the
// same number of long/short trades at uniformly random moments?
//
// Sizing uses the fixed-risk measurement mode (positionSizing.ts), not
// equity compounding, per the same truncated-sample concern that motivated
// that mode: a trial's own losing streak must not shrink its sizing and
// silently drop later draws.

export interface EligibleAnchor {
  segmentIndex: number;
  barIndex: number; // index of bar0 within that segment
}

// Every position where a real signal COULD have been evaluated: bar0 needs
// SIGNAL_MIN_WARMUP_BARS candles behind it (the same EMA warm-up gate
// computeSignal applies via generateSignals' sliding window), and bar2
// (barIndex - 2) must exist. Matching generateSignals' own loop exactly
// means the random null draws from the same eligible universe the real
// signal scan does, not from the warm-up region no real signal could ever
// have occupied anyway.
export function eligibleAnchors(segments: readonly Candle[][]): EligibleAnchor[] {
  const anchors: EligibleAnchor[] = [];
  for (let s = 0; s < segments.length; s++) {
    const segment = at(segments, s);
    for (let i = SIGNAL_MIN_WARMUP_BARS - 1; i < segment.length; i++) {
      anchors.push({ segmentIndex: s, barIndex: i });
    }
  }
  return anchors;
}

export interface RealSideCounts {
  longCount: number;
  shortCount: number;
}

export function countRealSides(signalsBySegment: readonly Signal[][]): RealSideCounts {
  let longCount = 0;
  let shortCount = 0;
  for (const signals of signalsBySegment) {
    for (const s of signals) {
      if (s.side === "long") longCount += 1;
      else shortCount += 1;
    }
  }
  return { longCount, shortCount };
}

// Fisher-Yates partial shuffle: draws `n` distinct elements from `pool`
// without replacement, then undoes its own swaps so the caller's array is
// left exactly as it was afterward. Trials reuse one backing array (the
// eligible-anchor pool spans a multi-year 5m history - hundreds of
// thousands of entries) instead of copying it fresh per trial.
export function sampleWithoutReplacement<T>(pool: T[], n: number, rng: () => number): T[] {
  if (n > pool.length) {
    throw new Error(`cannot sample ${n} distinct items from a pool of ${pool.length}`);
  }
  const swaps: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const j = k + Math.floor(rng() * (pool.length - k));
    swaps.push([k, j]);
    if (j !== k) {
      const a = at(pool, k);
      pool[k] = at(pool, j);
      pool[j] = a;
    }
  }
  const chosen = pool.slice(0, n);
  for (let idx = swaps.length - 1; idx >= 0; idx--) {
    const [k, j] = at(swaps, idx);
    if (j !== k) {
      const a = at(pool, k);
      pool[k] = at(pool, j);
      pool[j] = a;
    }
  }
  return chosen;
}

// Full Fisher-Yates shuffle of a small array (the side multiset - one entry
// per anchor, so sized like the real signal count, not the eligible pool).
function shuffledCopy<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = at(arr, i);
    arr[i] = at(arr, j);
    arr[j] = tmp;
  }
  return arr;
}

export interface TimingTrialData {
  prepared: PreparedData;
  anchorsAttempted: number;
  anchorsValid: number;
}

// Builds ONE trial's PreparedData. `eligiblePool` is mutated during sampling
// and restored before this returns (see sampleWithoutReplacement), so the
// same pool array can be reused across many trials. An anchor is dropped
// (contributes no signal, counted in anchorsAttempted but not anchorsValid)
// if its assigned side is geometrically degenerate there - SL on the wrong
// side of entry - the same guard computeSignal itself applies.
export function buildRandomTimingTrial(
  segments: readonly Candle[][],
  eligiblePool: EligibleAnchor[],
  sides: RealSideCounts,
  spec: InstrumentSpec,
  rng: () => number,
  firstTs: number,
  lastTs: number,
): TimingTrialData {
  const n = sides.longCount + sides.shortCount;
  const chosenAnchors = sampleWithoutReplacement(eligiblePool, n, rng);
  const sideMultiset: Side[] = [...Array<Side>(sides.longCount).fill("long"), ...Array<Side>(sides.shortCount).fill("short")];
  const assignedSides = shuffledCopy(sideMultiset, rng);

  const picksBySegment = new Map<number, { barIndex: number; side: Side }[]>();
  chosenAnchors.forEach((anchor, idx) => {
    const list = picksBySegment.get(anchor.segmentIndex) ?? [];
    list.push({ barIndex: anchor.barIndex, side: at(assignedSides, idx) });
    picksBySegment.set(anchor.segmentIndex, list);
  });

  const signalsBySegment: Signal[][] = [];
  const naturalResolutionsBySegment: NaturalResolution[][] = [];
  let anchorsValid = 0;

  for (let s = 0; s < segments.length; s++) {
    const segment = at(segments, s);
    const picks = (picksBySegment.get(s) ?? []).sort((a, b) => a.barIndex - b.barIndex);
    const signals: Signal[] = [];
    for (const pick of picks) {
      const bar0 = at(segment, pick.barIndex);
      const bar2 = at(segment, pick.barIndex - 2);
      const entry = bar0.close;
      if (pick.side === "long") {
        const sl = bar2.low;
        if (sl >= entry) continue; // degenerate at this random anchor
        signals.push({ side: "long", time: bar0.ts, entry, sl, tp: entry + 2 * (entry - sl) });
      } else {
        const sl = bar2.high;
        if (sl <= entry) continue; // degenerate at this random anchor
        signals.push({ side: "short", time: bar0.ts, entry, sl, tp: entry - 2 * (sl - entry) });
      }
    }
    anchorsValid += signals.length;
    signalsBySegment.push(signals);
    naturalResolutionsBySegment.push(computeNaturalResolutions(segment, signals, spec.tickSz));
  }

  return {
    prepared: {
      segments: [...segments],
      signalsBySegment,
      naturalResolutionsBySegment,
      totalSignalCount: anchorsValid,
      firstTs,
      lastTs,
    },
    anchorsAttempted: n,
    anchorsValid,
  };
}

export interface TimingPermutationTrialResult {
  n: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  anchorsAttempted: number;
  anchorsValid: number;
}

// Fixed-risk sizing (positionSizing.ts), not equity compounding: a trial's
// own losing streak must not shrink its sizing and silently drop later
// draws, for the same reason backtest.ts's --sizing fixed mode exists.
const fixedRiskComputeSize: SizingFn = ({ entry, sl, spec }) => computeFixedRiskPositionSize({ entry, sl, spec });

// Runs ONE random-timing trial through backtestEngine.ts's real
// runScenario - not a reimplementation of the walk, the literal same
// function real scenarios use - so one-position-at-a-time and the engine's
// fill/cost model are structurally identical to the real backtest. Fee=0/
// slippage=0/funding=0 so the comparison is apples to apples with the real
// system's own gross (pre-cost) numbers.
export function runRandomTimingTrial(
  segments: readonly Candle[][],
  eligiblePool: EligibleAnchor[],
  sides: RealSideCounts,
  spec: InstrumentSpec,
  rng: () => number,
  firstTs: number,
  lastTs: number,
  startingEquityUsdt: number,
): TimingPermutationTrialResult {
  const { prepared, anchorsAttempted, anchorsValid } = buildRandomTimingTrial(segments, eligiblePool, sides, spec, rng, firstTs, lastTs);

  const config: BacktestConfig = {
    startingEquityUsdt,
    slippageTicks: 0,
    ambiguousBound: "lower",
    feeModel: "limit-tp",
    takerFeeRate: 0,
    makerFeeRate: 0,
    fundingRateForCost: null,
    computeSize: fixedRiskComputeSize,
  };

  const run = runScenario(prepared, spec, config);
  const n = run.trades.length;
  const wins = run.trades.filter((t) => t.netPnlUsdt > 0).length; // fee=0 -> net === gross
  return {
    n,
    wins,
    winRate: n > 0 ? wins / n : NaN,
    expectancyR: n > 0 ? run.trades.reduce((s, t) => s + t.rMultiple, 0) / n : NaN,
    anchorsAttempted,
    anchorsValid,
  };
}

export function runRandomTimingTrials(
  prepared: PreparedData,
  spec: InstrumentSpec,
  startingEquityUsdt: number,
  trialCount: number,
  seed: number,
): TimingPermutationTrialResult[] {
  const eligiblePool = eligibleAnchors(prepared.segments);
  const sides = countRealSides(prepared.signalsBySegment);
  const rng = mulberry32(seed);
  const trials: TimingPermutationTrialResult[] = [];
  for (let i = 0; i < trialCount; i++) {
    trials.push(
      runRandomTimingTrial(prepared.segments, eligiblePool, sides, spec, rng, prepared.firstTs, prepared.lastTs, startingEquityUsdt),
    );
  }
  return trials;
}

// Below this validity rate, too many random anchors are being dropped as
// degenerate for the null to be trusted as "the same number of trades as
// the real system, just at random moments" - the exact failure mode found
// in the direction-flip null this file replaced. A caller whose measured
// rate falls under this must stop and report it, not draw a percentile
// conclusion from a null that silently trades far fewer signals than
// intended.
export const ANCHOR_VALIDITY_MIN_PCT = 90;

export interface AnchorValiditySummary {
  attempted: number;
  valid: number;
  pct: number;
}

export function aggregateAnchorValidity(trials: readonly TimingPermutationTrialResult[]): AnchorValiditySummary {
  const attempted = sum(trials.map((t) => t.anchorsAttempted));
  const valid = sum(trials.map((t) => t.anchorsValid));
  return { attempted, valid, pct: attempted > 0 ? (valid / attempted) * 100 : NaN };
}

// Fraction of `sample` at or below `value`, as a percentile (0-100). Used
// to place the real system's win rate/expectancy within the random
// distribution.
export function percentileRankOf(value: number, sample: readonly number[]): number {
  if (sample.length === 0) return NaN;
  const countAtOrBelow = sample.filter((s) => s <= value).length;
  return (countAtOrBelow / sample.length) * 100;
}
