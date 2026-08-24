import { at, FIVE_MIN_MS, type Candle, type Side, type Signal } from "./types.js";
import { splitIntoContiguousSegments } from "./dataIntegrity.js";
import { generateSignals } from "./signalScan.js";
import { computePositionSize, RISK_PER_TRADE } from "./positionSizing.js";
import type { InstrumentSpec } from "./instrumentSpec.js";
import { countFundingCrossings } from "./funding.js";
import { mean, monthKey, percentile, sum } from "./stats.js";

export const DEFAULT_TAKER_FEE_RATE = 0.0005;
export const DEFAULT_MAKER_FEE_RATE = 0.0002;
export const IN_SAMPLE_FRACTION = 0.7;

export type AmbiguousBound = "lower" | "upper"; // lower = SL wins ties, upper = TP wins
export type FeeModel = "limit-tp" | "all-taker";
type NaturalOutcome = "tp" | "sl" | "ambiguous" | "open";
type ResolvedOutcome = "tp" | "sl";

export interface BacktestConfig {
  startingEquityUsdt: number;
  slippageTicks: number;
  ambiguousBound: AmbiguousBound;
  feeModel: FeeModel;
  takerFeeRate: number;
  makerFeeRate: number;
  // When set, a constant funding rate applied on every crossed 8h boundary.
  // null means funding cost is not modelled (see funding measurement in
  // backtest.ts - this is only populated if that measurement crosses the
  // 5% materiality bar backtest.ts applies before bothering to model it).
  fundingRateForCost: number | null;
}

export interface ClosedTrade {
  side: Side;
  entryTs: number;
  exitTs: number;
  rawOutcome: NaturalOutcome; // "open" never appears here - unresolved trades aren't closed trades
  resolvedAs: ResolvedOutcome;
  slPct: number; // |signal.entry - signal.sl| / signal.entry, the theoretical (pre-fill) SL distance
  contracts: number;
  entryFillPrice: number;
  exitFillPrice: number;
  grossPnlUsdt: number;
  feesUsdt: number;
  fundingCrossings: number;
  fundingUsdt: number;
  netPnlUsdt: number;
  targetRiskUsdt: number;
  actualRiskUsdt: number;
  equityBefore: number;
  equityAfter: number;
  rMultiple: number;
}

export interface RunResult {
  trades: ClosedTrade[]; // closed trades only, chronological by entryTs
  // Entry timestamps of signals that didn't become closed trades, kept (not
  // just counted) so splitMetrics can bucket them into in-sample /
  // out-of-sample the same way it buckets trades.
  ignoredTs: number[];
  skippedSizingTs: number[];
  stillOpenTs: number[];
  finalEquityUsdt: number;
}

export interface NaturalResolution {
  entryIndex: number;
  exitIndex: number | null;
  outcome: NaturalOutcome;
}

export interface PreparedData {
  segments: Candle[][];
  signalsBySegment: Signal[][];
  naturalResolutionsBySegment: NaturalResolution[][];
  totalSignalCount: number;
  firstTs: number;
  lastTs: number;
}

// For every signal in a segment, finds where it would exit if it were the
// only open position - independent of the one-position-at-a-time rule AND
// independent of position sizing/equity. This is the expensive O(bars-scanned)
// part of the engine; computing it once up front and reusing it across every
// {slippage, ambiguous-bound, fee-model} scenario avoids rescanning the
// candle series once per scenario.
//
// TP requires trading at least one tick beyond the level (a resting limit
// only tagged by a wick hasn't filled); SL triggers on mere touch. A bar
// that satisfies both in the same 5m candle is "ambiguous" - OHLC alone
// can't order intrabar events, so the caller resolves it via the
// lower/upper bound rather than guessing.
export function computeNaturalResolutions(
  segment: readonly Candle[],
  signals: readonly Signal[],
  tickSz: string,
): NaturalResolution[] {
  const tick = Number(tickSz);
  const tsToIndex = new Map<number, number>();
  segment.forEach((c, i) => tsToIndex.set(c.ts, i));

  return signals.map((signal): NaturalResolution => {
    const entryIndex = tsToIndex.get(signal.time);
    if (entryIndex === undefined) {
      throw new Error(`signal at ts=${signal.time} was not built from the segment passed alongside it`);
    }
    for (let i = entryIndex + 1; i < segment.length; i++) {
      const bar = at(segment, i);
      const hitSl = signal.side === "long" ? bar.low <= signal.sl : bar.high >= signal.sl;
      const hitTp = signal.side === "long" ? bar.high >= signal.tp + tick : bar.low <= signal.tp - tick;
      if (hitSl && hitTp) return { entryIndex, exitIndex: i, outcome: "ambiguous" };
      if (hitSl) return { entryIndex, exitIndex: i, outcome: "sl" };
      if (hitTp) return { entryIndex, exitIndex: i, outcome: "tp" };
    }
    return { entryIndex, exitIndex: null, outcome: "open" };
  });
}

export function prepareData(candles: readonly Candle[], spec: InstrumentSpec): PreparedData {
  const segments = splitIntoContiguousSegments(candles, FIVE_MIN_MS);
  const signalsBySegment = segments.map((segment) => generateSignals(segment));
  const naturalResolutionsBySegment = segments.map((segment, i) =>
    computeNaturalResolutions(segment, at(signalsBySegment, i), spec.tickSz),
  );
  const totalSignalCount = sum(signalsBySegment.map((s) => s.length));
  const first = at(candles, 0);
  const last = at(candles, candles.length - 1);
  return {
    segments,
    signalsBySegment,
    naturalResolutionsBySegment,
    totalSignalCount,
    firstTs: first.ts,
    lastTs: last.ts,
  };
}

// The chronological ts that divides the data into the first 70% (in-sample)
// and last 30% (out-of-sample), per CLAUDE.md section 5.
export function computeSplitTs(firstTs: number, lastTs: number, inSampleFraction = IN_SAMPLE_FRACTION): number {
  return firstTs + inSampleFraction * (lastTs - firstTs);
}

// Runs one full {slippage, ambiguous-bound, fee-model} scenario as a single
// stateful walk over the chronological signal list. This can't be reduced to
// "sequence once, replay fills" the way ambiguity resolution can: whether a
// signal actually opens a position depends on position sizing, which depends
// on current equity, which depends on every prior trade's realized P&L in
// *this* scenario. A signal that sizing rejects (equity too small, or the SL
// is so wide the target risk floors to under minSz) never opens a position,
// so it does not block the next signal - unlike a signal that is ignored
// because a real position is still open.
export function runScenario(prepared: PreparedData, spec: InstrumentSpec, config: BacktestConfig): RunResult {
  const trades: ClosedTrade[] = [];
  const ignoredTs: number[] = [];
  const skippedSizingTs: number[] = [];
  const stillOpenTs: number[] = [];
  let equity = config.startingEquityUsdt;
  const slippagePrice = config.slippageTicks * Number(spec.tickSz);

  for (let s = 0; s < prepared.segments.length; s++) {
    const segment = at(prepared.segments, s);
    const signals = at(prepared.signalsBySegment, s);
    const naturalResolutions = at(prepared.naturalResolutionsBySegment, s);

    let blockedUntilIndex = 0;
    let blockedForRestOfSegment = false;

    for (let k = 0; k < signals.length; k++) {
      const signal = at(signals, k);
      const natural = at(naturalResolutions, k);

      if (blockedForRestOfSegment) {
        ignoredTs.push(signal.time);
        continue;
      }
      if (natural.entryIndex < blockedUntilIndex) {
        ignoredTs.push(signal.time);
        continue;
      }

      const sizing = computePositionSize({ equityUsdt: equity, entry: signal.entry, sl: signal.sl, spec });
      if (sizing === null) {
        skippedSizingTs.push(signal.time);
        continue; // no position opened - does not block the next signal
      }

      if (natural.outcome === "open" || natural.exitIndex === null) {
        stillOpenTs.push(signal.time);
        blockedForRestOfSegment = true; // ran out of segment before resolving; no P&L booked
        continue;
      }

      const resolvedAs: ResolvedOutcome =
        natural.outcome === "ambiguous" ? (config.ambiguousBound === "lower" ? "sl" : "tp") : natural.outcome;

      const entryFillPrice = signal.side === "long" ? signal.entry + slippagePrice : signal.entry - slippagePrice;

      let exitFillPrice: number;
      let exitFeeRate: number;
      if (resolvedAs === "tp") {
        exitFillPrice = signal.tp; // resting maker limit: fills exactly at TP, no slippage
        exitFeeRate = config.feeModel === "limit-tp" ? config.makerFeeRate : config.takerFeeRate;
      } else {
        exitFillPrice = signal.side === "long" ? signal.sl - slippagePrice : signal.sl + slippagePrice;
        exitFeeRate = config.takerFeeRate; // SL is always market-on-trigger
      }

      const contracts = sizing.contracts;
      const notionalEntry = contracts * spec.ctVal * entryFillPrice;
      const notionalExit = contracts * spec.ctVal * exitFillPrice;
      const grossPnlUsdt =
        signal.side === "long"
          ? (exitFillPrice - entryFillPrice) * contracts * spec.ctVal
          : (entryFillPrice - exitFillPrice) * contracts * spec.ctVal;
      const feesUsdt = notionalEntry * config.takerFeeRate + notionalExit * exitFeeRate;

      const exitTs = at(segment, natural.exitIndex).ts;
      const fundingCrossings = countFundingCrossings(signal.time, exitTs);
      const fundingUsdt =
        config.fundingRateForCost === null
          ? 0
          : fundingCrossings * notionalEntry * config.fundingRateForCost * (signal.side === "long" ? 1 : -1);

      const netPnlUsdt = grossPnlUsdt - feesUsdt - fundingUsdt;
      const equityBefore = equity;
      equity += netPnlUsdt;

      trades.push({
        side: signal.side,
        entryTs: signal.time,
        exitTs,
        rawOutcome: natural.outcome,
        resolvedAs,
        slPct: Math.abs(signal.entry - signal.sl) / signal.entry,
        contracts,
        entryFillPrice,
        exitFillPrice,
        grossPnlUsdt,
        feesUsdt,
        fundingCrossings,
        fundingUsdt,
        netPnlUsdt,
        targetRiskUsdt: equityBefore * RISK_PER_TRADE,
        actualRiskUsdt: sizing.actualRiskUsdt,
        equityBefore,
        equityAfter: equity,
        rMultiple: netPnlUsdt / sizing.actualRiskUsdt,
      });

      blockedUntilIndex = natural.exitIndex;
    }
  }

  return { trades, ignoredTs, skippedSizingTs, stillOpenTs, finalEquityUsdt: equity };
}

// --- Metrics ---

export interface RiskDistributionStats {
  n: number;
  meanPctOfTarget: number;
  minPctOfTarget: number;
  p10PctOfTarget: number;
  medianPctOfTarget: number;
  p90PctOfTarget: number;
}

export interface MonthlyBucket {
  month: string;
  trades: number;
  wins: number;
  netPnlUsdt: number;
}

export interface TopTrade {
  entryTs: number;
  side: Side;
  netPnlUsdt: number;
  pctOfWinningProfit: number;
}

export interface Metrics {
  sampleSize: number;
  longCount: number;
  shortCount: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyR: number;
  expectancyUsdt: number;
  startEquityUsdt: number;
  endEquityUsdt: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  longestLosingStreak: number;
  totalFeesUsdt: number;
  grossWinningProfitUsdt: number;
  feesPctOfGrossProfit: number;
  breakEvenWinRate: number;
  totalFundingUsdt: number;
  ambiguousCount: number;
  ambiguousPctOfSample: number;
  riskDistribution: RiskDistributionStats;
  monthly: MonthlyBucket[];
  topTrades: TopTrade[];
  ignoredCount: number;
  skippedSizingCount: number;
  stillOpenCount: number;
}

function maxDrawdownPct(equityPoints: readonly number[]): number {
  if (equityPoints.length === 0) return NaN;
  let peak = at(equityPoints, 0);
  let maxDd = 0;
  for (const e of equityPoints) {
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

function longestLosingStreak(trades: readonly ClosedTrade[]): number {
  let longest = 0;
  let current = 0;
  for (const t of trades) {
    if (t.netPnlUsdt < 0) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function computeMetrics(
  trades: readonly ClosedTrade[],
  startEquityUsdt: number,
  context: { ignoredCount: number; skippedSizingCount: number; stillOpenCount: number },
): Metrics {
  const n = trades.length;
  const endEquityUsdt = n > 0 ? at(trades, n - 1).equityAfter : startEquityUsdt;
  const wins = trades.filter((t) => t.netPnlUsdt > 0);
  const losses = trades.filter((t) => t.netPnlUsdt <= 0);

  const winRs = wins.map((t) => t.rMultiple);
  const lossRs = losses.map((t) => t.rMultiple);
  const avgWinR = mean(winRs);
  const avgLossR = mean(lossRs); // negative
  const breakEvenWinRate = wins.length > 0 && losses.length > 0 ? -avgLossR / (avgWinR - avgLossR) : NaN;

  const grossWinningProfitUsdt = sum(trades.filter((t) => t.grossPnlUsdt > 0).map((t) => t.grossPnlUsdt));
  const totalFeesUsdt = sum(trades.map((t) => t.feesUsdt));

  const riskPct = trades.map((t) => (t.actualRiskUsdt / t.targetRiskUsdt) * 100).sort((a, b) => a - b);

  const byMonth = new Map<string, { trades: number; wins: number; netPnlUsdt: number }>();
  for (const t of trades) {
    const key = monthKey(t.entryTs);
    const bucket = byMonth.get(key) ?? { trades: 0, wins: 0, netPnlUsdt: 0 };
    bucket.trades += 1;
    if (t.netPnlUsdt > 0) bucket.wins += 1;
    bucket.netPnlUsdt += t.netPnlUsdt;
    byMonth.set(key, bucket);
  }
  const monthly: MonthlyBucket[] = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, v]) => ({ month, ...v }));

  const totalWinningNetProfitUsdt = sum(wins.map((t) => t.netPnlUsdt));
  const topTrades: TopTrade[] = [...wins]
    .sort((a, b) => b.netPnlUsdt - a.netPnlUsdt)
    .slice(0, 5)
    .map((t) => ({
      entryTs: t.entryTs,
      side: t.side,
      netPnlUsdt: t.netPnlUsdt,
      pctOfWinningProfit: totalWinningNetProfitUsdt > 0 ? (t.netPnlUsdt / totalWinningNetProfitUsdt) * 100 : NaN,
    }));

  const ambiguousCount = trades.filter((t) => t.rawOutcome === "ambiguous").length;

  return {
    sampleSize: n,
    longCount: trades.filter((t) => t.side === "long").length,
    shortCount: trades.filter((t) => t.side === "short").length,
    wins: wins.length,
    losses: losses.length,
    winRate: n > 0 ? wins.length / n : NaN,
    expectancyR: mean(trades.map((t) => t.rMultiple)),
    expectancyUsdt: mean(trades.map((t) => t.netPnlUsdt)),
    startEquityUsdt,
    endEquityUsdt,
    totalReturnPct: (endEquityUsdt / startEquityUsdt - 1) * 100,
    maxDrawdownPct: maxDrawdownPct([startEquityUsdt, ...trades.map((t) => t.equityAfter)]),
    longestLosingStreak: longestLosingStreak(trades),
    totalFeesUsdt,
    grossWinningProfitUsdt,
    feesPctOfGrossProfit: grossWinningProfitUsdt > 0 ? (totalFeesUsdt / grossWinningProfitUsdt) * 100 : NaN,
    breakEvenWinRate,
    totalFundingUsdt: sum(trades.map((t) => t.fundingUsdt)),
    ambiguousCount,
    ambiguousPctOfSample: n > 0 ? (ambiguousCount / n) * 100 : NaN,
    riskDistribution: {
      n: riskPct.length,
      meanPctOfTarget: mean(riskPct),
      minPctOfTarget: riskPct.length > 0 ? at(riskPct, 0) : NaN,
      p10PctOfTarget: percentile(riskPct, 10),
      medianPctOfTarget: percentile(riskPct, 50),
      p90PctOfTarget: percentile(riskPct, 90),
    },
    monthly,
    topTrades,
    ignoredCount: context.ignoredCount,
    skippedSizingCount: context.skippedSizingCount,
    stillOpenCount: context.stillOpenCount,
  };
}

export interface SplitMetrics {
  inSample: Metrics;
  outOfSample: Metrics;
}

// Buckets a single continuous run's trades by entry ts relative to splitTs.
// In-sample metrics use the run's own starting equity, since (by
// construction) only in-sample trades have occurred by the split point.
// Out-of-sample metrics are re-based to ITS OWN starting equity (whatever
// compounding left after in-sample), so its return%/drawdown% measure
// out-of-sample performance on its own terms rather than being swamped by
// in-sample compounding.
function countBefore(timestamps: readonly number[], splitTs: number): number {
  return timestamps.filter((ts) => ts < splitTs).length;
}

function countAtOrAfter(timestamps: readonly number[], splitTs: number): number {
  return timestamps.filter((ts) => ts >= splitTs).length;
}

export function splitMetrics(run: RunResult, startEquityUsdt: number, splitTs: number): SplitMetrics {
  const inSampleTrades = run.trades.filter((t) => t.entryTs < splitTs);
  const outOfSampleTrades = run.trades.filter((t) => t.entryTs >= splitTs);
  const outOfSampleStartEquity =
    inSampleTrades.length > 0 ? at(inSampleTrades, inSampleTrades.length - 1).equityAfter : startEquityUsdt;

  return {
    inSample: computeMetrics(inSampleTrades, startEquityUsdt, {
      ignoredCount: countBefore(run.ignoredTs, splitTs),
      skippedSizingCount: countBefore(run.skippedSizingTs, splitTs),
      stillOpenCount: countBefore(run.stillOpenTs, splitTs),
    }),
    outOfSample: computeMetrics(outOfSampleTrades, outOfSampleStartEquity, {
      ignoredCount: countAtOrAfter(run.ignoredTs, splitTs),
      skippedSizingCount: countAtOrAfter(run.skippedSizingTs, splitTs),
      stillOpenCount: countAtOrAfter(run.stillOpenTs, splitTs),
    }),
  };
}
