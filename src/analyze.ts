import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, FIVE_MIN_MS, type Candle, type Signal } from "./types.js";
import { splitIntoContiguousSegments } from "./dataIntegrity.js";
import { generateSignals } from "./signalScan.js";
import { sequenceTrades } from "./tradeSequencer.js";
import { loadInstrumentSpec } from "./instrumentSpec.js";
import { percentile, monthKey } from "./stats.js";

const INST_ID = "DOT-USDT-SWAP";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

function main(): void {
  const candles = loadCandles("5m");
  if (candles.length === 0) {
    console.log("No 5m candles found in data/. Run fetch-data first.");
    return;
  }
  const first = at(candles, 0);
  const last = at(candles, candles.length - 1);
  console.log(
    `Loaded ${candles.length} 5m candles: ${new Date(first.ts).toISOString()} -> ${new Date(last.ts).toISOString()}`,
  );

  const spec = loadInstrumentSpec(INST_ID);
  const segments = splitIntoContiguousSegments(candles, FIVE_MIN_MS);
  const gapCount = segments.length - 1;
  console.log(`${segments.length} contiguous segment(s) (${gapCount} gap(s) split the data)`);

  const signals: Signal[] = [];
  const resolved: { signal: Signal; outcome: "tp" | "sl" | "ambiguous" }[] = [];
  let stillOpenCount = 0;
  let ignoredCount = 0;

  for (const segment of segments) {
    const segmentSignals = generateSignals(segment);
    signals.push(...segmentSignals);
    if (segmentSignals.length === 0) continue;
    const sim = sequenceTrades(segment, segmentSignals, spec.tickSz);
    for (const trade of sim.trades) {
      if (trade.outcome === "open") {
        stillOpenCount += 1;
      } else {
        resolved.push({ signal: trade.signal, outcome: trade.outcome });
      }
    }
    ignoredCount += sim.ignoredCount;
  }

  console.log("\n=== 1. Signal counts ===");
  if (signals.length === 0) {
    console.log("No signals found in this dataset.");
  } else {
    const longCount = signals.filter((s) => s.side === "long").length;
    const shortCount = signals.filter((s) => s.side === "short").length;
    console.log(`Total: ${signals.length} (long ${longCount}, short ${shortCount})`);

    const byMonth = new Map<string, { long: number; short: number }>();
    for (const s of signals) {
      const key = monthKey(s.time);
      const bucket = byMonth.get(key) ?? { long: 0, short: 0 };
      if (s.side === "long") bucket.long += 1;
      else bucket.short += 1;
      byMonth.set(key, bucket);
    }
    console.log("By month (UTC):");
    for (const [key, v] of [...byMonth.entries()].sort()) {
      console.log(`  ${key}: long ${v.long}, short ${v.short}, total ${v.long + v.short}`);
    }
  }

  console.log("\n=== 2. SL distance as % of entry ===");
  if (signals.length === 0) {
    console.log("N/A - no signals.");
  } else {
    const slPct = signals.map((s) => Math.abs(s.entry - s.sl) / s.entry).sort((a, b) => a - b);
    console.log(`n=${slPct.length}`);
    console.log(`  min:    ${(at(slPct, 0) * 100).toFixed(3)}%`);
    console.log(`  p10:    ${(percentile(slPct, 10) * 100).toFixed(3)}%`);
    console.log(`  median: ${(percentile(slPct, 50) * 100).toFixed(3)}%`);
    console.log(`  p90:    ${(percentile(slPct, 90) * 100).toFixed(3)}%`);
    console.log(`  max:    ${(at(slPct, slPct.length - 1) * 100).toFixed(3)}%`);
  }

  console.log("\n=== 3. Signals surviving the one-position-at-a-time rule ===");
  if (signals.length === 0) {
    console.log("N/A - no signals.");
  } else {
    const survivedCount = resolved.length + stillOpenCount;
    console.log(
      `${survivedCount} survive out of ${signals.length} raw signals (${ignoredCount} ignored while a position was open)`,
    );
    const tpCount = resolved.filter((r) => r.outcome === "tp").length;
    const slCount = resolved.filter((r) => r.outcome === "sl").length;
    const ambiguousCount = resolved.filter((r) => r.outcome === "ambiguous").length;
    console.log(`  resolved by TP (cleared by >=1 tick): ${tpCount}`);
    console.log(`  resolved by SL (touch): ${slCount}`);
    console.log(
      `  ambiguous (both TP and SL touched in the same bar): ${ambiguousCount} (${((ambiguousCount / resolved.length) * 100).toFixed(2)}% of resolved)`,
    );
    if (stillOpenCount > 0) {
      console.log(`  still open at end of a segment (unresolved): ${stillOpenCount}`);
    }
    console.log(
      "  Note: touch/tick check on 5m highs/lows only - no fees, no slippage, no 1m refinement. Phase 2 scope, not final P&L.",
    );
  }
}

main();
