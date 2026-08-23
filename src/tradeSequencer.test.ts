import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle, Signal } from "./types.js";
import { sequenceTrades } from "./tradeSequencer.js";

const STEP = 300_000; // 5m
const TICK = "0.1";

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  return { ts: index * STEP, open, high, low, close, volume: 1 };
}

function longSignal(entryIndex: number, entry: number, sl: number, tp: number): Signal {
  return { side: "long", time: entryIndex * STEP, entry, sl, tp };
}

function shortSignal(entryIndex: number, entry: number, sl: number, tp: number): Signal {
  return { side: "short", time: entryIndex * STEP, entry, sl, tp };
}

test("TP requires trading at least one tick beyond the level, not merely touching it", () => {
  const signal = longSignal(0, 100, 95, 110);
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100), // signal bar
    candle(1, 100, 110, 99, 105), // touches TP exactly - must NOT fill
    candle(2, 105, 110.2, 104, 106), // clears TP by one tick - fills here
  ];
  const { trades, ignoredCount } = sequenceTrades(segment, [signal], TICK);
  assert.equal(ignoredCount, 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.outcome, "tp");
  assert.equal(trades[0]?.exitIndex, 2);
});

test("SL fills on mere touch, no tick buffer required", () => {
  const signal = longSignal(0, 100, 95, 110);
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 95, 96), // low touches SL exactly
  ];
  const { trades } = sequenceTrades(segment, [signal], TICK);
  assert.equal(trades[0]?.outcome, "sl");
  assert.equal(trades[0]?.exitIndex, 1);
});

test("a bar that clears both SL and TP-beyond-tick in the same bar is ambiguous", () => {
  const signal = longSignal(0, 100, 95, 110);
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100),
    candle(1, 94, 110.2, 94, 108), // low <= 95 AND high >= 110.1
  ];
  const { trades } = sequenceTrades(segment, [signal], TICK);
  assert.equal(trades[0]?.outcome, "ambiguous");
  assert.equal(trades[0]?.exitIndex, 1);
});

test("short side: SL touch above, TP requires clearing below by a tick", () => {
  const signal = shortSignal(0, 100, 105, 90);
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 90, 95), // touches TP exactly - must NOT fill
    candle(2, 95, 96, 89.9, 90), // clears TP by one tick
  ];
  const { trades } = sequenceTrades(segment, [signal], TICK);
  assert.equal(trades[0]?.outcome, "tp");
  assert.equal(trades[0]?.exitIndex, 2);
});

test("the entry (signal) bar's own high/low is never scanned for exit", () => {
  // bar0's own high/low would satisfy SL if it were scanned - it must not be.
  const signal = longSignal(0, 100, 95, 110);
  const segment: Candle[] = [
    candle(0, 100, 101, 90, 100), // low 90 would hit SL(95) if scanned - must be ignored
    candle(1, 100, 101, 99, 100), // does nothing
    candle(2, 100, 101, 95, 96), // real SL touch
  ];
  const { trades } = sequenceTrades(segment, [signal], TICK);
  assert.equal(trades[0]?.exitIndex, 2);
});

test("one-position-at-a-time: a signal arriving while a position is open is ignored", () => {
  const a = longSignal(0, 100, 95, 110);
  const b = longSignal(1, 100, 95, 110); // fires one bar later, while A is still open
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 99, 100),
    candle(2, 100, 101, 99, 100),
    candle(3, 100, 101, 95, 96), // A's SL touch
  ];
  const { trades, ignoredCount } = sequenceTrades(segment, [a, b], TICK);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.signal, a);
  assert.equal(ignoredCount, 1);
});

test("a position that never resolves before the segment ends stays open, and every later signal in the segment is still counted as ignored (not dropped)", () => {
  const a = longSignal(0, 100, 95, 110); // never hits SL or TP in this segment
  const b = longSignal(1, 100, 95, 110);
  const c = longSignal(2, 100, 95, 110);
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 99, 100),
    candle(2, 100, 101, 99, 100),
    candle(3, 100, 101, 99, 100), // segment ends; A is still open
  ];
  const { trades, ignoredCount } = sequenceTrades(segment, [a, b, c], TICK);
  assert.equal(trades.length, 1);
  assert.equal(trades[0]?.outcome, "open");
  assert.equal(trades[0]?.exitIndex, null);
  // Both b and c fired while a's position was open for the rest of the
  // segment - the Phase 1 bug silently dropped these instead of counting
  // them as ignored.
  assert.equal(ignoredCount, 2);
});

test("a resolved trade's own exit bar can seed the very next signal", () => {
  const a = longSignal(0, 100, 95, 110);
  const b = longSignal(1, 100, 95, 110); // same bar that closes A
  const segment: Candle[] = [
    candle(0, 100, 101, 99, 100),
    candle(1, 100, 101, 95, 96), // closes A via SL
    candle(2, 96, 101, 95, 96), // touches B's SL too
  ];
  const { trades, ignoredCount } = sequenceTrades(segment, [a, b], TICK);
  assert.equal(trades.length, 2);
  assert.equal(ignoredCount, 0);
  assert.equal(trades[0]?.exitIndex, 1);
  assert.equal(trades[1]?.entryIndex, 1);
  assert.equal(trades[1]?.exitIndex, 2);
});
