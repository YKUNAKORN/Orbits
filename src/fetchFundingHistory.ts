import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at } from "./types.js";
import { fetchFundingRateHistoryPage, REQUEST_INTERVAL_MS } from "./okxClient.js";

const INST_ID = "DOT-USDT-SWAP";
const MAX_PAGES = 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

export interface FundingRateRecord {
  fundingTime: number;
  realizedRate: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fundingHistoryCachePath(instId: string): string {
  return path.join(DATA_DIR, `funding-rate-history-${instId}.json`);
}

function parseRow(row: unknown): FundingRateRecord {
  if (typeof row !== "object" || row === null) {
    throw new Error(`funding-rate-history: expected an object row, got ${JSON.stringify(row)}`);
  }
  const r = row as Record<string, unknown>;
  const fundingTime = Number(r.fundingTime);
  const realizedRate = Number(r.realizedRate);
  if (!Number.isFinite(fundingTime) || !Number.isFinite(realizedRate)) {
    throw new Error(`funding-rate-history: bad row ${JSON.stringify(row)}`);
  }
  return { fundingTime, realizedRate };
}

// OKX retains only a few months of this endpoint regardless of how far back
// `after` points, so this simply pages until the response is empty - no
// resume/checkpoint machinery needed, unlike the multi-year candle fetch.
async function run(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const collected = new Map<number, FundingRateRecord>();
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await fetchFundingRateHistoryPage(INST_ID, after);
    if (rows.length === 0) break;
    const records = rows.map(parseRow);
    for (const record of records) collected.set(record.fundingTime, record);

    const oldest = at(records, records.length - 1);
    console.log(
      `page ${page + 1}: ${records.length} rows, oldest ${new Date(oldest.fundingTime).toISOString()}, total ${collected.size}`,
    );
    after = String(oldest.fundingTime);
    await sleep(REQUEST_INTERVAL_MS);
  }

  const sorted = [...collected.values()].sort((a, b) => a.fundingTime - b.fundingTime);
  const file = fundingHistoryCachePath(INST_ID);
  writeFileSync(file, JSON.stringify(sorted, null, 2));
  console.log(`Saved ${sorted.length} funding rate records to ${file}`);
  if (sorted.length > 0) {
    const first = at(sorted, 0);
    const last = at(sorted, sorted.length - 1);
    console.log(`Range: ${new Date(first.fundingTime).toISOString()} -> ${new Date(last.fundingTime).toISOString()}`);
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
