import { test } from "node:test";
import assert from "node:assert/strict";
import { at, type Candle } from "./types.js";
import { computeSignal } from "./signal.js";

function makeCandle(ts: number, open: number, high: number, low: number, close: number): Candle {
  return { ts, open, high, low, close, volume: 1 };
}

// Linear ramp so EMA12/26/100 stack in one direction by construction.
function rampWarmup(count: number, startPrice: number, endPrice: number): Candle[] {
  const candles: Candle[] = [];
  const step = (endPrice - startPrice) / count;
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + step;
    const high = Math.max(open, close) + Math.abs(step) * 0.1;
    const low = Math.min(open, close) - Math.abs(step) * 0.1;
    candles.push(makeCandle(i * 300_000, open, high, low, close));
    price = close;
  }
  return candles;
}

test("fewer than 500 bars returns null regardless of pattern", () => {
  const candles = rampWarmup(10, 100, 110);
  assert.equal(computeSignal(candles), null);
});

test("long signal: 3 strong up bars after an uptrend", () => {
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.8, 10.4);
  const bar1 = makeCandle(lastTs + 600_000, 10.4, 11.0, 10.3, 10.9);
  const bar0 = makeCandle(lastTs + 900_000, 10.9, 11.6, 10.85, 11.5);
  const candles = [...base, bar2, bar1, bar0];

  const signal = computeSignal(candles);
  assert.ok(signal, "expected a long signal");
  assert.equal(signal?.side, "long");
  assert.equal(signal?.entry, 11.5); // close of bar0
  assert.equal(signal?.sl, 9.8); // low of bar2, the OLDEST of the three
  assert.equal(signal?.tp, 11.5 + 2 * (11.5 - 9.8));
  assert.equal(signal?.time, bar0.ts);
});

test("short signal: 3 strong down bars after a downtrend", () => {
  const base = rampWarmup(500, 10, 5);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 5, 5.2, 4.5, 4.6);
  const bar1 = makeCandle(lastTs + 600_000, 4.6, 4.7, 4.0, 4.1);
  const bar0 = makeCandle(lastTs + 900_000, 4.1, 4.2, 3.5, 3.6);
  const candles = [...base, bar2, bar1, bar0];

  const signal = computeSignal(candles);
  assert.ok(signal, "expected a short signal");
  assert.equal(signal?.side, "short");
  assert.equal(signal?.entry, 3.6);
  assert.equal(signal?.sl, 5.2); // high of bar2
  assert.equal(signal?.tp, 3.6 - 2 * (5.2 - 3.6));
});

test("body exactly 50% of range is not strong (strict inequality)", () => {
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.5, 10.5);
  const bar1 = makeCandle(lastTs + 600_000, 10.5, 11.0, 10.0, 11.0);
  const bar0 = makeCandle(lastTs + 900_000, 11.0, 11.5, 10.5, 11.5);
  const candles = [...base, bar2, bar1, bar0];

  assert.equal(computeSignal(candles), null);
});

test("strong bars against the prevailing trend produce no signal", () => {
  const base = rampWarmup(500, 5, 10); // uptrend
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.1, 9.4, 9.5);
  const bar1 = makeCandle(lastTs + 600_000, 9.5, 9.6, 8.9, 9.0);
  const bar0 = makeCandle(lastTs + 900_000, 9.0, 9.1, 8.4, 8.5);
  const candles = [...base, bar2, bar1, bar0];

  assert.equal(computeSignal(candles), null);
});

test("only 2 of 3 strong bars produces no signal", () => {
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.8, 10.4); // strong up
  const bar1 = makeCandle(lastTs + 600_000, 10.4, 10.6, 10.3, 10.45); // NOT strong
  const bar0 = makeCandle(lastTs + 900_000, 10.45, 11.1, 10.4, 11.05); // strong up
  const candles = [...base, bar2, bar1, bar0];

  assert.equal(computeSignal(candles), null);
});
