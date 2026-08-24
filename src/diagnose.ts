import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, type Candle, type Signal } from "./types.js";
import { loadInstrumentSpec } from "./instrumentSpec.js";
import { num, pct, usd } from "./format.js";
import { mean, percentile } from "./stats.js";
import {
  computeMetrics,
  computeSplitTs,
  prepareData,
  runScenario,
  splitMetrics,
  type BacktestConfig,
  type ClosedTrade,
} from "./backtestEngine.js";
import { buildDirectionalVariants, mulberry32, percentileRankOf, runPermutationTrials } from "./randomBaseline.js";

const INST_ID = "DOT-USDT-SWAP";
const STARTING_EQUITY_USDT = 100;
const PERMUTATION_TRIALS = 100;
const PERMUTATION_SEED = 20260824; // fixed: reruns reproduce the same 100 trials
const SAMPLE_DAY_COUNT = 3;
const SAMPLE_DAY_SEED = 20260824;
// Real execution costs, same as the canonical scenario in backtest.ts, used
// only for the "where is the P&L coming from" segment breakdowns in step 4.
// Funding is left out here (fundingRateForCost: null) because backtest.ts
// already measured it at ~0.13% of R - immaterial - so it's not worth the
// extra fetch/wiring for a diagnostic pass.
const CANONICAL_CONFIG: BacktestConfig = {
  startingEquityUsdt: STARTING_EQUITY_USDT,
  slippageTicks: 1,
  ambiguousBound: "lower",
  feeModel: "limit-tp",
  takerFeeRate: 0.0005,
  makerFeeRate: 0.0002,
  fundingRateForCost: null,
};
const GROSS_CONFIG: BacktestConfig = {
  startingEquityUsdt: STARTING_EQUITY_USDT,
  slippageTicks: 0,
  ambiguousBound: "lower",
  feeModel: "limit-tp",
  takerFeeRate: 0,
  makerFeeRate: 0,
  fundingRateForCost: null,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Step 1: export a manually-checkable sample -----------------------

function exportRandomDaysCsv(allSignals: readonly Signal[], log: (line?: string) => void): void {
  const byDay = new Map<string, Signal[]>();
  for (const s of allSignals) {
    const key = utcDateKey(s.time);
    const arr = byDay.get(key) ?? [];
    arr.push(s);
    byDay.set(key, arr);
  }
  const days = [...byDay.keys()].sort();
  const rng = mulberry32(SAMPLE_DAY_SEED);
  const chosen = new Set<string>();
  while (chosen.size < Math.min(SAMPLE_DAY_COUNT, days.length)) {
    chosen.add(at(days, Math.floor(rng() * days.length)));
  }

  const rows: Signal[] = [];
  for (const day of [...chosen].sort()) {
    rows.push(...(byDay.get(day) ?? []));
  }
  rows.sort((a, b) => a.time - b.time);

  const lines = ["timestamp_utc,side,entry,sl,tp"];
  for (const s of rows) {
    lines.push(`${new Date(s.time).toISOString()},${s.side},${s.entry},${s.sl},${s.tp}`);
  }
  const file = path.join(DATA_DIR, "signal-sample-3days.csv");
  writeFileSync(file, lines.join("\n") + "\n");

  log("=== Step 1: manual-check sample ===");
  log(`Randomly picked ${chosen.size} UTC day(s) (seed=${SAMPLE_DAY_SEED}): ${[...chosen].sort().join(", ")}`);
  for (const day of [...chosen].sort()) {
    log(`  ${day}: ${(byDay.get(day) ?? []).length} raw signal(s)`);
  }
  log(`${rows.length} raw signals (side, entry, sl, tp - straight from computeSignal, before any position-management or costs) written to ${file}`);
  log("Compare these against TradingView by hand: this is the entire signal-generation surface. If this is wrong, nothing downstream matters.");
  log("");
}

// --- Step 4 helpers: segment breakdowns --------------------------------

interface GroupSummary {
  key: string;
  n: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  expectancyUsdt: number;
}

function summarize(key: string, trades: readonly ClosedTrade[]): GroupSummary {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPnlUsdt > 0).length;
  return {
    key,
    n,
    wins,
    winRate: n > 0 ? wins / n : NaN,
    expectancyR: n > 0 ? mean(trades.map((t) => t.rMultiple)) : NaN,
    expectancyUsdt: n > 0 ? mean(trades.map((t) => t.netPnlUsdt)) : NaN,
  };
}

function groupBy(trades: readonly ClosedTrade[], keyFn: (t: ClosedTrade) => string): GroupSummary[] {
  const map = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const k = keyFn(t);
    const arr = map.get(k) ?? [];
    arr.push(t);
    map.set(k, arr);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, ts]) => summarize(k, ts));
}

function printGroupTable(title: string, groups: readonly GroupSummary[], log: (line?: string) => void): void {
  log(title);
  for (const g of groups) {
    log(
      `  ${g.key.padEnd(10)} n=${String(g.n).padStart(5)}  win=${pct(g.winRate * 100).padStart(7)}  E[R]=${num(g.expectancyR).padStart(7)}  E[$]=${usd(g.expectancyUsdt, 4).padStart(9)}`,
    );
  }
  log("");
}

function main(): void {
  const report: string[] = [];
  const log = (line = ""): void => {
    report.push(line);
    console.log(line);
  };

  const spec = loadInstrumentSpec(INST_ID);
  const candles = loadCandles("5m");
  if (candles.length === 0) {
    console.log("No 5m candles found in data/. Run fetch-data first.");
    return;
  }

  log("=== Phase 2 diagnosis: why is expectancy negative? ===");
  log("Root-cause investigation only - CLAUDE.md section 4 (bodyRatio, RR, EMA periods, strong-candle test) is untouched.");
  log("");

  const t0 = Date.now();
  const prepared = prepareData(candles, spec);
  log(`Prepared ${prepared.totalSignalCount} raw signals over ${prepared.segments.length} segment(s) in ${Date.now() - t0}ms`);
  log("");

  const allRawSignals = prepared.signalsBySegment.flat();
  exportRandomDaysCsv(allRawSignals, log);

  const splitTsValue = computeSplitTs(prepared.firstTs, prepared.lastTs);

  // --- Step 2: gross (pre-cost) expectancy --------------------------
  log("=== Step 2: gross expectancy (fee=0, slippage=0, funding=0) ===");
  log("Separates whether the deficit is in the SIGNAL (gross also negative) or in COSTS (gross positive, net negative).");
  const grossRun = runScenario(prepared, spec, GROSS_CONFIG);
  const grossOverall = computeMetrics(grossRun.trades, STARTING_EQUITY_USDT, {
    ignoredCount: grossRun.ignoredTs.length,
    skippedSizingCount: grossRun.skippedSizingTs.length,
    stillOpenCount: grossRun.stillOpenTs.length,
  });
  const grossSplit = splitMetrics(grossRun, STARTING_EQUITY_USDT, splitTsValue);
  for (const [label, m] of [
    ["overall", grossOverall],
    ["in-sample", grossSplit.inSample],
    ["out-of-sample", grossSplit.outOfSample],
  ] as const) {
    log(`  ${label.padEnd(14)} n=${String(m.sampleSize).padStart(5)}  gross win rate=${pct(m.winRate * 100).padStart(7)}  gross E[R]=${num(m.expectancyR).padStart(7)}`);
  }
  log(`  (reference: zero-cost break-even win rate at a 2:1 RR is exactly 1/3 = 33.33%)`);
  log("");

  // --- Step 3: random-direction baseline -----------------------------
  log("=== Step 3: random-direction baseline (permutation test) ===");
  log(
    "Same anchors (bar2/bar0), same entry/SL/TP construction formula, same one-position-at-a-time rule, same position sizing, same engine (runScenario) - the ONLY thing randomized is which direction (long/short) each anchor trades, via a fair coin. Fee=0/slippage=0/funding=0, matching step 2, so the comparison is apples to apples.",
  );
  const variants = buildDirectionalVariants(prepared, spec);
  const trials = runPermutationTrials(prepared, variants, spec, STARTING_EQUITY_USDT, PERMUTATION_TRIALS, PERMUTATION_SEED);
  const trialWinRates = trials.map((t) => t.winRate).filter((v) => Number.isFinite(v));
  const trialExpectancies = trials.map((t) => t.expectancyR).filter((v) => Number.isFinite(v));
  const trialNs = trials.map((t) => t.n);

  const realWinRatePct = grossOverall.winRate * 100;
  const realExpectancyR = grossOverall.expectancyR;
  const winRatePercentile = percentileRankOf(realWinRatePct, trialWinRates.map((r) => r * 100));
  const expectancyPercentile = percentileRankOf(realExpectancyR, trialExpectancies);

  log(`${PERMUTATION_TRIALS} trials, seed=${PERMUTATION_SEED}. Trial n ranges ${Math.min(...trialNs)}-${Math.max(...trialNs)} trades (real system, gross: n=${grossOverall.sampleSize}).`);
  log(
    `Random-baseline win rate: mean=${pct(mean(trialWinRates) * 100)} min=${pct(Math.min(...trialWinRates) * 100)} max=${pct(Math.max(...trialWinRates) * 100)}`,
  );
  log(
    `Random-baseline E[R]:     mean=${num(mean(trialExpectancies))} min=${num(Math.min(...trialExpectancies))} max=${num(Math.max(...trialExpectancies))}`,
  );
  log(`Real system's gross win rate (${pct(realWinRatePct)}) sits at percentile ${num(winRatePercentile, 1)} of the ${PERMUTATION_TRIALS} random trials.`);
  log(`Real system's gross E[R] (${num(realExpectancyR)}) sits at percentile ${num(expectancyPercentile, 1)} of the ${PERMUTATION_TRIALS} random trials.`);
  log(
    "A percentile near 50 means the pattern's directional call is statistically indistinguishable from a coin flip at these same moments; near 0 or 100 would mean it's notably worse or better than random.",
  );
  log("");

  // --- Step 4: where is it bad ----------------------------------------
  log("=== Step 4: uniform or concentrated? (real costs, canonical scenario: slip=1t, lower bound, limit-tp fee) ===");
  const canonicalRun = runScenario(prepared, spec, CANONICAL_CONFIG);
  const canonicalTrades = canonicalRun.trades;
  const canonicalMetrics = computeMetrics(canonicalTrades, STARTING_EQUITY_USDT, {
    ignoredCount: canonicalRun.ignoredTs.length,
    skippedSizingCount: canonicalRun.skippedSizingTs.length,
    stillOpenCount: canonicalRun.stillOpenTs.length,
  });

  const yearly = groupBy(canonicalTrades, (t) => String(new Date(t.entryTs).getUTCFullYear()));
  printGroupTable("By year:", yearly, log);

  const bySide = groupBy(canonicalTrades, (t) => t.side);
  printGroupTable("By side:", bySide, log);

  const slPctSorted = canonicalTrades.map((t) => t.slPct).sort((a, b) => a - b);
  const q1 = percentile(slPctSorted, 25);
  const q2 = percentile(slPctSorted, 50);
  const q3 = percentile(slPctSorted, 75);
  const quartileLabel = (slPct: number): string => {
    if (slPct <= q1) return "Q1 (tightest SL)";
    if (slPct <= q2) return "Q2";
    if (slPct <= q3) return "Q3";
    return "Q4 (widest SL)";
  };
  const byQuartile = groupBy(canonicalTrades, (t) => quartileLabel(t.slPct));
  log(`SL-distance quartile breakpoints: p25=${(q1 * 100).toFixed(3)}% p50=${(q2 * 100).toFixed(3)}% p75=${(q3 * 100).toFixed(3)}%`);
  printGroupTable("By SL-distance quartile:", byQuartile, log);

  const byHour = groupBy(canonicalTrades, (t) => String(new Date(t.entryTs).getUTCHours()).padStart(2, "0") + ":00 UTC");
  printGroupTable("By entry hour of day (UTC):", byHour, log);

  log(
    "If negative expectancy is spread evenly across all of the above, that means no edge anywhere - not a regime, side, stop-width, or session effect. If it's concentrated in specific group(s), that's reported above and NOT acted on (no filter has been built from this).",
  );
  log("");

  log(`Total diagnosis time: ${Date.now() - t0}ms`);

  const reportPath = path.join(DATA_DIR, "diagnosis-report.txt");
  writeFileSync(reportPath, report.join("\n") + "\n");
  console.log(`Report written to ${reportPath}`);

  const jsonPath = path.join(DATA_DIR, "diagnosis-results.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        gross: { overall: grossOverall, inSample: grossSplit.inSample, outOfSample: grossSplit.outOfSample },
        permutation: {
          trials: PERMUTATION_TRIALS,
          seed: PERMUTATION_SEED,
          trialWinRates,
          trialExpectancies,
          realWinRatePct,
          realExpectancyR,
          winRatePercentile,
          expectancyPercentile,
        },
        canonical: { overall: canonicalMetrics, byYear: yearly, bySide, byQuartile, byHour, quartileBreakpoints: { q1, q2, q3 } },
      },
      null,
      2,
    ),
  );
  console.log(`Full data written to ${jsonPath}`);
}

main();
