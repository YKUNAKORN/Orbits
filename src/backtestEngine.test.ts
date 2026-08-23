import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle, Signal } from "./types.js";
import type { InstrumentSpec } from "./instrumentSpec.js";
import {
  computeNaturalResolutions,
  computeMetrics,
  computeSplitTs,
  runScenario,
  splitMetrics,
  type BacktestConfig,
  type ClosedTrade,
  type PreparedData,
  type RunResult,
} from "./backtestEngine.js";

const STEP = 300_000; // 5m
const TICK = "0.1";

function assertClose(actual: number, expected: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { ts: index * STEP, open, high, low, close, volume: 1 };
}

function longSignal(entryIndex: number, entry: number, sl: number, tp: number): Signal {
  return { side: "long", time: entryIndex * STEP, entry, sl, tp };
}

function shortSignal(entryIndex: number, entry: number, sl: number, tp: number): Signal {
  return { side: "short", time: entryIndex * STEP, entry, sl, tp };
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

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    startingEquityUsdt: 100,
    slippageTicks: 0,
    ambiguousBound: "lower",
    feeModel: "limit-tp",
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    fundingRateForCost: null,
    ...overrides,
  };
}

function prepare(segment: readonly Candle[], signals: readonly Signal[]): PreparedData {
  return {
    segments: [[...segment]],
    signalsBySegment: [[...signals]],
    naturalResolutionsBySegment: [computeNaturalResolutions(segment, signals, TICK)],
    totalSignalCount: signals.length,
    firstTs: segment[0]?.ts ?? 0,
    lastTs: segment[segment.length - 1]?.ts ?? 0,
  };
}

test("long TP trade: maker fee, no exit slippage, fees included in net P&L", () => {
  const signal = longSignal(0, 10, 9.5, 11);
  const segment: Candle[] = [candle(0, 10, 10.1, 9.9, 10), candle(1, 10, 11.2, 10, 10.5)];
  const run = runScenario(prepare(segment, [signal]), SPEC, baseConfig());

  assert.equal(run.trades.length, 1);
  const t = run.trades[0] as ClosedTrade;
  assert.equal(t.contracts, 4); // riskUsdt=2, slPct=0.05 -> targetNotional=40, /entry(10) -> 4 contracts
  assert.equal(t.resolvedAs, "tp");
  assertClose(t.entryFillPrice, 10); // 0 slippage
  assertClose(t.exitFillPrice, 11); // maker: fills exactly at TP
  assertClose(t.grossPnlUsdt, 4); // (11-10)*4
  assertClose(t.feesUsdt, 40 * 0.0005 + 44 * 0.0002); // entry taker, exit maker (limit-tp model)
  assertClose(t.netPnlUsdt, 4 - (40 * 0.0005 + 44 * 0.0002));
  assertClose(t.equityAfter, 100 + t.netPnlUsdt);
  assertClose(t.actualRiskUsdt, 2);
  assertClose(t.rMultiple, t.netPnlUsdt / 2);
});

test("long SL trade: slippage worsens both entry and exit, SL exit is always taker even under limit-tp fee model", () => {
  const signal = longSignal(0, 10, 9.5, 11);
  const segment: Candle[] = [candle(0, 10, 10.1, 9.9, 10), candle(1, 10, 10.05, 9.5, 9.6)];
  const run = runScenario(prepare(segment, [signal]), SPEC, baseConfig({ slippageTicks: 2, feeModel: "limit-tp" }));

  const t = run.trades[0] as ClosedTrade;
  assert.equal(t.resolvedAs, "sl");
  assertClose(t.entryFillPrice, 10.2); // long entry slips UP (worse)
  assertClose(t.exitFillPrice, 9.3); // long SL exit slips DOWN (worse)
  assertClose(t.grossPnlUsdt, -3.6); // (9.3-10.2)*4
  assertClose(t.feesUsdt, 40.8 * 0.0005 + 37.2 * 0.0005); // taker on both legs
  assertClose(t.netPnlUsdt, -3.6 - (40.8 * 0.0005 + 37.2 * 0.0005));
  assert.ok(t.rMultiple < -1, "fees and slippage must make a full-SL loss worse than -1R");
});

test("short side: entry and SL exit slippage point the opposite direction from long", () => {
  const signal = shortSignal(0, 10, 10.5, 9);
  const segment: Candle[] = [candle(0, 10, 10.1, 9.9, 10), candle(1, 10, 10.5, 9.9, 10.2)];
  const run = runScenario(prepare(segment, [signal]), SPEC, baseConfig({ slippageTicks: 1 }));

  const t = run.trades[0] as ClosedTrade;
  assertClose(t.entryFillPrice, 9.9); // short entry slips DOWN (worse)
  assertClose(t.exitFillPrice, 10.6); // short SL exit slips UP (worse, buying back)
  assertClose(t.grossPnlUsdt, (9.9 - 10.6) * 4);
});

test("ambiguous bar: lower bound resolves as SL, upper bound resolves as TP, same exit bar either way", () => {
  const signal = longSignal(0, 10, 9.5, 11);
  const segment: Candle[] = [candle(0, 10, 10.1, 9.9, 10), candle(1, 9.4, 11.2, 9.4, 10.5)];
  const prepared = prepare(segment, [signal]);

  const lower = runScenario(prepared, SPEC, baseConfig({ ambiguousBound: "lower" }));
  const upper = runScenario(prepared, SPEC, baseConfig({ ambiguousBound: "upper" }));

  const lowerTrade = lower.trades[0] as ClosedTrade;
  const upperTrade = upper.trades[0] as ClosedTrade;
  assert.equal(lowerTrade.rawOutcome, "ambiguous");
  assert.equal(upperTrade.rawOutcome, "ambiguous");
  assert.equal(lowerTrade.resolvedAs, "sl");
  assert.equal(upperTrade.resolvedAs, "tp");
  assert.equal(lowerTrade.exitTs, upperTrade.exitTs); // same bar closes it either way
  assertClose(lowerTrade.exitFillPrice, 9.5);
  assertClose(upperTrade.exitFillPrice, 11);
});

test("all-taker fee model changes only the TP exit fee rate, not the fill price", () => {
  const signal = longSignal(0, 10, 9.5, 11);
  const segment: Candle[] = [candle(0, 10, 10.1, 9.9, 10), candle(1, 10, 11.2, 10, 10.5)];
  const prepared = prepare(segment, [signal]);

  const limitTp = runScenario(prepared, SPEC, baseConfig({ feeModel: "limit-tp" })).trades[0] as ClosedTrade;
  const allTaker = runScenario(prepared, SPEC, baseConfig({ feeModel: "all-taker" })).trades[0] as ClosedTrade;

  assertClose(limitTp.exitFillPrice, allTaker.exitFillPrice);
  assertClose(limitTp.grossPnlUsdt, allTaker.grossPnlUsdt);
  assert.ok(allTaker.feesUsdt > limitTp.feesUsdt, "taker exit fee must be higher than maker");
  assertClose(allTaker.feesUsdt - limitTp.feesUsdt, 44 * (0.0005 - 0.0002));
});

test("a signal rejected by position sizing does not block the next signal (unlike a real open position)", () => {
  // equity=1 -> both signals' target notional floors to 0 contracts (< minSz) regardless of order.
  const a = longSignal(0, 10, 9.9, 10.2);
  const b = longSignal(1, 10, 9.5, 11);
  const segment: Candle[] = [
    candle(0, 10, 10.1, 9.9, 10),
    candle(1, 10, 10.1, 9.9, 10),
    candle(2, 10, 11.2, 9.4, 10.5),
  ];
  const run = runScenario(prepare(segment, [a, b]), SPEC, baseConfig({ startingEquityUsdt: 1 }));

  assert.equal(run.trades.length, 0);
  assert.equal(run.ignoredTs.length, 0, "sizing rejection must not count as ignored-while-open");
  assert.equal(run.skippedSizingTs.length, 2);
});

test("a real open position DOES block a signal that fires before it resolves", () => {
  const a = longSignal(0, 10, 9.5, 11); // resolves at index 2
  const b = longSignal(1, 10, 9.5, 11); // fires while A is still open
  const segment: Candle[] = [
    candle(0, 10, 10.1, 9.9, 10),
    candle(1, 10, 10.1, 9.9, 10),
    candle(2, 10, 11.2, 10, 10.5),
  ];
  const run = runScenario(prepare(segment, [a, b]), SPEC, baseConfig());

  assert.equal(run.trades.length, 1);
  assert.equal(run.ignoredTs.length, 1);
  assert.equal(run.ignoredTs[0], b.time);
});

test("risk sizing compounds off current equity, not the starting equity", () => {
  const a = longSignal(0, 10, 9.5, 11); // resolves TP at index 1
  const b = longSignal(1, 10, 9.5, 11); // opens on the same bar that closes A, resolves TP at index 2
  const segment: Candle[] = [
    candle(0, 10, 10.1, 9.9, 10),
    candle(1, 10, 11.2, 10, 10),
    candle(2, 10, 11.2, 10, 10.5),
  ];
  const run = runScenario(prepare(segment, [a, b]), SPEC, baseConfig());

  assert.equal(run.trades.length, 2);
  const [first, second] = run.trades as [ClosedTrade, ClosedTrade];
  assertClose(second.equityBefore, first.equityAfter);
  assertClose(second.targetRiskUsdt, first.equityAfter * 0.02);
  assert.notEqual(second.targetRiskUsdt, first.targetRiskUsdt);
});

test("computeSplitTs divides the range at the given fraction (default 70%)", () => {
  assert.equal(computeSplitTs(0, 1000, 0.7), 700);
  assert.equal(computeSplitTs(1000, 2000), 1700);
});

function fixtureTrade(overrides: Partial<ClosedTrade>): ClosedTrade {
  return {
    side: "long",
    entryTs: 0,
    exitTs: STEP,
    rawOutcome: "tp",
    resolvedAs: "tp",
    contracts: 1,
    entryFillPrice: 10,
    exitFillPrice: 11,
    grossPnlUsdt: 1,
    feesUsdt: 0,
    fundingCrossings: 0,
    fundingUsdt: 0,
    netPnlUsdt: 1,
    targetRiskUsdt: 2,
    actualRiskUsdt: 2,
    equityBefore: 100,
    equityAfter: 101,
    rMultiple: 0.5,
    ...overrides,
  };
}

test("computeMetrics: win rate, expectancy, drawdown, streak, fee ratio, breakeven rate, top trades, monthly buckets", () => {
  const t1 = fixtureTrade({
    entryTs: Date.UTC(2024, 0, 5),
    side: "long",
    netPnlUsdt: 5,
    grossPnlUsdt: 5.5,
    feesUsdt: 0.5,
    rMultiple: 2,
    actualRiskUsdt: 2,
    targetRiskUsdt: 2,
    equityAfter: 105,
  });
  const t2 = fixtureTrade({
    entryTs: Date.UTC(2024, 0, 20),
    side: "short",
    rawOutcome: "sl",
    resolvedAs: "sl",
    netPnlUsdt: -2,
    grossPnlUsdt: -1.8,
    feesUsdt: 0.2,
    rMultiple: -1,
    actualRiskUsdt: 1.8,
    targetRiskUsdt: 2,
    equityAfter: 103,
  });
  const t3 = fixtureTrade({
    entryTs: Date.UTC(2024, 1, 5),
    side: "long",
    rawOutcome: "ambiguous",
    resolvedAs: "sl",
    netPnlUsdt: -2,
    grossPnlUsdt: -1.8,
    feesUsdt: 0.2,
    rMultiple: -1,
    actualRiskUsdt: 1.9,
    targetRiskUsdt: 2,
    equityAfter: 101,
  });
  const t4 = fixtureTrade({
    entryTs: Date.UTC(2024, 1, 20),
    side: "short",
    netPnlUsdt: 8,
    grossPnlUsdt: 8.6,
    feesUsdt: 0.6,
    rMultiple: 3,
    actualRiskUsdt: 2,
    targetRiskUsdt: 2,
    equityAfter: 109,
  });

  const metrics = computeMetrics([t1, t2, t3, t4], 100, {
    ignoredCount: 3,
    skippedSizingCount: 2,
    stillOpenCount: 1,
  });

  assert.equal(metrics.sampleSize, 4);
  assert.equal(metrics.longCount, 2);
  assert.equal(metrics.shortCount, 2);
  assert.equal(metrics.wins, 2);
  assert.equal(metrics.losses, 2);
  assertClose(metrics.winRate, 0.5);
  assertClose(metrics.expectancyR, 0.75);
  assertClose(metrics.expectancyUsdt, 2.25);
  assertClose(metrics.totalReturnPct, 9);
  assertClose(metrics.maxDrawdownPct, ((105 - 101) / 105) * 100);
  assert.equal(metrics.longestLosingStreak, 2);
  assertClose(metrics.totalFeesUsdt, 1.5);
  assertClose(metrics.grossWinningProfitUsdt, 14.1);
  assertClose(metrics.feesPctOfGrossProfit, (1.5 / 14.1) * 100);
  assertClose(metrics.breakEvenWinRate, 1 / 3.5);
  assert.equal(metrics.ambiguousCount, 1);
  assertClose(metrics.ambiguousPctOfSample, 25);
  assert.equal(metrics.ignoredCount, 3);
  assert.equal(metrics.skippedSizingCount, 2);
  assert.equal(metrics.stillOpenCount, 1);

  assert.equal(metrics.riskDistribution.n, 4);
  assertClose(metrics.riskDistribution.meanPctOfTarget, 96.25);
  assertClose(metrics.riskDistribution.minPctOfTarget, 90);
  assertClose(metrics.riskDistribution.medianPctOfTarget, 97.5);

  assert.equal(metrics.topTrades.length, 2);
  assertClose(metrics.topTrades[0]?.netPnlUsdt ?? NaN, 8);
  assertClose(metrics.topTrades[0]?.pctOfWinningProfit ?? NaN, (8 / 13) * 100);
  assertClose(metrics.topTrades[1]?.netPnlUsdt ?? NaN, 5);
  assertClose(metrics.topTrades[1]?.pctOfWinningProfit ?? NaN, (5 / 13) * 100);

  assert.equal(metrics.monthly.length, 2);
  assert.equal(metrics.monthly[0]?.month, "2024-01");
  assert.equal(metrics.monthly[0]?.trades, 2);
  assert.equal(metrics.monthly[0]?.wins, 1);
  assertClose(metrics.monthly[0]?.netPnlUsdt ?? NaN, 3);
  assert.equal(metrics.monthly[1]?.month, "2024-02");
  assertClose(metrics.monthly[1]?.netPnlUsdt ?? NaN, 6);
});

test("computeMetrics on an empty trade list degrades to NaN/zero rather than throwing", () => {
  const metrics = computeMetrics([], 100, { ignoredCount: 0, skippedSizingCount: 0, stillOpenCount: 0 });
  assert.equal(metrics.sampleSize, 0);
  assert.equal(metrics.endEquityUsdt, 100);
  assert.equal(metrics.totalReturnPct, 0);
  assert.equal(metrics.topTrades.length, 0);
  assert.equal(metrics.monthly.length, 0);
});

test("splitMetrics buckets trades by entryTs and re-bases out-of-sample equity to its own start", () => {
  const inTrade = fixtureTrade({ entryTs: 100, equityBefore: 100, equityAfter: 110, netPnlUsdt: 10 });
  const outTrade1 = fixtureTrade({ entryTs: 200, equityBefore: 110, equityAfter: 120, netPnlUsdt: 10 });
  const outTrade2 = fixtureTrade({ entryTs: 300, equityBefore: 120, equityAfter: 90, netPnlUsdt: -30 });

  const run: RunResult = {
    trades: [inTrade, outTrade1, outTrade2],
    ignoredTs: [50, 250],
    skippedSizingTs: [60],
    stillOpenTs: [350],
    finalEquityUsdt: 90,
  };

  const split = splitMetrics(run, 100, 150);

  assert.equal(split.inSample.sampleSize, 1);
  assertClose(split.inSample.startEquityUsdt, 100);
  assertClose(split.inSample.totalReturnPct, 10);
  assert.equal(split.inSample.ignoredCount, 1); // ts=50
  assert.equal(split.inSample.skippedSizingCount, 1); // ts=60
  assert.equal(split.inSample.stillOpenCount, 0);

  assert.equal(split.outOfSample.sampleSize, 2);
  assertClose(split.outOfSample.startEquityUsdt, 110); // carried over from the in-sample trade's equityAfter
  assertClose(split.outOfSample.totalReturnPct, (90 / 110 - 1) * 100);
  assert.equal(split.outOfSample.ignoredCount, 1); // ts=250
  assert.equal(split.outOfSample.stillOpenCount, 1); // ts=350
});

test("splitMetrics with no in-sample trades starts out-of-sample at the run's starting equity", () => {
  const outTrade = fixtureTrade({ entryTs: 500, equityBefore: 100, equityAfter: 105, netPnlUsdt: 5 });
  const run: RunResult = {
    trades: [outTrade],
    ignoredTs: [],
    skippedSizingTs: [],
    stillOpenTs: [],
    finalEquityUsdt: 105,
  };
  const split = splitMetrics(run, 100, 150);
  assert.equal(split.inSample.sampleSize, 0);
  assertClose(split.outOfSample.startEquityUsdt, 100);
});
