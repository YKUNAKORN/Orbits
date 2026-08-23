import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

// tickSz and lotSz stay as the exchange's own decimal strings, not numbers -
// they are step sizes fed to decimal.ts, which needs the string to round
// exactly. ctVal/minSz/lever are used as plain scalars, so they're numbers.
export interface InstrumentSpec {
  instId: string;
  ctVal: number;
  ctValCcy: string;
  tickSz: string;
  lotSz: string;
  minSz: number;
  lever: number;
}

export interface OkxInstrumentRow {
  instId: string;
  ctVal: string;
  ctValCcy: string;
  tickSz: string;
  lotSz: string;
  minSz: string;
  lever: string;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`instrument spec: missing or invalid field "${field}": ${JSON.stringify(value)}`);
  }
  return value;
}

// Narrows the untyped OKX response (or whatever was on disk) into the shape
// we depend on. This is a system boundary - the file may be stale, hand
// edited, or from a different endpoint version, so every field is checked.
export function parseOkxInstrumentRow(value: unknown): OkxInstrumentRow {
  if (typeof value !== "object" || value === null) {
    throw new Error(`instrument spec: expected an object, got ${JSON.stringify(value)}`);
  }
  const row = value as Record<string, unknown>;
  return {
    instId: requireString(row.instId, "instId"),
    ctVal: requireString(row.ctVal, "ctVal"),
    ctValCcy: requireString(row.ctValCcy, "ctValCcy"),
    tickSz: requireString(row.tickSz, "tickSz"),
    lotSz: requireString(row.lotSz, "lotSz"),
    minSz: requireString(row.minSz, "minSz"),
    lever: requireString(row.lever, "lever"),
  };
}

export function toInstrumentSpec(row: OkxInstrumentRow): InstrumentSpec {
  const ctVal = Number(row.ctVal);
  const minSz = Number(row.minSz);
  const lever = Number(row.lever);
  if (!(ctVal > 0)) throw new Error(`instrument spec: invalid ctVal "${row.ctVal}"`);
  if (!(minSz > 0)) throw new Error(`instrument spec: invalid minSz "${row.minSz}"`);
  if (!(lever > 0)) throw new Error(`instrument spec: invalid lever "${row.lever}"`);
  return {
    instId: row.instId,
    ctVal,
    ctValCcy: row.ctValCcy,
    tickSz: row.tickSz,
    lotSz: row.lotSz,
    minSz,
    lever,
  };
}

export function instrumentCachePath(instId: string): string {
  return path.join(DATA_DIR, `instrument-${instId}.json`);
}

// Loads the instrument spec cached by fetchInstrument.ts. Never hardcode
// ctVal/lotSz/minSz/tickSz elsewhere - this is the only path they enter the
// program through.
export function loadInstrumentSpec(instId: string): InstrumentSpec {
  const file = instrumentCachePath(instId);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `could not read cached instrument spec at ${file}. Run "npm run fetch-instrument" first. (${String(err)})`,
    );
  }
  return toInstrumentSpec(parseOkxInstrumentRow(raw));
}
