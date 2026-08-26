// Standalone comparison script for docs/hypothesis-ema-filter.md. Measures
// the frozen EMA12/26/100 filter against an EMA7/30/99 variant on the exact
// same cached 5m history, fixed-risk sizing only, canonical cost scenario
// (slip=1 tick, lower ambiguity bound, limit-tp fee model). This is a
// standalone hypothesis test, not part of the frozen spec: it never writes
// to CLAUDE.md, never changes the default EMA periods used anywhere else in
// this codebase, and its result is not merged back into the spec regardless
// of outcome. See docs/hypothesis-ema-filter.md for the pre-registered
// pass criteria this script's output is checked against.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, FIVE_MIN_MS, type Candle } from "./types.js";
import { loadInstrumentSpec, type InstrumentSpec } from "./instrumentSpec.js";
import type { EmaPeriods } from "./signal.js";
import { countFundingCrossings } from "./funding.js";
import { mean } from "./stats.js";
import { num, pct, usd } from "./format.js";
import { computeFixedRiskPositionSize } from "./positionSizing.js";
import {
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_RATE,
  computeMetrics,
  computeSplitTs,
  prepareData,
  runScenario,
  splitMetrics,
  type BacktestConfig,
  type Metrics,
  type PreparedData,
  type SizingFn,
  type SplitMetrics,
} from "./backtestEngine.js";

const INST_ID = "DOT-USDT-SWAP";
const STARTING_EQUITY_USDT = 100; // display only under fixed-risk sizing - does not affect win rate/expectancy R
const FUNDING_MATERIALITY_THRESHOLD = 0.05; // same 5% convention backtest.ts uses, not a CLAUDE.md rule

const BASELINE_EMA: EmaPeriods = { fast: 12, mid: 26, slow: 100 };
const HYPOTHESIS_EMA: EmaPeriods = { fast: 7, mid: 30, slow: 99 };

// CLAUDE.md section 4's execution policy: entry taker, TP maker (resting
// limit), SL taker. slip=1 tick, lower ambiguity bound (SL wins ties) - the
// same canonical scenario Phase 2/2b used.
const CANONICAL = { slippageTicks: 1, ambiguousBound: "lower" as const, feeModel: "limit-tp" as const };

const fixedRiskComputeSize: SizingFn = ({ entry, sl, spec }) => computeFixedRiskPositionSize({ entry, sl, spec });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-5m.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

// Reads the funding-rate-history cache directly rather than importing
// fetchFundingHistory.ts, which fires a live OKX refetch as an import-time
// side effect (flagged in README as a known, pre-existing issue - not fixed
// here, out of this task's scope).
interface FundingRateRecord {
  fundingTime: number;
  realizedRate: number;
}

interface FundingRateSummary {
  meanRealizedRate: number;
  n: number;
  fromTs: number;
  toTs: number;
}

function loadFundingRateSummary(instId: string): FundingRateSummary | null {
  let records: FundingRateRecord[];
  try {
    records = JSON.parse(readFileSync(path.join(DATA_DIR, `funding-rate-history-${instId}.json`), "utf8")) as FundingRateRecord[];
  } catch {
    return null;
  }
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.fundingTime - b.fundingTime);
  return {
    meanRealizedRate: mean(sorted.map((r) => r.realizedRate)),
    n: sorted.length,
    fromTs: at(sorted, 0).fundingTime,
    toTs: at(sorted, sorted.length - 1).fundingTime,
  };
}

function measureFundingCrossings(prepared: PreparedData, spec: InstrumentSpec): { pct: number; crossed: number; total: number } {
  const probeConfig: BacktestConfig = {
    startingEquityUsdt: STARTING_EQUITY_USDT,
    slippageTicks: CANONICAL.slippageTicks,
    ambiguousBound: CANONICAL.ambiguousBound,
    feeModel: CANONICAL.feeModel,
    takerFeeRate: DEFAULT_TAKER_FEE_RATE,
    makerFeeRate: DEFAULT_MAKER_FEE_RATE,
    fundingRateForCost: null,
    computeSize: fixedRiskComputeSize,
  };
  const run = runScenario(prepared, spec, probeConfig);
  const total = run.trades.length;
  const crossed = run.trades.filter((t) => countFundingCrossings(t.entryTs, t.exitTs) > 0).length;
  return { pct: total > 0 ? (crossed / total) * 100 : 0, crossed, total };
}

interface EmaSetResult {
  label: string;
  periods: EmaPeriods;
  fundingCrossingPct: number;
  fundingCostEnabled: boolean;
  fundingRateForCost: number | null;
  splitTs: number;
  grossOverall: Metrics;
  gross: SplitMetrics;
  net: SplitMetrics; // canonical, cost-bearing scenario
}

function runEmaSet(label: string, periods: EmaPeriods, candles: readonly Candle[], spec: InstrumentSpec, log: (line?: string) => void): EmaSetResult {
  log(`--- Preparing signals: ${label} ---`);
  const prepared = prepareData(candles, spec, FIVE_MIN_MS, periods);
  log(`Raw signals generated: ${prepared.totalSignalCount}`);

  const funding = measureFundingCrossings(prepared, spec);
  const fundingCostEnabled = funding.pct >= FUNDING_MATERIALITY_THRESHOLD * 100;
  const fundingSummary = fundingCostEnabled ? loadFundingRateSummary(INST_ID) : null;
  const fundingRateForCost = fundingSummary?.meanRealizedRate ?? null;
  log(
    `Funding: ${funding.crossed}/${funding.total} canonical-scenario trades (${pct(funding.pct)}) cross a funding settlement - ` +
      (fundingCostEnabled
        ? fundingSummary
          ? `at/above the ${FUNDING_MATERIALITY_THRESHOLD * 100}% materiality bar, modeled at ${(fundingRateForCost! * 100).toFixed(5)}% per 8h crossing (mean realized rate, n=${fundingSummary.n})`
          : `at/above the ${FUNDING_MATERIALITY_THRESHOLD * 100}% materiality bar but no cached funding-rate-history found - left at 0`
        : `below the ${FUNDING_MATERIALITY_THRESHOLD * 100}% materiality bar - not modeled (0)`),
  );

  const splitTs = computeSplitTs(prepared.firstTs, prepared.lastTs);

  const netConfig: BacktestConfig = {
    startingEquityUsdt: STARTING_EQUITY_USDT,
    slippageTicks: CANONICAL.slippageTicks,
    ambiguousBound: CANONICAL.ambiguousBound,
    feeModel: CANONICAL.feeModel,
    takerFeeRate: DEFAULT_TAKER_FEE_RATE,
    makerFeeRate: DEFAULT_MAKER_FEE_RATE,
    fundingRateForCost: fundingCostEnabled ? fundingRateForCost : null,
    computeSize: fixedRiskComputeSize,
  };
  const grossConfig: BacktestConfig = {
    startingEquityUsdt: STARTING_EQUITY_USDT,
    slippageTicks: 0,
    ambiguousBound: "lower",
    feeModel: "limit-tp",
    takerFeeRate: 0,
    makerFeeRate: 0,
    fundingRateForCost: null,
    computeSize: fixedRiskComputeSize,
  };

  const netRun = runScenario(prepared, spec, netConfig);
  const net = splitMetrics(netRun, STARTING_EQUITY_USDT, splitTs);

  const grossRun = runScenario(prepared, spec, grossConfig);
  const grossOverall = computeMetrics(grossRun.trades, STARTING_EQUITY_USDT, {
    ignoredCount: grossRun.ignoredTs.length,
    skippedSizingCount: grossRun.skippedSizingTs.length,
    stillOpenCount: grossRun.stillOpenTs.length,
  });
  const gross = splitMetrics(grossRun, STARTING_EQUITY_USDT, splitTs);

  // Under fixed-risk sizing, which trades gets sized depends only on
  // entry/sl/spec (never equity or fees), so the gross and net scenarios
  // must size the exact same signal set. A mismatch here would mean a bug
  // in this script's config, not a real property of the data.
  if (net.inSample.sampleSize + net.outOfSample.sampleSize !== gross.inSample.sampleSize + gross.outOfSample.sampleSize) {
    throw new Error(
      `${label}: gross (${gross.inSample.sampleSize + gross.outOfSample.sampleSize}) and net (${net.inSample.sampleSize + net.outOfSample.sampleSize}) trade counts disagree under fixed-risk sizing - this should be impossible, investigate before trusting any number below`,
    );
  }

  return { label, periods, fundingCrossingPct: funding.pct, fundingCostEnabled, fundingRateForCost: fundingCostEnabled ? fundingRateForCost : null, splitTs, grossOverall, gross, net };
}

// Abramowitz & Stegun 7.1.26 approximation of the standard normal CDF.
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2); // 1/sqrt(2*pi)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function twoProportionZTest(x1: number, n1: number, x2: number, n2: number): { z: number; pValue: number } {
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p1 - p2) / se : NaN;
  const pValue = Number.isFinite(z) ? 2 * (1 - normalCdf(Math.abs(z))) : NaN;
  return { z, pValue };
}

function row(label: string, baselineVal: string, hypothesisVal: string): string {
  return `${label.padEnd(38)} ${baselineVal.padStart(16)}   ${hypothesisVal.padStart(16)}`;
}

function main(): void {
  const report: string[] = [];
  const log = (line = ""): void => {
    report.push(line);
    console.log(line);
  };

  log("=== EMA filter hypothesis test: 12/26/100 (baseline) vs 7/30/99 (hypothesis) ===");
  log("5m only. Fixed-risk sizing only (flat 2 USDT risk/trade, no compounding). CLAUDE.md section 4 is not modified.");
  log("Pre-registered hypothesis and pass criteria: docs/hypothesis-ema-filter.md (written and frozen first, not edited after).");
  log("");

  const spec = loadInstrumentSpec(INST_ID);
  const candles = loadCandles();
  if (candles.length === 0) {
    console.log("No 5m candles found in data/. Run fetch-data first.");
    return;
  }
  const first = at(candles, 0);
  const last = at(candles, candles.length - 1);
  log(`Data: ${candles.length} candles, ${new Date(first.ts).toISOString()} -> ${new Date(last.ts).toISOString()}`);
  log(`Instrument spec: ctVal=${spec.ctVal} ${spec.ctValCcy}, lotSz=${spec.lotSz}, minSz=${spec.minSz}, tickSz=${spec.tickSz}, lever=${spec.lever}x`);
  log("");

  const baseline = runEmaSet(`baseline (${BASELINE_EMA.fast}/${BASELINE_EMA.mid}/${BASELINE_EMA.slow})`, BASELINE_EMA, candles, spec, log);
  log("");
  const hypothesis = runEmaSet(`hypothesis (${HYPOTHESIS_EMA.fast}/${HYPOTHESIS_EMA.mid}/${HYPOTHESIS_EMA.slow})`, HYPOTHESIS_EMA, candles, spec, log);
  log("");

  const bIn = baseline.gross.inSample, bOut = baseline.gross.outOfSample, bAll = baseline.grossOverall;
  const hIn = hypothesis.gross.inSample, hOut = hypothesis.gross.outOfSample, hAll = hypothesis.grossOverall;
  const bNetIn = baseline.net.inSample, bNetOut = baseline.net.outOfSample;
  const hNetIn = hypothesis.net.inSample, hNetOut = hypothesis.net.outOfSample;

  log(`=== Side by side (baseline vs hypothesis) ===`);
  log(row("", "baseline", "hypothesis"));
  log(row("in-sample n", num(bNetIn.sampleSize, 0), num(hNetIn.sampleSize, 0)));
  log(row("out-of-sample n", num(bNetOut.sampleSize, 0), num(hNetOut.sampleSize, 0)));
  log("");
  log(row("gross win rate, overall", pct(bAll.winRate * 100), pct(hAll.winRate * 100)));
  log(row("gross win rate, in-sample", pct(bIn.winRate * 100), pct(hIn.winRate * 100)));
  log(row("gross win rate, out-of-sample", pct(bOut.winRate * 100), pct(hOut.winRate * 100)));
  log(row("gross expectancy R, overall", num(bAll.expectancyR), num(hAll.expectancyR)));
  log(row("gross expectancy R, in-sample", num(bIn.expectancyR), num(hIn.expectancyR)));
  log(row("gross expectancy R, out-of-sample", num(bOut.expectancyR), num(hOut.expectancyR)));
  log("");
  log(row("net expectancy R, in-sample", num(bNetIn.expectancyR), num(hNetIn.expectancyR)));
  log(row("net expectancy R, out-of-sample", num(bNetOut.expectancyR), num(hNetOut.expectancyR)));
  log(row("break-even win rate, in-sample", pct(bNetIn.breakEvenWinRate * 100), pct(hNetIn.breakEvenWinRate * 100)));
  log(row("achieved win rate (net), in-sample", pct(bNetIn.winRate * 100), pct(hNetIn.winRate * 100)));
  log(row("break-even win rate, out-of-sample", pct(bNetOut.breakEvenWinRate * 100), pct(hNetOut.breakEvenWinRate * 100)));
  log(row("achieved win rate (net), out-of-sample", pct(bNetOut.winRate * 100), pct(hNetOut.winRate * 100)));
  log(row("ambiguous bars, in-sample", `${bNetIn.ambiguousCount} (${pct(bNetIn.ambiguousPctOfSample)})`, `${hNetIn.ambiguousCount} (${pct(hNetIn.ambiguousPctOfSample)})`));
  log(row("ambiguous bars, out-of-sample", `${bNetOut.ambiguousCount} (${pct(bNetOut.ambiguousPctOfSample)})`, `${hNetOut.ambiguousCount} (${pct(hNetOut.ambiguousPctOfSample)})`));
  log("");

  const CITED_BASELINE_WIN_RATE_PCT = 34.48; // reference figure from the task that requested this test
  const measuredBaselinePct = bAll.winRate * 100;
  const measuredHypothesisPct = hAll.winRate * 100;
  const deltaFromMeasuredBaseline = measuredHypothesisPct - measuredBaselinePct;
  const deltaFromCitedBaseline = measuredHypothesisPct - CITED_BASELINE_WIN_RATE_PCT;
  log(`=== Win-rate delta (gross, overall) ===`);
  log(`Measured baseline (12/26/100, fixed-risk, this run): ${pct(measuredBaselinePct)} (n=${bAll.sampleSize})`);
  log(`Cited reference baseline (from the task that requested this test): ${CITED_BASELINE_WIN_RATE_PCT}%`);
  log(
    `Gap between measured and cited baseline: ${(measuredBaselinePct - CITED_BASELINE_WIN_RATE_PCT).toFixed(2)}pp - ${Math.abs(measuredBaselinePct - CITED_BASELINE_WIN_RATE_PCT) < 0.5 ? "close, consistent with the same underlying signal measured a different way" : "notable; see docs/hypothesis-ema-filter.md's reporting-requirements caveat on sizing-mode differences"}.`,
  );
  log(`Hypothesis (7/30/99, fixed-risk, this run): ${pct(measuredHypothesisPct)} (n=${hAll.sampleSize})`);
  log(`Delta vs measured baseline: ${deltaFromMeasuredBaseline >= 0 ? "+" : ""}${deltaFromMeasuredBaseline.toFixed(2)}pp`);
  log(`Delta vs cited baseline (${CITED_BASELINE_WIN_RATE_PCT}%): ${deltaFromCitedBaseline >= 0 ? "+" : ""}${deltaFromCitedBaseline.toFixed(2)}pp`);
  log("");

  const zTest = twoProportionZTest(hAll.wins, hAll.sampleSize, bAll.wins, bAll.sampleSize);
  log(`=== Supplementary statistical context (not a pass/fail gate - see docs/hypothesis-ema-filter.md) ===`);
  log(`Two-proportion z-test, gross win rate, hypothesis (n=${hAll.sampleSize}) vs baseline (n=${bAll.sampleSize}): z=${num(zTest.z, 3)}, two-tailed p=${num(zTest.pValue, 4)}`);
  log(`(A small p-value means the win-rate gap is unlikely under "both sets have the same true win rate." This does not establish that either side's win rate beats break-even, and both sample sizes are large enough here for the normal approximation to be reasonable.)`);
  log("");

  log(`=== Pass criteria check (docs/hypothesis-ema-filter.md, hypothesis run only) ===`);
  const c1 = hNetIn.expectancyR > 0 && hNetOut.expectancyR > 0;
  log(`1. Net expectancy positive in-sample AND out-of-sample: in-sample=${num(hNetIn.expectancyR)}R, out-of-sample=${num(hNetOut.expectancyR)}R -> ${c1 ? "PASS" : "FAIL"}`);
  log(`2. Scenario = slip 1 tick, lower ambiguity bound, limit-tp fee model: applied throughout -> PASS (by construction)`);
  const c3 = hNetOut.expectancyR > 0;
  log(`3. Out-of-sample net expectancy positive under limit-tp specifically: ${num(hNetOut.expectancyR)}R -> ${c3 ? "PASS" : "FAIL"}`);
  const c4 = hNetOut.sampleSize >= 100;
  log(`4. Out-of-sample trade count >= 100: n=${hNetOut.sampleSize} -> ${c4 ? "PASS" : "FAIL"}`);
  const allPass = c1 && c3 && c4;
  log("");
  log(`VERDICT: hypothesis (EMA 7/30/99) ${allPass ? "PASSES all pre-registered criteria" : "FAILS the pre-registered criteria (see per-criterion results above - not necessarily every criterion)"}.`);
  log("");

  const outDir = DATA_DIR;
  const jsonPath = path.join(outDir, "hypothesis-ema-filter-results.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        citedBaselineWinRatePct: CITED_BASELINE_WIN_RATE_PCT,
        baseline: {
          periods: BASELINE_EMA,
          fundingCrossingPct: baseline.fundingCrossingPct,
          fundingCostEnabled: baseline.fundingCostEnabled,
          fundingRateForCost: baseline.fundingRateForCost,
          grossOverall: baseline.grossOverall,
          gross: baseline.gross,
          net: baseline.net,
        },
        hypothesis: {
          periods: HYPOTHESIS_EMA,
          fundingCrossingPct: hypothesis.fundingCrossingPct,
          fundingCostEnabled: hypothesis.fundingCostEnabled,
          fundingRateForCost: hypothesis.fundingRateForCost,
          grossOverall: hypothesis.grossOverall,
          gross: hypothesis.gross,
          net: hypothesis.net,
        },
        winRateDelta: { vsMeasuredBaselinePp: deltaFromMeasuredBaseline, vsCitedBaselinePp: deltaFromCitedBaseline },
        twoProportionZTest: zTest,
        passCriteria: { criterion1: c1, criterion3: c3, criterion4: c4, overall: allPass },
      },
      null,
      2,
    ),
  );
  log(`Full results written to ${jsonPath}`);

  const reportPath = path.join(outDir, "hypothesis-ema-filter-report.txt");
  writeFileSync(reportPath, report.join("\n") + "\n");
  console.log(`Report written to ${reportPath}`);
}

main();
