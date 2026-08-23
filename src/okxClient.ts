import { at, type Candle } from "./types.js";

const BASE_URL = "https://www.okx.com";
const HISTORY_LIMIT = 100;
export const REQUEST_INTERVAL_MS = 250;
const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OkxCandlesResponse {
  code: string;
  msg: string;
  data: string[][];
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchHistoryCandlesPage(
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
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { "User-Agent": "dot-5m-signal-research/0.1" },
      });
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(REQUEST_INTERVAL_MS * 2 ** (attempt + 1));
      continue;
    }

    if (isRetryableStatus(res.status)) {
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
  throw new Error(`OKX still failing after ${MAX_RETRIES} retries: ${url.toString()}`);
}

export function parseRow(row: readonly string[]): { candle: Candle; confirm: boolean } {
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
