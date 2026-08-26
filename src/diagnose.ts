import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, type Candle, type Signal } from "./types.js";
import { loadInstrumentSpec } from "./instrumentSpec.js";
import { num, pct, usd } from "./format.js";
import { mean, percentile } from "./stats.js";
import { computeFixedRiskPositionSize, computePositionSize } from "./positionSizing.js";
import {
  computeMetrics,
  computeSplitTs,
  prepareData,
  runScenario,
  splitMetrics,
  type BacktestConfig,
  type ClosedTrade,
  type SizingFn,
} from "./backtestEngine.js";
import { aggregateAnchorValidity, ANCHOR_VALIDITY_MIN_PCT, mulberry32, percentileRankOf, runRandomTimingTrials } from "./randomBaseline.js";
import { barIntervalMs, isBar, SUPPORTED_BARS, type Bar } from "./barInterval.js";

const INST_ID = "DOT-USDT-SWAP";
const DEFAULT_BAR: Bar = "5m";
const STARTING_EQUITY_USDT = 100;
const DEFAULT_PERMUTATION_TRIALS = 100;
const PERMUTATION_SEED = 20260824; // fixed: reruns reproduce the same trials regardless of trial count or timeframe
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
  computeSize: computePositionSize,
};
const GROSS_CONFIG: BacktestConfig = {
  startingEquityUsdt: STARTING_EQUITY_USDT,
  slippageTicks: 0,
  ambiguousBound: "lower",
  feeModel: "limit-tp",
  takerFeeRate: 0,
  makerFeeRate: 0,
  fundingRateForCost: null,
  computeSize: computePositionSize,
};
// Fixed-risk sizing (positionSizing.ts), used only as the comparator for
// Step 3's permutation test below, so the real system's numbers and the
// null's trials are sized the same way - equity compounding would let a
// trial's own losing streak shrink its sizing and silently drop later
// draws, exactly the truncated-sample problem that mode exists to avoid.
// Deliberately separate from GROSS_CONFIG above: Step 2's headline gross
// number stays on the frozen spec's compounding sizing, unchanged.
const fixedRiskComputeSize: SizingFn = ({ entry, sl, spec }) => computeFixedRiskPositionSize({ entry, sl, spec });
const GROSS_FIXED_RISK_CONFIG: BacktestConfig = {
  startingEquityUsdt: STARTING_EQUITY_USDT,
  slippageTicks: 0,
  ambiguousBound: "lower",
  feeModel: "limit-tp",
  takerFeeRate: 0,
  makerFeeRate: 0,
  fundingRateForCost: null,
  computeSize: fixedRiskComputeSize,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

interface Cli {
  bar: Bar;
  trials: number;
}

function parseArgs(argv: readonly string[]): Cli {
  let bar: Bar = DEFAULT_BAR;
  let trials = DEFAULT_PERMUTATION_TRIALS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bar") {
      const value = argv[i + 1];
      if (value === undefined || !isBar(value)) {
        throw new Error(`--bar must be one of: ${SUPPORTED_BARS.join(", ")} (got ${String(value)})`);
      }
      bar = value;
      i += 1;
    } else if (arg === "--trials") {
      const value = argv[i + 1];
      const n = value === undefined ? NaN : Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--trials must be a positive integer (got ${String(value)})`);
      }
      trials = n;
      i += 1;
    }
  }
  return { bar, trials };
}

// The 5m outputs keep their original, unsuffixed filenames (Phase 2's
// already-completed artifact) - every other timeframe gets its own
// bar-suffixed files so a Phase 2b run never overwrites Phase 2's report.
function outputFileName(base: string, ext: string, bar: Bar): string {
  return bar === "5m" ? `${base}.${ext}` : `${base}-${bar}.${ext}`;
}

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

// --- Step 1: export a manually-checkable sample -----------------------

function exportRandomDaysCsv(allSignals: readonly Signal[], bar: Bar, log: (line?: string) => void): void {
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
  const file = path.join(DATA_DIR, outputFileName("signal-sample-3days", "csv", bar));
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

  const { bar, trials: trialCount } = parseArgs(process.argv.slice(2));
  const spec = loadInstrumentSpec(INST_ID);
  const candles = loadCandles(bar);
  if (candles.length === 0) {
    console.log(`No ${bar} candles found in data/. Run fetch-data first.`);
    return;
  }

  log(`=== ${bar} diagnosis: gross expectancy, permutation test, breakdowns ===`);
  log("Root-cause investigation only - CLAUDE.md section 4 (bodyRatio, RR, EMA periods, strong-candle test) is untouched.");
  log("");

  const t0 = Date.now();
  const prepared = prepareData(candles, spec, barIntervalMs(bar));
  log(`Prepared ${prepared.totalSignalCount} raw signals over ${prepared.segments.length} segment(s) in ${Date.now() - t0}ms`);
  log("");

  const allRawSignals = prepared.signalsBySegment.flat();
  exportRandomDaysCsv(allRawSignals, bar, log);

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

  // --- Step 3: random-ENTRY-TIMING baseline (permutation test) ---------
  // Redesigned per the auditor's finding on the previous (direction-flip)
  // null: reusing each real anchor's own bar2/bar0 and re-drawing only
  // long-vs-short made the "opposite direction" geometrically degenerate at
  // essentially every anchor after three consecutive strong candles
  // (auditor-measured 0.345% valid on 5m), so each trial was close to a
  // random ~50% subsample of the system's OWN trades, not a coin-flip
  // baseline - see randomBaseline.ts's module comment for the full
  // mechanism. This null instead holds the real long/short ratio and trade
  // count fixed and randomizes WHICH BAR is the signal bar.
  log("=== Step 3: random-entry-timing baseline (permutation test) ===");
  log(
    "Same real long/short ratio and trade count, same entry/SL/TP construction formula, same one-position-at-a-time rule, same engine (runScenario), fixed-risk sizing (positionSizing.ts, not compounding - a trial's own losing streak must not shrink its sizing and drop later draws). The thing randomized is WHICH BAR is the signal bar, drawn uniformly without replacement from the same warm-up-eligible universe real signals come from. Fee=0/slippage=0/funding=0. Question: does the pattern's chosen timing beat the same long/short mix at random moments?",
  );

  const grossFixedRiskRun = runScenario(prepared, spec, GROSS_FIXED_RISK_CONFIG);
  const grossFixedRiskOverall = computeMetrics(grossFixedRiskRun.trades, STARTING_EQUITY_USDT, {
    ignoredCount: grossFixedRiskRun.ignoredTs.length,
    skippedSizingCount: grossFixedRiskRun.skippedSizingTs.length,
    stillOpenCount: grossFixedRiskRun.stillOpenTs.length,
  });
  log(
    `Real system, gross, fixed-risk sizing (this test's comparator - differs from Step 2's compounding gross number above, which stays on the frozen spec's sizing): n=${grossFixedRiskOverall.sampleSize}  win=${pct(grossFixedRiskOverall.winRate * 100)}  E[R]=${num(grossFixedRiskOverall.expectancyR)}`,
  );

  const trials = runRandomTimingTrials(prepared, spec, STARTING_EQUITY_USDT, trialCount, PERMUTATION_SEED);

  const validity = aggregateAnchorValidity(trials);
  const validityOk = validity.pct >= ANCHOR_VALIDITY_MIN_PCT;
  log(
    `Anchor validity: ${validity.valid} / ${validity.attempted} random anchors produced a real (non-degenerate) signal (${pct(validity.pct)}). Gate: >= ${ANCHOR_VALIDITY_MIN_PCT}% required to trust this null - ${validityOk ? "PASSES" : "FAILS"}.`,
  );
  if (!validityOk) {
    log(
      `*** NULL INVALID: anchor validity is below the ${ANCHOR_VALIDITY_MIN_PCT}% gate. Every number below this line is still computed and written to the JSON output for the record, but must NOT be read as a valid random-timing comparison. Stop and escalate before drawing any conclusion from it. ***`,
    );
  }

  const trialWinRates = trials.map((t) => t.winRate).filter((v) => Number.isFinite(v));
  const trialExpectancies = trials.map((t) => t.expectancyR).filter((v) => Number.isFinite(v));
  const trialNs = trials.map((t) => t.n);

  const realWinRatePct = grossFixedRiskOverall.winRate * 100;
  const realExpectancyR = grossFixedRiskOverall.expectancyR;
  const winRatePercentile = percentileRankOf(realWinRatePct, trialWinRates.map((r) => r * 100));
  const expectancyPercentile = percentileRankOf(realExpectancyR, trialExpectancies);

  log(
    `${trialCount} trials, seed=${PERMUTATION_SEED}. Trial n ranges ${Math.min(...trialNs)}-${Math.max(...trialNs)} trades (real system, gross fixed-risk: n=${grossFixedRiskOverall.sampleSize}).`,
  );
  log(
    `Random-timing win rate: mean=${pct(mean(trialWinRates) * 100)} min=${pct(Math.min(...trialWinRates) * 100)} max=${pct(Math.max(...trialWinRates) * 100)}`,
  );
  log(
    `Random-timing E[R]:     mean=${num(mean(trialExpectancies))} min=${num(Math.min(...trialExpectancies))} max=${num(Math.max(...trialExpectancies))}`,
  );
  log(
    `Real system's gross win rate (${pct(realWinRatePct)}) sits at percentile ${num(winRatePercentile, 1)} of the ${trialCount} random-timing trials.`,
  );
  log(`Real system's gross E[R] (${num(realExpectancyR)}) sits at percentile ${num(expectancyPercentile, 1)} of the ${trialCount} random-timing trials.`);
  log(
    "A percentile near 50 means the pattern's chosen timing is statistically indistinguishable from trading the same long/short mix at random moments; near 100 means the pattern's timing beats random, near 0 that it's worse.",
  );

  // Phase 2b (docs/hypothesis-2b.md) criterion 3 is the raw 95th percentile
  // of this timeframe's own null. The Bonferroni line is the required
  // multiple-testing disclosure for testing 4 timeframes (family alpha 0.05
  // / 4 = 0.0125 per-test, i.e. the 98.75th percentile) - reported
  // alongside, not substituted for, the pre-registered 95th-percentile bar.
  const BONFERRONI_TEST_COUNT = 4; // 5m + 15m + 1H + 4H, per docs/hypothesis-2b.md
  const bonferroniPercentileBar = 100 - 5 / BONFERRONI_TEST_COUNT; // 98.75
  const sortedWinRatesPct = [...trialWinRates].map((r) => r * 100).sort((a, b) => a - b);
  const winRateAt95th = percentile(sortedWinRatesPct, 95);
  const winRateAtBonferroniBar = percentile(sortedWinRatesPct, bonferroniPercentileBar);
  log(
    `Raw 95th-percentile bar: ${pct(winRateAt95th)}. Real gross win rate ${realWinRatePct >= winRateAt95th ? "CLEARS" : "does not clear"} it.`,
  );
  log(
    `Bonferroni-adjusted bar for ${BONFERRONI_TEST_COUNT} timeframes (${num(bonferroniPercentileBar, 2)}th percentile): ${pct(winRateAtBonferroniBar)}. Real gross win rate ${realWinRatePct >= winRateAtBonferroniBar ? "still clears" : "does not clear"} it.`,
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

  const reportPath = path.join(DATA_DIR, outputFileName("diagnosis-report", "txt", bar));
  writeFileSync(reportPath, report.join("\n") + "\n");
  console.log(`Report written to ${reportPath}`);

  const jsonPath = path.join(DATA_DIR, outputFileName("diagnosis-results", "json", bar));
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        bar,
        gross: { overall: grossOverall, inSample: grossSplit.inSample, outOfSample: grossSplit.outOfSample },
        permutation: {
          nullDesign: "random-entry-timing",
          trials: trialCount,
          seed: PERMUTATION_SEED,
          anchorValidity: validity,
          anchorValidityMinPct: ANCHOR_VALIDITY_MIN_PCT,
          anchorValidityPasses: validityOk,
          grossFixedRiskOverall,
          trialWinRates,
          trialExpectancies,
          realWinRatePct,
          realExpectancyR,
          winRatePercentile,
          expectancyPercentile,
          bonferroniTestCount: BONFERRONI_TEST_COUNT,
          bonferroniPercentileBar,
          winRateAt95th,
          winRateAtBonferroniBar,
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
