import { at, type Candle, type Signal } from "./types.js";

export type TradeOutcome = "tp" | "sl" | "ambiguous" | "open";

export interface TradeCandidate {
  signal: Signal;
  entryIndex: number;
  exitIndex: number | null; // null only when outcome === "open" (ran out of segment)
  outcome: TradeOutcome;
}

export interface SequenceResult {
  trades: TradeCandidate[];
  ignoredCount: number;
}

// Applies the one-position-at-a-time rule (CLAUDE.md section 4) to a raw
// signal list within a single contiguous segment, and classifies each
// resolved trade's exit against the CLAUDE.md fill model:
//   - SL triggers on mere touch.
//   - TP requires price to trade at least one tickSz *beyond* the TP level;
//     a bar that only reaches the TP price exactly has not filled it.
//   - A bar that satisfies both conditions is "ambiguous" - 5m OHLC alone
//     can't order intrabar events. The caller resolves ambiguity (SL-first
//     lower bound vs TP-first upper bound); the sequence of which signals
//     are taken vs ignored is identical either way, since both bounds close
//     the position on the same bar.
//
// Entry fills at bar0's close, so the exit scan starts at bar0+1 - bar0's
// own high/low happened before the fill and must never be scored against it.
//
// A position still open when the segment ends (a data gap follows) stays
// open for the rest of the segment: every later signal in this segment is
// counted as ignored, not silently dropped.
export function sequenceTrades(
  segment: readonly Candle[],
  signals: readonly Signal[],
  tickSz: string,
): SequenceResult {
  const tick = Number(tickSz);
  const tsToIndex = new Map<number, number>();
  segment.forEach((c, i) => tsToIndex.set(c.ts, i));

  const trades: TradeCandidate[] = [];
  let ignoredCount = 0;
  let nextAvailableIndex = 0;
  let stillOpen = false;

  for (const signal of signals) {
    if (stillOpen) {
      ignoredCount += 1;
      continue;
    }

    const entryIndex = tsToIndex.get(signal.time);
    if (entryIndex === undefined) continue; // defensive: signal wasn't built from this segment
    if (entryIndex < nextAvailableIndex) {
      ignoredCount += 1;
      continue;
    }

    let outcome: TradeOutcome = "open";
    let exitIndex: number | null = null;
    for (let i = entryIndex + 1; i < segment.length; i++) {
      const bar = at(segment, i);
      const hitSl = signal.side === "long" ? bar.low <= signal.sl : bar.high >= signal.sl;
      const hitTp =
        signal.side === "long" ? bar.high >= signal.tp + tick : bar.low <= signal.tp - tick;
      if (hitSl && hitTp) {
        outcome = "ambiguous";
        exitIndex = i;
        break;
      }
      if (hitSl) {
        outcome = "sl";
        exitIndex = i;
        break;
      }
      if (hitTp) {
        outcome = "tp";
        exitIndex = i;
        break;
      }
    }

    trades.push({ signal, entryIndex, exitIndex, outcome });

    if (exitIndex === null) {
      stillOpen = true;
    } else {
      nextAvailableIndex = exitIndex; // closed out on this bar; its own close can open the next signal
    }
  }

  return { trades, ignoredCount };
}
