import { at, type Candle } from "./types.js";

const BASE_URL = "https://www.okx.com";
const HISTORY_LIMIT = 100;
const REQUEST_INTERVAL_MS = 250;
const MAX_RETRIES = 5;
const MAX_PAGES = 50_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OkxCandlesResponse {
  code: string;
  msg: string;
  data: string[][];
}

async function fetchHistoryCandlesPage(
  instId: string,
  bar: string,
  after: string | undefined,
): Promise<string[][]> {
  const url = new URL(`${BASE_URL}/api/v5/market/history-candles`);
  url.searchParams.set("instId", instId);
  url.searchParams.set("bar", bar);
  url.searchParams.set("limit", String(HISTORY_LIMIT));
  if (after !== undefined) url.searchParams.set("after", after);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "dot-5m-signal-research/0.1" },
    });

    if (res.status === 429) {
      await sleep(REQUEST_INTERVAL_MS * 2 ** (attempt + 1));
      continue;
    }
    if (!res.ok) {
      throw new Error(`OKX HTTP ${res.status} ${res.statusText}: ${url.toString()}`);
    }

    const body = (await res.json()) as OkxCandlesResponse;
    if (body.code !== "0") {
      throw new Error(`OKX API error ${body.code}: ${body.msg} (${url.toString()})`);
    }
    return body.data;
  }
  throw new Error(`OKX rate-limited after ${MAX_RETRIES} retries: ${url.toString()}`);
}

function parseRow(row: readonly string[]): { candle: Candle; confirm: boolean } {
  return {
    candle: {
      ts: Number(at(row, 0)),
      open: Number(at(row, 1)),
      high: Number(at(row, 2)),
      low: Number(at(row, 3)),
      close: Number(at(row, 4)),
      volume: Number(at(row, 5)),
    },
    confirm: at(row, row.length - 1) === "1",
  };
}

// Pages backward from now until OKX returns an empty page, which finds the
// real history boundary empirically instead of assuming a retention window.
// Only CONFIRMED (closed) candles are kept. If stopAtTs is given, stops once
// a page's oldest candle reaches at or before it (used to bound the 1m pull
// to the 5m dataset's range instead of walking all available 1m history).
export async function fetchHistoryCandles(
  instId: string,
  bar: string,
  stopAtTs?: number,
): Promise<Candle[]> {
  const collected = new Map<number, Candle>();
  let after: string | undefined;
  let page = 0;

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
      `  [${instId} ${bar}] page ${page}: ${rows.length} rows, oldest ${new Date(oldestTs).toISOString()}`,
    );

    if (stopAtTs !== undefined && oldestTs <= stopAtTs) break;

    after = at(oldestRow, 0);
    await sleep(REQUEST_INTERVAL_MS);
  }

  return Array.from(collected.values()).sort((a, b) => a.ts - b.ts);
}
