import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle } from "./types.js";
import { validateCandles, type ValidationReport } from "./dataIntegrity.js";

const INST_ID = "DOT-USDT-SWAP";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const MAX_LISTED = 50;

function intervalMsFor(bar: "5m" | "1m"): number {
  switch (bar) {
    case "5m":
      return 5 * 60_000;
    case "1m":
      return 60_000;
  }
}

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

function printReport(bar: string, report: ValidationReport): void {
  console.log(`\n=== ${bar}: ${report.candleCount} candles ===`);

  console.log(`duplicate timestamps: ${report.duplicates.length}`);
  for (const d of report.duplicates.slice(0, MAX_LISTED)) {
    console.log(`  ts=${new Date(d.ts).toISOString()} count=${d.count}`);
  }

  console.log(`out-of-order: ${report.outOfOrder.length}`);
  for (const o of report.outOfOrder.slice(0, MAX_LISTED)) {
    console.log(
      `  index=${o.index} prevTs=${new Date(o.prevTs).toISOString()} ts=${new Date(o.ts).toISOString()}`,
    );
  }

  console.log(`OHLC violations: ${report.ohlcViolations.length}`);
  for (const v of report.ohlcViolations.slice(0, MAX_LISTED)) {
    console.log(`  ts=${new Date(v.ts).toISOString()} ${v.reason}`);
  }

  const missingTotal = report.gaps.reduce((sum, g) => sum + g.missingCount, 0);
  console.log(`gaps: ${report.gaps.length} (${missingTotal} candles missing in total)`);
  for (const g of report.gaps.slice(0, MAX_LISTED)) {
    console.log(
      `  ${new Date(g.afterTs).toISOString()} -> ${new Date(g.beforeTs).toISOString()} (${g.missingCount} missing)`,
    );
  }
  if (report.gaps.length > MAX_LISTED) {
    console.log(`  ... ${report.gaps.length - MAX_LISTED} more gaps not shown`);
  }
}

function main(): void {
  for (const bar of ["5m", "1m"] as const) {
    let candles: Candle[];
    try {
      candles = loadCandles(bar);
    } catch {
      console.log(`\n=== ${bar}: no data file, skipping ===`);
      continue;
    }
    const report = validateCandles(candles, intervalMsFor(bar));
    printReport(bar, report);
  }
}

main();
