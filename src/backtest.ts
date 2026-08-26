import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, type Candle } from "./types.js";
import { loadInstrumentSpec, type InstrumentSpec } from "./instrumentSpec.js";
import { countFundingCrossings } from "./funding.js";
import { fundingHistoryCachePath, type FundingRateRecord } from "./fetchFundingHistory.js";
import { mean } from "./stats.js";
import { num, pct, usd } from "./format.js";
import { computeFixedRiskPositionSize, computePositionSize, FIXED_RISK_USDT_FOR_MEASUREMENT } from "./positionSizing.js";
import {
  DEFAULT_MAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_RATE,
  computeSplitTs,
  prepareData,
  runScenario,
  splitMetrics,
  type AmbiguousBound,
  type BacktestConfig,
  type FeeModel,
  type Metrics,
  type PreparedData,
  type SizingFn,
  type SplitMetrics,
} from "./backtestEngine.js";
import { barIntervalMs, isBar, SUPPORTED_BARS, type Bar } from "./barInterval.js";

const INST_ID = "DOT-USDT-SWAP";
const DEFAULT_BAR: Bar = "5m";
const STARTING_EQUITY_USDT = 100;
// 5% materiality bar for bothering to model funding cost at all. This is
// NOT in CLAUDE.md - CLAUDE.md section 4 says only "full P&L with fees,
// slippage, and funding" unconditionally. The 5% figure was set by the
// user's chat instructions for the Phase 2 task, not the frozen spec file.
const FUNDING_MATERIALITY_THRESHOLD = 0.05;
const SLIPPAGE_TICKS_SCENARIOS = [0, 1, 2] as const;
const AMBIGUOUS_BOUNDS: readonly AmbiguousBound[] = ["lower", "upper"];
const FEE_MODELS: readonly FeeModel[] = ["limit-tp", "all-taker"];
// The scenario printed in full detail (monthly, top trades, risk
// distribution, ...); every scenario still gets full metrics computed and
// written to the JSON dump, this just picks which one is worth reading in
// the console/markdown report.
const CANONICAL = { slippageTicks: 1, ambiguousBound: "lower" as AmbiguousBound, feeModel: "limit-tp" as FeeModel };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

function parseBarArg(argv: readonly string[]): Bar {
  const idx = argv.indexOf("--bar");
  if (idx === -1) return DEFAULT_BAR;
  const value = argv[idx + 1];
  if (value === undefined || !isBar(value)) {
    throw new Error(`--bar must be one of: ${SUPPORTED_BARS.join(", ")} (got ${String(value)})`);
  }
  return value;
}

// "fixed" is the measurement-only mode added to check whether the frozen
// spec's 2%-of-equity compounding is truncating the statistical sample (see
// positionSizing.ts's computeFixedRiskPositionSize) - it is NEVER the
// default and never touches CLAUDE.md section 4.
type SizingArg = "compounding" | "fixed";

function parseSizingArg(argv: readonly string[]): SizingArg {
  const idx = argv.indexOf("--sizing");
  if (idx === -1) return "compounding";
  const value = argv[idx + 1];
  if (value !== "compounding" && value !== "fixed") {
    throw new Error(`--sizing must be one of: compounding, fixed (got ${String(value)})`);
  }
  return value;
}

// The 5m outputs keep their original, unsuffixed filenames (Phase 2's
// already-completed artifact) - every other timeframe gets its own
// bar-suffixed files so a Phase 2b run never overwrites Phase 2's report.
// Fixed-risk runs get an extra "-fixed-risk" tag so they never collide with
// the canonical compounding artifacts on any bar, including 5m.
function outputFileName(base: string, ext: string, bar: Bar, sizing: SizingArg): string {
  const tag = sizing === "fixed" ? `${base}-fixed-risk` : base;
  return bar === "5m" ? `${tag}.${ext}` : `${tag}-${bar}.${ext}`;
}

interface ScenarioLabel {
  slippageTicks: number;
  ambiguousBound: AmbiguousBound;
  feeModel: FeeModel;
}

function labelFor(s: ScenarioLabel): string {
  return `slip=${s.slippageTicks}t bound=${s.ambiguousBound} fee=${s.feeModel}`;
}

function buildConfig(s: ScenarioLabel, fundingRateForCost: number | null, computeSize: SizingFn): BacktestConfig {
  return {
    startingEquityUsdt: STARTING_EQUITY_USDT,
    slippageTicks: s.slippageTicks,
    ambiguousBound: s.ambiguousBound,
    feeModel: s.feeModel,
    takerFeeRate: DEFAULT_TAKER_FEE_RATE,
    makerFeeRate: DEFAULT_MAKER_FEE_RATE,
    fundingRateForCost,
    computeSize,
  };
}

// True gross (fee=0/slippage=0/funding=0) scenario - not expressible via
// buildConfig, which always applies the real fee rates. Only used in
// --sizing fixed runs, as the explicit "before cost" counterpart to the
// canonical "after cost" detail block, both under the same fixed-risk sizing
// so the only thing that differs between them is cost.
function buildGrossConfig(computeSize: SizingFn): BacktestConfig {
  return {
    startingEquityUsdt: STARTING_EQUITY_USDT,
    slippageTicks: 0,
    ambiguousBound: "lower",
    feeModel: "limit-tp",
    takerFeeRate: 0,
    makerFeeRate: 0,
    fundingRateForCost: null,
    computeSize,
  };
}

function headlineRow(s: ScenarioLabel, m: Metrics): string {
  return [
    labelFor(s).padEnd(28),
    `n=${String(m.sampleSize).padStart(5)}`,
    `win=${pct(m.winRate * 100).padStart(7)}`,
    `E[R]=${num(m.expectancyR).padStart(7)}`,
    `E[$]=${usd(m.expectancyUsdt, 3).padStart(9)}`,
    `return=${pct(m.totalReturnPct).padStart(12)}`,
    `maxDD=${pct(m.maxDrawdownPct).padStart(8)}`,
    `fees%GP=${pct(m.feesPctOfGrossProfit).padStart(9)}`,
  ].join("  ");
}

function printFullMetrics(title: string, m: Metrics): string[] {
  const lines: string[] = [];
  lines.push(`--- ${title} ---`);
  lines.push(`sample size: ${m.sampleSize} (long ${m.longCount}, short ${m.shortCount})`);
  lines.push(
    `ignored (position open): ${m.ignoredCount}, skipped (sizing rejected): ${m.skippedSizingCount}, still open at data end: ${m.stillOpenCount}`,
  );
  lines.push(`win rate: ${pct(m.winRate * 100)} (${m.wins}W / ${m.losses}L)`);
  lines.push(`expectancy: ${num(m.expectancyR)} R  |  ${usd(m.expectancyUsdt)} USDT per trade`);
  lines.push(
    `equity: ${usd(m.startEquityUsdt, 2)} -> ${usd(m.endEquityUsdt, 2)} USDT  (${pct(m.totalReturnPct)} total return)`,
  );
  lines.push(`max drawdown: ${pct(m.maxDrawdownPct)}   longest losing streak: ${m.longestLosingStreak} trades`);
  lines.push(
    `fees: ${usd(m.totalFeesUsdt, 2)} USDT total = ${pct(m.feesPctOfGrossProfit)} of gross winning profit (${usd(m.grossWinningProfitUsdt, 2)} USDT)`,
  );
  lines.push(`funding cost applied: ${usd(m.totalFundingUsdt, 2)} USDT`);
  lines.push(
    `break-even win rate at real cost: ${pct(m.breakEvenWinRate * 100)}  vs.  actual win rate: ${pct(m.winRate * 100)}  (edge: ${pct((m.winRate - m.breakEvenWinRate) * 100)})`,
  );
  lines.push(`ambiguous bars (TP and SL both touched): ${m.ambiguousCount} (${pct(m.ambiguousPctOfSample)} of sample)`);
  lines.push(
    `actual risk after rounding, as % of target risk: n=${m.riskDistribution.n} mean=${num(m.riskDistribution.meanPctOfTarget)}% min=${num(m.riskDistribution.minPctOfTarget)}% p10=${num(m.riskDistribution.p10PctOfTarget)}% median=${num(m.riskDistribution.medianPctOfTarget)}% p90=${num(m.riskDistribution.p90PctOfTarget)}%`,
  );
  lines.push("monthly:");
  for (const mo of m.monthly) {
    lines.push(`  ${mo.month}: ${mo.trades} trades, ${mo.wins} wins, ${usd(mo.netPnlUsdt, 2)} USDT`);
  }
  lines.push(`top 5 winning trades (of ${m.wins} total wins):`);
  for (const t of m.topTrades) {
    lines.push(
      `  ${new Date(t.entryTs).toISOString()} ${t.side.padEnd(5)} ${usd(t.netPnlUsdt, 2)} USDT (${pct(t.pctOfWinningProfit)} of total winning profit)`,
    );
  }
  const top5Pct = m.topTrades.reduce((s, t) => s + (Number.isFinite(t.pctOfWinningProfit) ? t.pctOfWinningProfit : 0), 0);
  lines.push(`  top 5 combined: ${pct(top5Pct)} of total winning profit`);
  return lines;
}

interface FundingRateSummary {
  meanRealizedRate: number;
  n: number;
  fromTs: number;
  toTs: number;
}

// OKX's funding-rate-history endpoint only retains a few months (confirmed
// empirically: DOT-USDT-SWAP returned records back to ~2026-05-23 and
// nothing older, against a backtest starting 2020-08). There is no way to
// get real historical rates for the other ~6 years, so the mean realized
// rate over the available window is used as a constant proxy for every
// crossing in the whole backtest. This is disclosed, not hidden: see the
// funding section of the report.
function loadFundingRateSummary(instId: string): FundingRateSummary | null {
  let records: FundingRateRecord[];
  try {
    records = JSON.parse(readFileSync(fundingHistoryCachePath(instId), "utf8")) as FundingRateRecord[];
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

function measureFundingCrossings(
  prepared: PreparedData,
  spec: InstrumentSpec,
  computeSize: SizingFn,
): { pct: number; crossed: number; total: number } {
  const probeConfig = buildConfig(CANONICAL, null, computeSize);
  const run = runScenario(prepared, spec, probeConfig);
  const total = run.trades.length;
  const crossed = run.trades.filter((t) => countFundingCrossings(t.entryTs, t.exitTs) > 0).length;
  return { pct: total > 0 ? (crossed / total) * 100 : 0, crossed, total };
}

function main(): void {
  const report: string[] = [];
  const log = (line = ""): void => {
    report.push(line);
    console.log(line);
  };

  const bar = parseBarArg(process.argv.slice(2));
  const sizingArg = parseSizingArg(process.argv.slice(2));
  const computeSize: SizingFn =
    sizingArg === "fixed" ? ({ entry, sl, spec: s }) => computeFixedRiskPositionSize({ entry, sl, spec: s }) : computePositionSize;
  const spec = loadInstrumentSpec(INST_ID);
  const candles = loadCandles(bar);
  if (candles.length === 0) {
    console.log(`No ${bar} candles found in data/. Run fetch-data first.`);
    return;
  }
  const first = at(candles, 0);
  const last = at(candles, candles.length - 1);

  log(`=== DOT-USDT-SWAP ${bar} backtest${sizingArg === "fixed" ? " [FIXED-RISK MEASUREMENT MODE]" : ""} ===`);
  log(`Data: ${candles.length} candles, ${new Date(first.ts).toISOString()} -> ${new Date(last.ts).toISOString()}`);
  log(
    `Instrument spec: ctVal=${spec.ctVal} ${spec.ctValCcy}, lotSz=${spec.lotSz}, minSz=${spec.minSz}, tickSz=${spec.tickSz}, lever=${spec.lever}x`,
  );
  if (sizingArg === "fixed") {
    log(
      `Starting equity: ${STARTING_EQUITY_USDT} USDT (display only, NOT used for sizing). Sizing: flat ${FIXED_RISK_USDT_FOR_MEASUREMENT} USDT risk per trade, no compounding - MEASUREMENT ONLY, not the frozen spec. CLAUDE.md section 4 stays 2% of current equity for the live bot and the default (compounding) run of this script.`,
    );
  } else {
    log(`Starting equity: ${STARTING_EQUITY_USDT} USDT, risk 2% of current equity per trade (compounding)`);
  }
  log("");

  const t0 = Date.now();
  const prepared = prepareData(candles, spec, barIntervalMs(bar));
  const prepMs = Date.now() - t0;
  log(`Signals generated: ${prepared.totalSignalCount} (prepare took ${prepMs}ms)`);
  log(`Contiguous segments: ${prepared.segments.length}`);
  log("");

  // --- Funding measurement (CLAUDE.md section 4): measure first, only
  // model real cost if >=5% of trades hold across a funding settlement. ---
  const funding = measureFundingCrossings(prepared, spec, computeSize);
  log("=== Funding exposure measurement ===");
  log(
    `${funding.crossed} / ${funding.total} trades (${pct(funding.pct)}) in the canonical scenario (${labelFor(CANONICAL)}) held open across at least one 8h funding settlement (00:00/08:00/16:00 UTC).`,
  );
  const fundingCostEnabled = funding.pct >= FUNDING_MATERIALITY_THRESHOLD * 100;
  let fundingRateForCost: number | null = null;
  let fundingSummary: FundingRateSummary | null = null;
  if (!fundingCostEnabled) {
    log(
      `Below the ${FUNDING_MATERIALITY_THRESHOLD * 100}% materiality bar - funding cost is NOT modelled (kept at 0 in every scenario below).`,
    );
  } else {
    log(`At or above the ${FUNDING_MATERIALITY_THRESHOLD * 100}% materiality bar - fetching real funding rate history.`);
    fundingSummary = loadFundingRateSummary(INST_ID);
    if (fundingSummary === null) {
      log(`No cached funding rate history found. Run "npm run fetch-funding-history" first; funding cost left at 0 for this run.`);
    } else {
      fundingRateForCost = fundingSummary.meanRealizedRate;
      log(
        `OKX funding-rate-history only retains ${fundingSummary.n} records, ${new Date(fundingSummary.fromTs).toISOString()} -> ${new Date(fundingSummary.toTs).toISOString()} - it does not reach back to the start of the backtest (${new Date(first.ts).toISOString()}).`,
      );
      log(
        `Mean realized rate over that window: ${(fundingRateForCost * 100).toFixed(5)}% per 8h settlement. Applied as a CONSTANT proxy rate to every crossing across the full 2020-2026 backtest below (there is no real historical rate available for periods before ${new Date(fundingSummary.fromTs).toISOString()}) - treat funding numbers as an approximation, not a real historical cost.`,
      );
    }
  }
  log("");

  const splitTsValue = computeSplitTs(prepared.firstTs, prepared.lastTs);
  log(
    `In-sample / out-of-sample split at ${new Date(splitTsValue).toISOString()} (first 70% / last 30% of the data's time range)`,
  );
  log("");

  const scenarios: ScenarioLabel[] = [];
  for (const slippageTicks of SLIPPAGE_TICKS_SCENARIOS) {
    for (const ambiguousBound of AMBIGUOUS_BOUNDS) {
      for (const feeModel of FEE_MODELS) {
        scenarios.push({ slippageTicks, ambiguousBound, feeModel });
      }
    }
  }

  const results: { scenario: ScenarioLabel; split: SplitMetrics }[] = [];
  for (const scenario of scenarios) {
    const config = buildConfig(scenario, fundingCostEnabled ? fundingRateForCost : null, computeSize);
    const run = runScenario(prepared, spec, config);
    const split = splitMetrics(run, STARTING_EQUITY_USDT, splitTsValue);
    results.push({ scenario, split });
  }

  log("=== Comparison matrix: IN-SAMPLE (first 70%) ===");
  for (const { scenario, split } of results) log(headlineRow(scenario, split.inSample));
  log("");
  log("=== Comparison matrix: OUT-OF-SAMPLE (last 30%) ===");
  for (const { scenario, split } of results) log(headlineRow(scenario, split.outOfSample));
  log("");

  const canonicalResult = results.find(
    (r) =>
      r.scenario.slippageTicks === CANONICAL.slippageTicks &&
      r.scenario.ambiguousBound === CANONICAL.ambiguousBound &&
      r.scenario.feeModel === CANONICAL.feeModel,
  );
  if (canonicalResult) {
    log(`=== Full detail: canonical scenario (${labelFor(CANONICAL)}) ===`);
    log("");
    for (const line of printFullMetrics("IN-SAMPLE", canonicalResult.split.inSample)) log(line);
    log("");
    for (const line of printFullMetrics("OUT-OF-SAMPLE", canonicalResult.split.outOfSample)) log(line);
    log("");
  }

  // Also show the upper-ambiguous-bound counterpart of the canonical
  // scenario side by side, since ambiguous resolution is the one axis whose
  // "which side wins" isn't visible from the fee-focused comparison alone.
  const upperCounterpart = results.find(
    (r) =>
      r.scenario.slippageTicks === CANONICAL.slippageTicks &&
      r.scenario.ambiguousBound === "upper" &&
      r.scenario.feeModel === CANONICAL.feeModel,
  );
  if (upperCounterpart) {
    log(`=== Full detail: upper-bound counterpart (${labelFor(upperCounterpart.scenario)}) ===`);
    log("");
    for (const line of printFullMetrics("IN-SAMPLE", upperCounterpart.split.inSample)) log(line);
    log("");
    for (const line of printFullMetrics("OUT-OF-SAMPLE", upperCounterpart.split.outOfSample)) log(line);
    log("");
  }

  // Fixed-risk mode only: an explicit zero-cost scenario, so "before cost"
  // (this block) vs "after cost" (the canonical block above) is a direct
  // comparison under the SAME sizing - the matrix above never sets fees to
  // exactly 0, so it can't answer that by itself.
  let grossFixedSplit: SplitMetrics | null = null;
  if (sizingArg === "fixed") {
    const grossRun = runScenario(prepared, spec, buildGrossConfig(computeSize));
    grossFixedSplit = splitMetrics(grossRun, STARTING_EQUITY_USDT, splitTsValue);
    log(`=== Full detail: gross, before-cost scenario (fee=0, slippage=0, funding=0), fixed-risk sizing ===`);
    log("");
    for (const line of printFullMetrics("IN-SAMPLE", grossFixedSplit.inSample)) log(line);
    log("");
    for (const line of printFullMetrics("OUT-OF-SAMPLE", grossFixedSplit.outOfSample)) log(line);
    log("");
  }

  const totalMs = Date.now() - t0;
  log(`Total backtest time: ${totalMs}ms`);

  const outDir = DATA_DIR;
  const jsonPath = path.join(outDir, outputFileName("backtest-results", "json", bar, sizingArg));
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        bar,
        sizingMode: sizingArg,
        dataRange: { from: first.ts, to: last.ts, candleCount: candles.length },
        instrumentSpec: spec,
        startingEquityUsdt: STARTING_EQUITY_USDT,
        splitTs: splitTsValue,
        funding,
        fundingCostEnabled,
        fundingRateForCost,
        fundingSummary,
        scenarios: results.map((r) => ({ scenario: r.scenario, inSample: r.split.inSample, outOfSample: r.split.outOfSample })),
        ...(grossFixedSplit ? { grossFixedRisk: { inSample: grossFixedSplit.inSample, outOfSample: grossFixedSplit.outOfSample } } : {}),
      },
      null,
      2,
    ),
  );
  log(`Full per-scenario metrics written to ${jsonPath}`);

  const reportPath = path.join(outDir, outputFileName("backtest-report", "txt", bar, sizingArg));
  writeFileSync(reportPath, report.join("\n") + "\n");
  console.log(`Report written to ${reportPath}`);
}

main();
