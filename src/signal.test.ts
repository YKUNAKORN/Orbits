import { test } from "node:test";
import assert from "node:assert/strict";
import { at, type Candle } from "./types.js";
import { computeSignal, type EmaPeriods } from "./signal.js";

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

test("a candle with high equal to low is never strong", () => {
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.8, 10.4); // strong up
  const bar1 = makeCandle(lastTs + 600_000, 10.4, 10.4, 10.4, 10.4); // flat: high === low, range 0
  const bar0 = makeCandle(lastTs + 900_000, 10.4, 11.0, 10.35, 10.95); // strong up
  const candles = [...base, bar2, bar1, bar0];

  assert.equal(computeSignal(candles), null);
});

test("guard rejects a signal where SL lands on the wrong side of entry", () => {
  // Large, long-established ramp so EMA12>26>100 has wide margin and small
  // pattern-bar wiggles near the end can't flip the trend ordering.
  const base = rampWarmup(500, 1, 1000);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 999, 1001.2, 998.7, 1001); // strong up, low 998.7
  const bar1 = makeCandle(lastTs + 600_000, 996, 997.6, 995.7, 997.5); // strong up, small gap down
  const bar0 = makeCandle(lastTs + 900_000, 997.5, 998.6, 997.2, 998.5); // strong up, close 998.5 (entry)
  const candles = [...base, bar2, bar1, bar0];

  // sanity: this really is the degenerate case under test (sl >= entry)
  assert.ok(bar2.low >= bar0.close, "test setup: expected bar2.low >= bar0.close");
  assert.equal(computeSignal(candles), null);
});

test("explicit default periods {12, 26, 100} produce identical output to omitting the parameter", () => {
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.8, 10.4);
  const bar1 = makeCandle(lastTs + 600_000, 10.4, 11.0, 10.3, 10.9);
  const bar0 = makeCandle(lastTs + 900_000, 10.9, 11.6, 10.85, 11.5);
  const candles = [...base, bar2, bar1, bar0];

  const explicit: EmaPeriods = { fast: 12, mid: 26, slow: 100 };
  assert.deepEqual(computeSignal(candles, explicit), computeSignal(candles));
});

test("custom EMA periods are wired to the correct fast/mid/slow slots, not just accepted and ignored", () => {
  // Same fixture as "long signal: 3 strong up bars after an uptrend" above,
  // which fires a long signal under the default (correctly-ordered)
  // fast<mid<slow periods. A shorter EMA period has less lag, so in a
  // monotonic uptrend it sits closer to current price - that's why
  // eFast > eMid > eSlow holds for 12 < 26 < 100. Swapping the fast and slow
  // period VALUES (passing period 100 into the "fast" slot and period 12
  // into the "slow" slot) inverts which computed EMA has the least lag,
  // which flips eFast > eMid to false and kills the long signal - a
  // deliberately unrealistic period assignment, chosen because the
  // inversion is analytically guaranteed to flip the result on a monotonic
  // ramp regardless of the exact prices used, proving the three periods are
  // threaded to the right EMA slots rather than silently ignored.
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.8, 10.4);
  const bar1 = makeCandle(lastTs + 600_000, 10.4, 11.0, 10.3, 10.9);
  const bar0 = makeCandle(lastTs + 900_000, 10.9, 11.6, 10.85, 11.5);
  const candles = [...base, bar2, bar1, bar0];

  assert.ok(computeSignal(candles), "sanity: default periods fire a signal on this fixture");
  const inverted: EmaPeriods = { fast: 100, mid: 26, slow: 12 };
  assert.equal(computeSignal(candles, inverted), null);
});

test("a gap between pattern bars produces no signal even though the OHLC would otherwise qualify", () => {
  const base = rampWarmup(500, 5, 10);
  const lastTs = at(base, base.length - 1).ts;
  const bar2 = makeCandle(lastTs + 300_000, 10, 10.5, 9.8, 10.4); // strong up
  const bar1 = makeCandle(lastTs + 900_000, 10.4, 11.0, 10.3, 10.9); // strong up, but one interval missing before it
  const bar0 = makeCandle(lastTs + 1_200_000, 10.9, 11.6, 10.85, 11.5); // strong up, normal spacing from bar1
  const candles = [...base, bar2, bar1, bar0];

  assert.equal(computeSignal(candles), null);
});
