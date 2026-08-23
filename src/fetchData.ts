import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, type Candle } from "./types.js";
import { fetchHistoryCandlesPage, parseRow, REQUEST_INTERVAL_MS } from "./okxClient.js";

const INST_ID = "DOT-USDT-SWAP";
const MAX_PAGES = 50_000;
const CHECKPOINT_INTERVAL_MS = 30_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outputPath(bar: string): string {
  return path.join(DATA_DIR, `${INST_ID}-${bar}.json`);
}

function loadExisting(bar: string): Map<number, Candle> {
  const file = outputPath(bar);
  const map = new Map<number, Candle>();
  if (!existsSync(file)) return map;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Candle[];
  for (const c of raw) map.set(c.ts, c);
  return map;
}

function earliestTs(collected: ReadonlyMap<number, Candle>): number | undefined {
  let min: number | undefined;
  for (const ts of collected.keys()) {
    if (min === undefined || ts < min) min = ts;
  }
  return min;
}

function latestTs(collected: ReadonlyMap<number, Candle>): number | undefined {
  let max: number | undefined;
  for (const ts of collected.keys()) {
    if (max === undefined || ts > max) max = ts;
  }
  return max;
}

// Write-to-temp-then-rename so a kill mid-write can never leave a corrupt
// JSON file behind - resume always has a valid file to load, at worst stale.
function save(bar: string, collected: ReadonlyMap<number, Candle>): void {
  const sorted = Array.from(collected.values()).sort((a, b) => a.ts - b.ts);
  const final = outputPath(bar);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted));
  renameSync(tmp, final);
}

interface PageLoopOptions {
  startAfter: string | undefined; // undefined = start unanchored at the newest available candle
  stopAtOrBefore: number | undefined; // stop once a page's oldest candle ts reaches at/before this
}

// Pages backward (newest to oldest) from `startAfter`, merging every
// confirmed candle into `collected` and checkpointing to disk on a timer
// (not a page count, so overhead stays bounded once the set is large).
// Shared by both fetch directions: extending further into the past
// (fetchResumable) and catching up to now from the last stored candle
// (fetchNewest) - same pagination mechanic, different start cursor and stop
// condition.
async function pageBackward(
  instId: string,
  bar: string,
  collected: Map<number, Candle>,
  options: PageLoopOptions,
): Promise<void> {
  let after = options.startAfter;
  let page = 0;
  let lastCheckpoint = Date.now();

  for (;;) {
    if (page >= MAX_PAGES) {
      throw new Error(`exceeded ${MAX_PAGES} pages fetching ${instId} ${bar}; cursor may be stuck`);
    }
    const rows = await fetchHistoryCandlesPage(instId, bar, after);
    if (rows.length === 0) break;

    for (const row of rows) {
      const { candle, confirm } = parseRow(row);
      if (confirm) collected.set(candle.ts, candle);
    }

    const oldestRow = at(rows, rows.length - 1); // API returns newest-first
    const oldestTs = Number(at(oldestRow, 0));
    page += 1;
    console.log(
      `  [${instId} ${bar}] page ${page}: ${rows.length} rows, oldest ${new Date(oldestTs).toISOString()}, total ${collected.size}`,
    );

    if (Date.now() - lastCheckpoint >= CHECKPOINT_INTERVAL_MS) {
      save(bar, collected);
      lastCheckpoint = Date.now();
    }

    if (options.stopAtOrBefore !== undefined && oldestTs <= options.stopAtOrBefore) break;

    after = at(oldestRow, 0);
    await sleep(REQUEST_INTERVAL_MS);
  }

  save(bar, collected);
}

interface FetchOptions {
  fromTs?: number; // stop once a page's oldest candle reaches at/before this
  toTs?: number; // fresh-start anchor; ignored once we already have data to resume from
}

// Resumable: loads whatever is already on disk and continues paging backward
// from its earliest candle, extending further into the past.
async function fetchResumable(instId: string, bar: string, options: FetchOptions): Promise<void> {
  const collected = loadExisting(bar);
  const existingEarliest = earliestTs(collected);
  console.log(`[${instId} ${bar}] resuming with ${collected.size} candles already on disk`);

  if (options.fromTs !== undefined && existingEarliest !== undefined && existingEarliest <= options.fromTs) {
    console.log(`[${instId} ${bar}] already have data back to fromTs, nothing to do`);
    return;
  }

  let startAfter: string | undefined;
  if (existingEarliest !== undefined) {
    startAfter = String(existingEarliest); // resume takes priority over --to
  } else if (options.toTs !== undefined) {
    startAfter = String(options.toTs + 1);
  }

  await pageBackward(instId, bar, collected, { startAfter, stopAtOrBefore: options.fromTs });
  console.log(`[${instId} ${bar}] done: ${collected.size} candles on disk`);
}

// Catches up to the present: pages backward from the newest available
// candle until reaching what's already on disk, so candles newer than the
// last fetch get filled in at the front - not just further into the past.
async function fetchNewest(instId: string, bar: string): Promise<void> {
  const collected = loadExisting(bar);
  const existingLatest = latestTs(collected);
  if (existingLatest === undefined) {
    console.log(`[${instId} ${bar}] no existing data on disk - run a normal fetch first`);
    return;
  }
  console.log(
    `[${instId} ${bar}] catching up from ${new Date(existingLatest).toISOString()} to now (${collected.size} candles already on disk)`,
  );

  await pageBackward(instId, bar, collected, { startAfter: undefined, stopAtOrBefore: existingLatest });
  console.log(`[${instId} ${bar}] done: ${collected.size} candles on disk`);
}

interface Cli {
  bar: "5m" | "1m" | "both";
  from?: number;
  to?: number;
  forward: boolean;
}

function parseArgs(argv: readonly string[]): Cli {
  let bar: "5m" | "1m" | "both" = "both";
  let from: number | undefined;
  let to: number | undefined;
  let forward = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = at(argv, i);
    if (arg === "--bar") {
      const value = argv[i + 1];
      if (value !== "5m" && value !== "1m" && value !== "both") {
        throw new Error(`--bar must be 5m, 1m, or both (got ${String(value)})`);
      }
      bar = value;
      i += 1;
    } else if (arg === "--from" || arg === "--to") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a date value`);
      const ts = Date.parse(value);
      if (Number.isNaN(ts)) throw new Error(`${arg}: invalid date "${value}"`);
      if (arg === "--from") from = ts;
      else to = ts;
      i += 1;
    } else if (arg === "--forward") {
      forward = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (forward && (from !== undefined || to !== undefined)) {
    throw new Error("--forward catches up to now from whatever is on disk; it can't be combined with --from/--to");
  }

  return { bar, from, to, forward };
}

async function run(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  mkdirSync(DATA_DIR, { recursive: true });

  if (cli.forward) {
    // Catch-up mode: pull whatever candles have appeared since the last
    // fetch, at the front of the series - never extends further into the past.
    if (cli.bar === "5m" || cli.bar === "both") {
      console.log(`Fetching newest ${INST_ID} 5m...`);
      await fetchNewest(INST_ID, "5m");
    }
    if (cli.bar === "1m" || cli.bar === "both") {
      console.log(`Fetching newest ${INST_ID} 1m...`);
      await fetchNewest(INST_ID, "1m");
    }
    return;
  }

  if (cli.bar === "5m" || cli.bar === "both") {
    console.log(`Fetching ${INST_ID} 5m...`);
    await fetchResumable(INST_ID, "5m", { fromTs: cli.from, toTs: cli.to });
  }

  if (cli.bar === "1m" || cli.bar === "both") {
    let fromTs = cli.from;
    const toTs = cli.to;
    if (fromTs === undefined && toTs === undefined) {
      // default: match whatever 5m range is on disk, so 1m covers the same period
      fromTs = earliestTs(loadExisting("5m"));
    }
    console.log(`Fetching ${INST_ID} 1m...`);
    await fetchResumable(INST_ID, "1m", { fromTs, toTs });
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
