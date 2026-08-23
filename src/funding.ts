// OKX funding settles every 8 hours at 00:00/08:00/16:00 UTC (confirmed live
// via GET /public/funding-rate: fundingTime/prevFundingTime/nextFundingTime
// are all exactly 8h apart, landing on those three UTC hours). Since the
// Unix epoch is itself a 00:00 UTC boundary and 8h divides 24h evenly, every
// exact multiple of FUNDING_INTERVAL_MS is one of those three instants -
// no separate schedule anchor is needed.
//
// Assumption: this 8h/00-08-16 UTC schedule is treated as constant across
// the whole backtest history (2020-08 to present). This matches OKX's
// documented, stable funding cadence; it is not re-derived per period.
export const FUNDING_INTERVAL_MS = 8 * 3600_000;

export function isFundingTs(ts: number): boolean {
  return ts % FUNDING_INTERVAL_MS === 0;
}

// Number of funding settlements a position was open across: boundaries
// strictly after entry (the position wasn't open yet at the instant it
// entered) and at or before exit.
export function countFundingCrossings(entryTs: number, exitTs: number): number {
  if (exitTs <= entryTs) return 0;
  const atOrBeforeEntry = Math.floor(entryTs / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
  const firstBoundary = atOrBeforeEntry + FUNDING_INTERVAL_MS;
  if (firstBoundary > exitTs) return 0;
  return Math.floor((exitTs - firstBoundary) / FUNDING_INTERVAL_MS) + 1;
}

export function crossesFunding(entryTs: number, exitTs: number): boolean {
  return countFundingCrossings(entryTs, exitTs) > 0;
}
