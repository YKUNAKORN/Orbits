import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicInstrument } from "./okxClient.js";
import { parseOkxInstrumentRow, instrumentCachePath } from "./instrumentSpec.js";

const INST_ID = "DOT-USDT-SWAP";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

async function run(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const raw = await fetchPublicInstrument(INST_ID);
  const row = parseOkxInstrumentRow(raw); // validate before it ever hits disk
  const file = instrumentCachePath(INST_ID);
  writeFileSync(file, JSON.stringify(row, null, 2));
  console.log(`Saved instrument spec for ${INST_ID} to ${file}`);
  console.log(row);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
