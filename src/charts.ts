import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { at, FIVE_MIN_MS, type Candle } from "./types.js";
import { loadInstrumentSpec } from "./instrumentSpec.js";
import { computeMetrics, computeSplitTs, prepareData, runScenario, type BacktestConfig, type ClosedTrade } from "./backtestEngine.js";
import { addLine, addPolyline, addRect, addText, createCanvas, linearScale, plotArea, render } from "./svg.js";

const INST_ID = "DOT-USDT-SWAP";
const STARTING_EQUITY_USDT = 100;
const CANONICAL_CONFIG: BacktestConfig = {
  startingEquityUsdt: STARTING_EQUITY_USDT,
  slippageTicks: 1,
  ambiguousBound: "lower",
  feeModel: "limit-tp",
  takerFeeRate: 0.0005,
  makerFeeRate: 0.0002,
  fundingRateForCost: null,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function loadCandles(bar: string): Candle[] {
  const raw = readFileSync(path.join(DATA_DIR, `${INST_ID}-${bar}.json`), "utf8");
  return JSON.parse(raw) as Candle[];
}

function writeChart(filename: string, svg: string): void {
  const file = path.join(DATA_DIR, filename);
  writeFileSync(file, svg);
  console.log(`Wrote ${file}`);
}

// --- Chart 1: equity curve, log scale, in-sample/out-of-sample marked ---

function equityCurveChart(trades: readonly ClosedTrade[], startTs: number, splitTs: number): string {
  const width = 1100;
  const height = 520;
  const c = createCanvas(width, height, { top: 50, right: 40, bottom: 60, left: 80 });
  const { x0, y0, x1, y1 } = plotArea(c);

  const points: { ts: number; equity: number }[] = [{ ts: startTs, equity: STARTING_EQUITY_USDT }];
  for (const t of trades) points.push({ ts: t.exitTs, equity: t.equityAfter });
  const firstPoint = at(points, 0);
  const lastPoint = at(points, points.length - 1);

  const minEquity = Math.max(1e-6, Math.min(...points.map((p) => p.equity)));
  const maxEquity = Math.max(...points.map((p) => p.equity));
  const yMin = Math.floor(Math.log10(minEquity)) - 0.2;
  const yMax = Math.ceil(Math.log10(maxEquity)) + 0.1;

  const xScale = linearScale([firstPoint.ts, lastPoint.ts], [x0, x1]);
  const yScale = linearScale([yMin, yMax], [y1, y0]); // inverted: higher equity -> smaller y pixel

  // Axes
  addLine(c, x0, y0, x0, y1, { stroke: "#888" });
  addLine(c, x0, y1, x1, y1, { stroke: "#888" });

  // Y gridlines at each power of 10 in range
  for (let p = Math.ceil(yMin); p <= Math.floor(yMax); p++) {
    const y = yScale(p);
    addLine(c, x0, y, x1, y, { stroke: "#eee" });
    addText(c, x0 - 8, y + 4, `${p >= 0 ? "" : ""}${(10 ** p).toLocaleString(undefined, { maximumFractionDigits: p < 0 ? -p : 0 })}`, {
      anchor: "end",
      size: 10,
    });
  }
  addText(c, 20, (y0 + y1) / 2, "Equity (USDT, log scale)", { size: 11, rotate: -90 });

  // X ticks: yearly
  const startYear = new Date(firstPoint.ts).getUTCFullYear();
  const endYear = new Date(lastPoint.ts).getUTCFullYear();
  for (let yr = startYear; yr <= endYear; yr++) {
    const ts = Date.UTC(yr, 0, 1);
    if (ts < firstPoint.ts || ts > lastPoint.ts) continue;
    const x = xScale(ts);
    addLine(c, x, y1, x, y1 + 5, { stroke: "#888" });
    addText(c, x, y1 + 18, String(yr), { anchor: "middle", size: 10 });
  }

  // Split marker
  const splitX = xScale(splitTs);
  addLine(c, splitX, y0, splitX, y1, { stroke: "#c0392b", width: 1.5, dash: "5,4" });
  addText(c, splitX + 6, y0 + 14, "in-sample / out-of-sample split", { size: 10, fill: "#c0392b" });

  // Curve, split into in-sample (blue) / out-of-sample (orange) segments
  const inSamplePts: [number, number][] = [];
  const outSamplePts: [number, number][] = [];
  for (const p of points) {
    const xy: [number, number] = [xScale(p.ts), yScale(Math.log10(Math.max(p.equity, 10 ** yMin)))];
    if (p.ts <= splitTs) {
      inSamplePts.push(xy);
    } else {
      // Anchor the out-of-sample line to the last in-sample point so the
      // two segments join with no visual gap at the split.
      if (outSamplePts.length === 0 && inSamplePts.length > 0) outSamplePts.push(at(inSamplePts, inSamplePts.length - 1));
      outSamplePts.push(xy);
    }
  }
  addPolyline(c, inSamplePts, { stroke: "#1f6feb", width: 1.5 });
  addPolyline(c, outSamplePts, { stroke: "#e67e22", width: 1.5 });

  addLine(c, x1 - 140, y0 + 4, x1 - 120, y0 + 4, { stroke: "#1f6feb", width: 2 });
  addText(c, x1 - 115, y0 + 8, "in-sample", { size: 10 });
  addLine(c, x1 - 140, y0 + 20, x1 - 120, y0 + 20, { stroke: "#e67e22", width: 2 });
  addText(c, x1 - 115, y0 + 24, "out-of-sample", { size: 10 });

  addText(c, width / 2, height - 8, `Starting equity ${STARTING_EQUITY_USDT} USDT, 2% risk per trade, compounding. Canonical scenario (slip=1t, lower bound, limit-tp fee).`, {
    anchor: "middle",
    size: 10,
    fill: "#555",
  });

  return render(c, "Equity curve - DOT-USDT-SWAP 5m (Phase 2, canonical scenario)");
}

// --- Chart 2: R-multiple histogram ---

function rMultipleHistogram(trades: readonly ClosedTrade[]): string {
  const width = 900;
  const height = 480;
  const c = createCanvas(width, height, { top: 50, right: 30, bottom: 60, left: 60 });
  const { x0, y0, x1, y1 } = plotArea(c);

  const rValues = trades.map((t) => t.rMultiple);
  const binWidth = 0.25;
  const minR = Math.floor(Math.min(...rValues) / binWidth) * binWidth;
  const maxR = Math.ceil(Math.max(...rValues) / binWidth) * binWidth;
  const binCount = Math.round((maxR - minR) / binWidth);
  const counts = new Array<number>(binCount).fill(0);
  for (const r of rValues) {
    let idx = Math.floor((r - minR) / binWidth);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  const maxCount = Math.max(...counts);

  const xScale = linearScale([minR, maxR], [x0, x1]);
  const yScale = linearScale([0, maxCount], [y1, y0]);

  addLine(c, x0, y0, x0, y1, { stroke: "#888" });
  addLine(c, x0, y1, x1, y1, { stroke: "#888" });

  for (let g = 0; g <= maxCount; g += Math.max(1, Math.ceil(maxCount / 6))) {
    const y = yScale(g);
    addLine(c, x0, y, x1, y, { stroke: "#eee" });
    addText(c, x0 - 8, y + 4, String(g), { anchor: "end", size: 10 });
  }
  addText(c, 16, (y0 + y1) / 2, "Trade count", { size: 11, rotate: -90 });

  for (let i = 0; i < binCount; i++) {
    const binStart = minR + i * binWidth;
    const xA = xScale(binStart);
    const xB = xScale(binStart + binWidth);
    const count = counts[i] ?? 0;
    const isLoss = binStart + binWidth / 2 < 0;
    addRect(c, xA + 0.5, yScale(count), xB - xA - 1, y1 - yScale(count), { fill: isLoss ? "#c0392b" : "#27ae60" });
  }

  // Zero line and integer R gridlines
  for (let r = Math.ceil(minR); r <= Math.floor(maxR); r++) {
    const x = xScale(r);
    addLine(c, x, y0, x, y1, { stroke: r === 0 ? "#333" : "#eee", width: r === 0 ? 1.2 : 1 });
    addText(c, x, y1 + 16, `${r}R`, { anchor: "middle", size: 10 });
  }

  addText(c, width / 2, height - 8, `n=${trades.length} closed trades. Canonical scenario (slip=1t, lower bound, limit-tp fee), net of fees and slippage.`, {
    anchor: "middle",
    size: 10,
    fill: "#555",
  });

  return render(c, "R-multiple distribution - DOT-USDT-SWAP 5m (Phase 2)");
}

// --- Chart 3: monthly win rate vs zero-cost and real break-even lines ---

function monthlyWinRateChart(trades: readonly ClosedTrade[], breakEvenWinRate: number): string {
  const width = 1200;
  const height = 480;
  const c = createCanvas(width, height, { top: 50, right: 160, bottom: 70, left: 60 });
  const { x0, y0, x1, y1 } = plotArea(c);

  const byMonth = new Map<string, { n: number; wins: number }>();
  for (const t of trades) {
    const d = new Date(t.entryTs);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const bucket = byMonth.get(key) ?? { n: 0, wins: 0 };
    bucket.n += 1;
    if (t.netPnlUsdt > 0) bucket.wins += 1;
    byMonth.set(key, bucket);
  }
  const months = [...byMonth.keys()].sort();

  const xScale = linearScale([0, months.length], [x0, x1]);
  const yScale = linearScale([0, 100], [y1, y0]);

  addLine(c, x0, y0, x0, y1, { stroke: "#888" });
  addLine(c, x0, y1, x1, y1, { stroke: "#888" });
  for (let g = 0; g <= 100; g += 20) {
    const y = yScale(g);
    addLine(c, x0, y, x1, y, { stroke: "#eee" });
    addText(c, x0 - 8, y + 4, `${g}%`, { anchor: "end", size: 10 });
  }
  addText(c, 16, (y0 + y1) / 2, "Monthly win rate", { size: 11, rotate: -90 });

  const breakEvenWinRatePct = breakEvenWinRate * 100;
  const barWidth = Math.max(1, (x1 - x0) / months.length - 1);
  months.forEach((key, i) => {
    const bucket = byMonth.get(key) ?? { n: 0, wins: 0 };
    const winRate = bucket.n > 0 ? (bucket.wins / bucket.n) * 100 : 0;
    const x = xScale(i) + 0.5;
    addRect(c, x, yScale(winRate), barWidth, y1 - yScale(winRate), { fill: winRate >= breakEvenWinRatePct ? "#27ae60" : "#9aa5b1" });
  });

  months.forEach((key, i) => {
    if (i % 6 !== 0) return;
    const x = xScale(i) + barWidth / 2;
    addLine(c, x, y1, x, y1 + 4, { stroke: "#888" });
    addText(c, x, y1 + 30, key, { anchor: "middle", size: 9, rotate: -55 });
  });

  const zeroCostY = yScale(100 / 3);
  addLine(c, x0, zeroCostY, x1, zeroCostY, { stroke: "#2980b9", width: 1.5, dash: "6,3" });
  addText(c, x1 + 6, zeroCostY + 4, "33.3% (zero-cost b/e at 2:1 RR)", { size: 10, fill: "#2980b9" });

  const realY = yScale(breakEvenWinRate * 100);
  addLine(c, x0, realY, x1, realY, { stroke: "#c0392b", width: 1.5, dash: "6,3" });
  addText(c, x1 + 6, realY + 4, `${(breakEvenWinRate * 100).toFixed(1)}% (real break-even, at cost)`, { size: 10, fill: "#c0392b" });

  addText(c, width / 2, height - 8, "Bars: monthly win rate, canonical scenario. Green = at/above the real (cost-inclusive) break-even that month.", {
    anchor: "middle",
    size: 10,
    fill: "#555",
  });

  return render(c, "Monthly win rate vs. break-even - DOT-USDT-SWAP 5m (Phase 2)");
}

function main(): void {
  const spec = loadInstrumentSpec(INST_ID);
  const candles = loadCandles("5m");
  if (candles.length === 0) {
    console.log("No 5m candles found in data/. Run fetch-data first.");
    return;
  }
  const prepared = prepareData(candles, spec, FIVE_MIN_MS);
  const splitTsValue = computeSplitTs(prepared.firstTs, prepared.lastTs);
  const run = runScenario(prepared, spec, CANONICAL_CONFIG);
  const metrics = computeMetrics(run.trades, STARTING_EQUITY_USDT, {
    ignoredCount: run.ignoredTs.length,
    skippedSizingCount: run.skippedSizingTs.length,
    stillOpenCount: run.stillOpenTs.length,
  });

  writeChart("equity-curve.svg", equityCurveChart(run.trades, prepared.firstTs, splitTsValue));
  writeChart("r-multiple-histogram.svg", rMultipleHistogram(run.trades));
  writeChart("monthly-win-rate.svg", monthlyWinRateChart(run.trades, metrics.breakEvenWinRate));
}

main();
