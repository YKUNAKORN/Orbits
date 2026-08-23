import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, type Candle, type Signal } from "./types.js";
import { computeSignal, SIGNAL_MIN_WARMUP_BARS } from "./signal.js";
import { splitIntoContiguousSegments } from "./dataIntegrity.js";

const INST_ID = "DOT-USDT-SWAP";
const FIVE_MIN_MS = 5 * 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

function percentile(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return at(sorted, lo);
  const frac = idx - lo;
  return at(sorted, lo) + (at(sorted, hi) - at(sorted, lo)) * frac;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function generateSignals(segment: readonly Candle[]): Signal[] {
  const signals: Signal[] = [];
  for (let i = 0; i < segment.length; i++) {
    const start = Math.max(0, i - SIGNAL_MIN_WARMUP_BARS + 1);
    const window = segment.slice(start, i + 1);
    const signal = computeSignal(window);
    if (signal) signals.push(signal);
  }
  return signals;
}

interface ResolvedTrade {
  signal: Signal;
  exit: "tp" | "sl";
}

interface SimulationResult {
  resolved: ResolvedTrade[];
  stillOpen: Signal | null;
  ignoredCount: number;
}

// Entry fills at bar0's close, so the exit scan starts at bar0+1 - using
// bar0's own high/low would score an exit against price action that
// happened before the fill. Runs within a single contiguous segment only:
// a position still open when the segment ends (a gap follows) is unresolved,
// not carried across data we don't have.
function simulateOnePositionAtATime(
  segment: readonly Candle[],
  signals: readonly Signal[],
): SimulationResult {
  const tsToIndex = new Map<number, number>();
  segment.forEach((c, i) => tsToIndex.set(c.ts, i));

  const resolved: ResolvedTrade[] = [];
  let stillOpen: Signal | null = null;
  let ignoredCount = 0;
  let nextAvailableIndex = 0;

  for (const signal of signals) {
    const signalIndex = tsToIndex.get(signal.time);
    if (signalIndex === undefined) continue;
    if (signalIndex < nextAvailableIndex) {
      ignoredCount += 1;
      continue;
    }

    let exit: "tp" | "sl" | null = null;
    let exitIndex = -1;
    for (let i = signalIndex + 1; i < segment.length; i++) {
      const bar = at(segment, i);
      const hitSl = signal.side === "long" ? bar.low <= signal.sl : bar.high >= signal.sl;
      const hitTp = signal.side === "long" ? bar.high >= signal.tp : bar.low <= signal.tp;
      if (hitSl) {
        exit = "sl";
        exitIndex = i;
        break;
      }
      if (hitTp) {
        exit = "tp";
        exitIndex = i;
        break;
      }
    }

    if (exit) {
      resolved.push({ signal, exit });
      nextAvailableIndex = exitIndex; // closed out on this bar; its own close can open the next signal
    } else {
      stillOpen = signal;
      break; // ran out of segment before this position resolved
    }
  }

  return { resolved, stillOpen, ignoredCount };
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

  const segments = splitIntoContiguousSegments(candles, FIVE_MIN_MS);
  const gapCount = segments.length - 1;
  console.log(`${segments.length} contiguous segment(s) (${gapCount} gap(s) split the data)`);

  const signals: Signal[] = [];
  const resolved: ResolvedTrade[] = [];
  let stillOpenCount = 0;
  let ignoredCount = 0;

  for (const segment of segments) {
    const segmentSignals = generateSignals(segment);
    signals.push(...segmentSignals);
    if (segmentSignals.length === 0) continue;
    const sim = simulateOnePositionAtATime(segment, segmentSignals);
    resolved.push(...sim.resolved);
    if (sim.stillOpen) stillOpenCount += 1;
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
    console.log(`  resolved by TP: ${resolved.filter((r) => r.exit === "tp").length}`);
    console.log(`  resolved by SL: ${resolved.filter((r) => r.exit === "sl").length}`);
    if (stillOpenCount > 0) {
      console.log(`  still open at end of a segment (unresolved): ${stillOpenCount}`);
    }
    console.log(
      "  Note: touch-based check on 5m highs/lows only - no fees, no slippage, no 1m refinement. Phase 2 scope, not final P&L.",
    );
  }
}

main();
