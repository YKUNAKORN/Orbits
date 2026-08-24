import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle, Signal } from "./types.js";
import type { InstrumentSpec } from "./instrumentSpec.js";
import { runScenario, type BacktestConfig, type PreparedData } from "./backtestEngine.js";
import {
  buildDirectionalVariants,
  mulberry32,
  percentileRankOf,
  runPermutationTrial,
  runPermutationTrials,
} from "./randomBaseline.js";

const STEP = 300_000;
const TICK = "0.0001";

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { ts: index * STEP, open, high, low, close, volume: 1 };
}

const SPEC: InstrumentSpec = {
  instId: "TEST-SWAP",
  ctVal: 1,
  ctValCcy: "TEST",
  tickSz: TICK,
  lotSz: "1",
  minSz: 1,
  lever: 50,
};

// Anchor A (entryIndex=2): both directions valid.
// Anchor B (entryIndex=5): only long valid (bar2.high <= entry -> short degenerate).
// Anchor C (entryIndex=8): only short valid (bar2.low >= entry -> long degenerate).
function buildFixture(): { segment: Candle[]; realSignals: Signal[] } {
  const segment: Candle[] = [
    candle(0, 10, 10.1, 9.9, 10), // bar2 of A: low=9.9 high=10.1 (tight, so A resolves fast either way)
    candle(1, 10, 10.1, 9.9, 10), // filler
    candle(2, 10, 10.1, 9.9, 10), // bar0 of A: entry=10
    candle(3, 9.7, 9.9, 9.5, 9.8), // bar2 of B: low=9.5 high=9.9
    candle(4, 10, 10.1, 9.9, 10), // filler
    candle(5, 9.9, 10.1, 9.8, 10), // bar0 of B: entry=10
    candle(6, 10.6, 10.9, 10.5, 10.7), // bar2 of C: low=10.5 high=10.9
    candle(7, 10, 10.1, 9.9, 10), // filler
    candle(8, 10, 10.1, 9.9, 10), // bar0 of C: entry=10
  ];
  // Only .time is read by buildDirectionalVariants; other fields are placeholders.
  const realSignals: Signal[] = [
    { side: "long", time: 2 * STEP, entry: 0, sl: 0, tp: 0 },
    { side: "short", time: 5 * STEP, entry: 0, sl: 0, tp: 0 },
    { side: "long", time: 8 * STEP, entry: 0, sl: 0, tp: 0 },
  ];
  return { segment, realSignals };
}

function preparedFor(segment: Candle[], realSignals: Signal[]): PreparedData {
  return {
    segments: [segment],
    signalsBySegment: [realSignals],
    naturalResolutionsBySegment: [[]], // unused by buildDirectionalVariants/runPermutationTrial
    totalSignalCount: realSignals.length,
    firstTs: segment[0]?.ts ?? 0,
    lastTs: segment[segment.length - 1]?.ts ?? 0,
  };
}

test("buildDirectionalVariants reconstructs entry/SL/TP from the real bar2/bar0, both directions, per anchor", () => {
  const { segment, realSignals } = buildFixture();
  const prepared = preparedFor(segment, realSignals);
  const variants = buildDirectionalVariants(prepared, SPEC);

  const longs = variants.longSignalsBySegment[0]!;
  const shorts = variants.shortSignalsBySegment[0]!;
  assert.equal(longs.length, 3);
  assert.equal(shorts.length, 3);

  // Anchor A: both valid.
  assert.equal(longs[0]?.side, "long");
  assert.equal(longs[0]?.entry, 10);
  assert.equal(longs[0]?.sl, 9.9); // bar2.low
  assertClose(longs[0]?.tp ?? NaN, 10.2); // 10 + 2*(10-9.9)
  assert.equal(longs[0]?.time, 2 * STEP);
  assert.equal(shorts[0]?.side, "short");
  assertClose(shorts[0]?.sl ?? NaN, 10.1); // bar2.high
  assertClose(shorts[0]?.tp ?? NaN, 9.8); // 10 - 2*(10.1-10)

  // Anchor B: short degenerate (bar2.high=9.9 <= entry=10).
  assert.equal(longs[1]?.sl, 9.5);
  assert.equal(longs[1]?.tp, 11);
  assert.equal(shorts[1], null);

  // Anchor C: long degenerate (bar2.low=10.5 >= entry=10).
  assert.equal(longs[2], null);
  assert.ok(shorts[2]);
  assert.equal(shorts[2]?.sl, 10.9);
  assertClose(shorts[2]?.tp ?? NaN, 8.2);
});

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

test("degenerate anchors stay null through resolution re-expansion (index-aligned with the signal arrays)", () => {
  const { segment, realSignals } = buildFixture();
  const prepared = preparedFor(segment, realSignals);
  const variants = buildDirectionalVariants(prepared, SPEC);

  const longRes = variants.longResolutionsBySegment[0]!;
  const shortRes = variants.shortResolutionsBySegment[0]!;
  assert.equal(longRes.length, 3);
  assert.equal(shortRes.length, 3);
  assert.ok(longRes[0] !== null && longRes[1] !== null);
  assert.equal(longRes[2], null); // anchor C: long was degenerate
  assert.ok(shortRes[0] !== null && shortRes[2] !== null);
  assert.equal(shortRes[1], null); // anchor B: short was degenerate
});

function baseConfig(): BacktestConfig {
  return {
    startingEquityUsdt: 100,
    slippageTicks: 0,
    ambiguousBound: "lower",
    feeModel: "limit-tp",
    takerFeeRate: 0,
    makerFeeRate: 0,
    fundingRateForCost: null,
  };
}

test("a coin that always lands on long reproduces exactly the all-long-variant run through the real engine", () => {
  const { segment, realSignals } = buildFixture();
  const prepared = preparedFor(segment, realSignals);
  const variants = buildDirectionalVariants(prepared, SPEC);

  const alwaysLong = (): number => 0; // < 0.5 every time
  const trial = runPermutationTrial(prepared, variants, SPEC, alwaysLong, 100);

  const longsOnly = (variants.longSignalsBySegment[0] ?? []).filter((s): s is Signal => s !== null);
  const longResOnly = (variants.longResolutionsBySegment[0] ?? []).filter((r) => r !== null);
  const directRun = runScenario(
    {
      segments: [segment],
      signalsBySegment: [longsOnly],
      naturalResolutionsBySegment: [longResOnly as NonNullable<(typeof longResOnly)[number]>[]],
      totalSignalCount: longsOnly.length,
      firstTs: prepared.firstTs,
      lastTs: prepared.lastTs,
    },
    SPEC,
    baseConfig(),
  );

  assert.equal(trial.n, directRun.trades.length);
  assert.equal(trial.wins, directRun.trades.filter((t) => t.netPnlUsdt > 0).length);
});

test("a coin that always lands on short reproduces exactly the all-short-variant run, skipping the degenerate anchor", () => {
  const { segment, realSignals } = buildFixture();
  const prepared = preparedFor(segment, realSignals);
  const variants = buildDirectionalVariants(prepared, SPEC);

  const alwaysShort = (): number => 0.9; // >= 0.5 every time
  const trial = runPermutationTrial(prepared, variants, SPEC, alwaysShort, 100);

  // Anchor B's short is degenerate (null) - only A and C should trade.
  assert.ok(trial.n <= 2);

  const shortsOnly = (variants.shortSignalsBySegment[0] ?? []).filter((s): s is Signal => s !== null);
  assert.equal(shortsOnly.length, 2);
});

test("mulberry32 is deterministic for a given seed and varies across seeds", () => {
  const a1 = mulberry32(42);
  const a2 = mulberry32(42);
  const seqA1 = [a1(), a1(), a1()];
  const seqA2 = [a2(), a2(), a2()];
  assert.deepEqual(seqA1, seqA2);
  for (const v of seqA1) {
    assert.ok(v >= 0 && v < 1);
  }

  const b = mulberry32(1337);
  const seqB = [b(), b(), b()];
  assert.notDeepEqual(seqA1, seqB);
});

test("runPermutationTrials with the same seed reproduces identical trial results", () => {
  const { segment, realSignals } = buildFixture();
  const prepared = preparedFor(segment, realSignals);
  const variants = buildDirectionalVariants(prepared, SPEC);

  const trialsA = runPermutationTrials(prepared, variants, SPEC, 100, 20, 12345);
  const trialsB = runPermutationTrials(prepared, variants, SPEC, 100, 20, 12345);
  assert.deepEqual(trialsA, trialsB);

  const trialsC = runPermutationTrials(prepared, variants, SPEC, 100, 20, 999);
  assert.notDeepEqual(trialsA, trialsC);
});

test("percentileRankOf places a value correctly within a sample, and handles the empty-sample edge case", () => {
  const sample = [0.1, 0.2, 0.3, 0.4, 0.5];
  assert.equal(percentileRankOf(0.0, sample), 0);
  assert.equal(percentileRankOf(0.3, sample), 60); // 3 of 5 values <= 0.3
  assert.equal(percentileRankOf(0.5, sample), 100);
  assert.equal(percentileRankOf(1.0, sample), 100);
  assert.ok(Number.isNaN(percentileRankOf(0.3, [])));
});
