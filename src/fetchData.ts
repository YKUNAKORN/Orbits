import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at } from "./types.js";
import { fetchHistoryCandles } from "./okxClient.js";

const INST_ID = "DOT-USDT-SWAP";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

async function run(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(`Fetching ${INST_ID} 5m history...`);
  const candles5m = await fetchHistoryCandles(INST_ID, "5m");
  if (candles5m.length === 0) throw new Error("no 5m candles returned by OKX");
  const first5m = at(candles5m, 0);
  const last5m = at(candles5m, candles5m.length - 1);
  console.log(
    `  ${candles5m.length} confirmed 5m candles: ${new Date(first5m.ts).toISOString()} -> ${new Date(last5m.ts).toISOString()}`,
  );
  writeFileSync(path.join(DATA_DIR, `${INST_ID}-5m.json`), JSON.stringify(candles5m));

  console.log(`Fetching ${INST_ID} 1m history for the same period...`);
  const candles1mRaw = await fetchHistoryCandles(INST_ID, "1m", first5m.ts);
  const candles1m = candles1mRaw.filter((c) => c.ts >= first5m.ts && c.ts <= last5m.ts);
  console.log(`  ${candles1m.length} confirmed 1m candles in range`);
  writeFileSync(path.join(DATA_DIR, `${INST_ID}-1m.json`), JSON.stringify(candles1m));
}

run().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
