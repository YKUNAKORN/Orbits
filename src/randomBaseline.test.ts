import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle, Signal } from "./types.js";
import type { InstrumentSpec } from "./instrumentSpec.js";
import type { PreparedData } from "./backtestEngine.js";
import { SIGNAL_MIN_WARMUP_BARS } from "./signal.js";
import {
  aggregateAnchorValidity,
  buildRandomTimingTrial,
  countRealSides,
  eligibleAnchors,
  mulberry32,
  percentileRankOf,
  runRandomTimingTrials,
  sampleWithoutReplacement,
  type EligibleAnchor,
  type RealSideCounts,
  type TimingPermutationTrialResult,
} from "./randomBaseline.js";

const STEP = 300_000; // 5m
const TICK = "0.0001";

const SPEC: InstrumentSpec = {
  instId: "TEST-SWAP",
  ctVal: 1,
  ctValCcy: "TEST",
  tickSz: TICK,
  lotSz: "1",
  minSz: 1,
  lever: 50,
};

function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

// --- eligibleAnchors / countRealSides ------------------------------------

function flat(i: number): Candle {
  return { ts: i * STEP, open: 10, high: 10, low: 10, close: 10, volume: 1 };
}

test("eligibleAnchors starts at SIGNAL_MIN_WARMUP_BARS-1 within each segment, and a too-short segment contributes none", () => {
  const tooShort: Candle[] = Array.from({ length: SIGNAL_MIN_WARMUP_BARS - 1 }, (_, i) => flat(i));
  const justEnough: Candle[] = Array.from({ length: SIGNAL_MIN_WARMUP_BARS + 5 }, (_, i) => flat(i)); // eligible: 499..504

  const anchors = eligibleAnchors([tooShort, justEnough]);

  assert.ok(anchors.every((a) => a.segmentIndex === 1), "the too-short first segment must contribute zero anchors");
  assert.equal(anchors.length, 6);
  assert.equal(anchors[0]?.barIndex, SIGNAL_MIN_WARMUP_BARS - 1);
  assert.equal(anchors[anchors.length - 1]?.barIndex, SIGNAL_MIN_WARMUP_BARS + 4);
});

test("countRealSides tallies long/short across every segment", () => {
  const sig = (side: "long" | "short"): Signal => ({ side, time: 0, entry: 10, sl: 9, tp: 12 });
  const counts = countRealSides([[sig("long"), sig("short"), sig("long")], [sig("short")]]);
  assert.deepEqual(counts, { longCount: 2, shortCount: 2 });
});

// --- sampleWithoutReplacement ---------------------------------------------

test("sampleWithoutReplacement draws distinct elements from the pool and restores it afterward", () => {
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const original = [...pool];
  const chosen = sampleWithoutReplacement(pool, 4, mulberry32(7));

  assert.equal(chosen.length, 4);
  assert.equal(new Set(chosen).size, 4, "must not repeat an element");
  for (const v of chosen) assert.ok(original.includes(v));
  assert.deepEqual(pool, original, "the backing pool must be restored, not left shuffled");
});

test("sampleWithoutReplacement is deterministic for a given seed and rejects drawing more than the pool holds", () => {
  const a = sampleWithoutReplacement([0, 1, 2, 3, 4], 3, mulberry32(99));
  const b = sampleWithoutReplacement([0, 1, 2, 3, 4], 3, mulberry32(99));
  assert.deepEqual(a, b);
  assert.throws(() => sampleWithoutReplacement([0, 1], 3, mulberry32(1)));
});

// --- buildRandomTimingTrial: degeneracy exclusion -------------------------
//
// One long flat segment with three widely-spaced bar0 positions, each with
// a hand-crafted bar2 (index-2) controlling long/short degeneracy at that
// exact anchor - the same anchor A/B/C construction the old
// buildDirectionalVariants test used, relocated to positions a random-timing
// draw could actually land on (bar0 stays flat, entry=10, everywhere).

const ANCHOR_BOTH_VALID = 10; // bar2 (index 8): low=9.9 (long ok), high=10.1 (short ok)
const ANCHOR_LONG_ONLY = 20; // bar2 (index 18): low=9.5 (long ok), high=9.9 (short degenerate: sl<=entry)
const ANCHOR_SHORT_ONLY = 30; // bar2 (index 28): low=10.5 (long degenerate: sl>=entry), high=10.9 (short ok)

function buildDegeneracyFixtureSegment(): Candle[] {
  const segment: Candle[] = Array.from({ length: 31 }, (_, i) => flat(i));
  segment[ANCHOR_BOTH_VALID - 2] = { ts: (ANCHOR_BOTH_VALID - 2) * STEP, open: 10, high: 10.1, low: 9.9, close: 10, volume: 1 };
  segment[ANCHOR_LONG_ONLY - 2] = { ts: (ANCHOR_LONG_ONLY - 2) * STEP, open: 9.7, high: 9.9, low: 9.5, close: 9.7, volume: 1 };
  segment[ANCHOR_SHORT_ONLY - 2] = { ts: (ANCHOR_SHORT_ONLY - 2) * STEP, open: 10.7, high: 10.9, low: 10.5, close: 10.7, volume: 1 };
  return segment;
}

function poolFor(...barIndexes: number[]): EligibleAnchor[] {
  return barIndexes.map((barIndex) => ({ segmentIndex: 0, barIndex }));
}

test("buildRandomTimingTrial: assigning every anchor 'short' excludes the long-only anchor", () => {
  const segment = buildDegeneracyFixtureSegment();
  const pool = poolFor(ANCHOR_BOTH_VALID, ANCHOR_LONG_ONLY, ANCHOR_SHORT_ONLY);
  const sides: RealSideCounts = { longCount: 0, shortCount: 3 }; // single-valued multiset: shuffle order can't matter
  const firstTs = segment[0]!.ts;
  const lastTs = segment[segment.length - 1]!.ts;

  const result = buildRandomTimingTrial([segment], pool, sides, SPEC, mulberry32(42), firstTs, lastTs);

  assert.equal(result.anchorsAttempted, 3);
  assert.equal(result.anchorsValid, 2);
  const signals = result.prepared.signalsBySegment[0]!;
  assert.equal(signals.length, 2);
  assert.deepEqual(
    signals.map((s) => s.time).sort((a, b) => a - b),
    [ANCHOR_BOTH_VALID * STEP, ANCHOR_SHORT_ONLY * STEP],
  );
  for (const s of signals) assert.equal(s.side, "short");

  const both = signals.find((s) => s.time === ANCHOR_BOTH_VALID * STEP)!;
  assertClose(both.sl, 10.1);
  assertClose(both.tp, 9.8); // 10 - 2*(10.1-10)
  const shortOnly = signals.find((s) => s.time === ANCHOR_SHORT_ONLY * STEP)!;
  assertClose(shortOnly.sl, 10.9);
  assertClose(shortOnly.tp, 8.2); // 10 - 2*(10.9-10)
});

test("buildRandomTimingTrial: assigning every anchor 'long' excludes the short-only anchor", () => {
  const segment = buildDegeneracyFixtureSegment();
  const pool = poolFor(ANCHOR_BOTH_VALID, ANCHOR_LONG_ONLY, ANCHOR_SHORT_ONLY);
  const sides: RealSideCounts = { longCount: 3, shortCount: 0 };
  const firstTs = segment[0]!.ts;
  const lastTs = segment[segment.length - 1]!.ts;

  const result = buildRandomTimingTrial([segment], pool, sides, SPEC, mulberry32(2024), firstTs, lastTs);

  assert.equal(result.anchorsAttempted, 3);
  assert.equal(result.anchorsValid, 2);
  const signals = result.prepared.signalsBySegment[0]!;
  assert.deepEqual(
    signals.map((s) => s.time).sort((a, b) => a - b),
    [ANCHOR_BOTH_VALID * STEP, ANCHOR_LONG_ONLY * STEP],
  );
  for (const s of signals) assert.equal(s.side, "long");

  const both = signals.find((s) => s.time === ANCHOR_BOTH_VALID * STEP)!;
  assertClose(both.sl, 9.9);
  assertClose(both.tp, 10.2); // 10 + 2*(10-9.9)
  const longOnly = signals.find((s) => s.time === ANCHOR_LONG_ONLY * STEP)!;
  assertClose(longOnly.sl, 9.5);
  assertClose(longOnly.tp, 11); // 10 + 2*(10-9.5)
});

test("buildRandomTimingTrial: whatever side assignment the shuffle produces, every emitted signal matches the frozen formula and was non-degenerate", () => {
  const segment = buildDegeneracyFixtureSegment();
  const anchors = [ANCHOR_BOTH_VALID, ANCHOR_LONG_ONLY, ANCHOR_SHORT_ONLY];
  const pool = poolFor(...anchors);
  const sides: RealSideCounts = { longCount: 1, shortCount: 2 };
  const firstTs = segment[0]!.ts;
  const lastTs = segment[segment.length - 1]!.ts;

  const result = buildRandomTimingTrial([segment], pool, sides, SPEC, mulberry32(31337), firstTs, lastTs);
  const signals = result.prepared.signalsBySegment[0]!;
  assert.equal(signals.length, result.anchorsValid);
  assert.equal(result.anchorsAttempted, 3);

  for (const barIndex of anchors) {
    const bar0 = segment[barIndex]!;
    const bar2 = segment[barIndex - 2]!;
    const emitted = signals.find((s) => s.time === bar0.ts);
    if (emitted === undefined) continue; // this anchor's assigned side must have been degenerate here
    if (emitted.side === "long") {
      assert.ok(bar2.low < bar0.close, "an emitted long must not be degenerate");
      assertClose(emitted.sl, bar2.low);
      assertClose(emitted.tp, bar0.close + 2 * (bar0.close - bar2.low));
    } else {
      assert.ok(bar2.high > bar0.close, "an emitted short must not be degenerate");
      assertClose(emitted.sl, bar2.high);
      assertClose(emitted.tp, bar0.close - 2 * (bar2.high - bar0.close));
    }
  }
});

// --- runRandomTimingTrials: integration with the real engine --------------
//
// Every candle identical (open=9.99, high=10.01, low=9.99, close=10), so
// bar2.low(9.9 9) < entry(10) < bar2.high(10.01) holds at EVERY position -
// anchor validity is 100% by construction, regardless of which side a trial
// assigns. This isolates the sampling/trial machinery from the degeneracy
// question already covered above.

function alwaysValidCandle(i: number): Candle {
  return { ts: i * STEP, open: 9.99, high: 10.01, low: 9.99, close: 10, volume: 1 };
}

function bigPreparedFixture(extraBars = 40): PreparedData {
  const length = SIGNAL_MIN_WARMUP_BARS + extraBars;
  const segment: Candle[] = Array.from({ length }, (_, i) => alwaysValidCandle(i));
  const fakeSignals: Signal[] = [
    { side: "long", time: 0, entry: 0, sl: 0, tp: 0 },
    { side: "long", time: 0, entry: 0, sl: 0, tp: 0 },
    { side: "short", time: 0, entry: 0, sl: 0, tp: 0 },
  ]; // only .side is read by countRealSides - other fields are placeholders
  return {
    segments: [segment],
    signalsBySegment: [fakeSignals],
    naturalResolutionsBySegment: [[]],
    totalSignalCount: fakeSignals.length,
    firstTs: segment[0]!.ts,
    lastTs: segment[length - 1]!.ts,
  };
}

test("runRandomTimingTrials: anchor validity is 100% when every position is geometrically valid both ways", () => {
  const prepared = bigPreparedFixture();
  const trialCount = 25;
  const trials = runRandomTimingTrials(prepared, SPEC, 100, trialCount, 777);

  for (const t of trials) {
    assert.equal(t.anchorsAttempted, 3); // matches the fixture's real long+short count
    assert.equal(t.anchorsValid, 3);
    assert.ok(t.n <= t.anchorsValid, "the one-position rule can only reduce trade count below valid anchors, never raise it");
  }

  const validity = aggregateAnchorValidity(trials);
  assert.equal(validity.attempted, trialCount * 3);
  assert.equal(validity.valid, trialCount * 3);
  assertClose(validity.pct, 100);
});

test("runRandomTimingTrials is deterministic for a given seed and varies across seeds", () => {
  const prepared = bigPreparedFixture();
  const trialsA = runRandomTimingTrials(prepared, SPEC, 100, 15, 555);
  const trialsB = runRandomTimingTrials(prepared, SPEC, 100, 15, 555);
  assert.deepEqual(trialsA, trialsB);

  const trialsC = runRandomTimingTrials(prepared, SPEC, 100, 15, 556);
  assert.notDeepEqual(trialsA, trialsC);
});

// --- aggregateAnchorValidity -----------------------------------------------

test("aggregateAnchorValidity sums attempted/valid across trials and computes a percentage", () => {
  const trials: TimingPermutationTrialResult[] = [
    { n: 2, wins: 1, winRate: 0.5, expectancyR: 0.1, anchorsAttempted: 10, anchorsValid: 9 },
    { n: 1, wins: 0, winRate: 0, expectancyR: -1, anchorsAttempted: 10, anchorsValid: 10 },
  ];
  const result = aggregateAnchorValidity(trials);
  assert.equal(result.attempted, 20);
  assert.equal(result.valid, 19);
  assertClose(result.pct, 95);
});

test("aggregateAnchorValidity on an empty trial list degrades to NaN rather than dividing by zero", () => {
  const result = aggregateAnchorValidity([]);
  assert.equal(result.attempted, 0);
  assert.equal(result.valid, 0);
  assert.ok(Number.isNaN(result.pct));
});

// --- shared utilities (unchanged from the previous direction-based null) --

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

test("percentileRankOf places a value correctly within a sample, and handles the empty-sample edge case", () => {
  const sample = [0.1, 0.2, 0.3, 0.4, 0.5];
  assert.equal(percentileRankOf(0.0, sample), 0);
  assert.equal(percentileRankOf(0.3, sample), 60); // 3 of 5 values <= 0.3
  assert.equal(percentileRankOf(0.5, sample), 100);
  assert.equal(percentileRankOf(1.0, sample), 100);
  assert.ok(Number.isNaN(percentileRankOf(0.3, [])));
});
