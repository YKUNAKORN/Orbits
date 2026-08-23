import { test } from "node:test";
import assert from "node:assert/strict";
import { computePositionSize, RISK_PER_TRADE } from "./positionSizing.js";
import type { InstrumentSpec } from "./instrumentSpec.js";

// Chained division/multiplication on decimal literals (e.g. 10 - 9.9) picks
// up sub-ULP IEEE754 noise well below any financially meaningful amount.
// Used for USDT/ratio assertions; contract counts stay strictEqual since
// they're integers post-floor.
function assertClose(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

const DOT_SPEC: InstrumentSpec = {
  instId: "DOT-USDT-SWAP",
  ctVal: 1,
  ctValCcy: "DOT",
  tickSz: "0.0001",
  lotSz: "1",
  minSz: 1,
  lever: 50,
};

test("computes contracts, actual risk, and margin for a clean division", () => {
  const result = computePositionSize({ equityUsdt: 100, entry: 10, sl: 9.9, spec: DOT_SPEC });
  assert.ok(result);
  // riskUsdt = 2, slPct = 0.01, targetNotional = 200, coinQty = 20, ctVal=1 -> rawContracts=20
  assert.equal(result.contracts, 20);
  assertClose(result.actualNotionalUsdt, 200);
  assertClose(result.actualRiskUsdt, 2);
  assertClose(result.marginUsdt, 4); // 200 / lever(50)
});

test("floors down when the risk target doesn't divide evenly into whole contracts", () => {
  const result = computePositionSize({ equityUsdt: 100, entry: 10, sl: 9.97, spec: DOT_SPEC });
  assert.ok(result);
  // riskUsdt=2, slPct=0.003, targetNotional=666.67, coinQty=66.67 -> floors to 66
  assert.equal(result.contracts, 66);
  assert.equal(result.actualNotionalUsdt, 660);
  assert.ok(result.actualRiskUsdt < 2, "flooring must never exceed target risk");
});

test("short side: sl above entry, distance still measured with abs()", () => {
  const result = computePositionSize({ equityUsdt: 100, entry: 10, sl: 10.1, spec: DOT_SPEC });
  assert.ok(result);
  assert.equal(result.contracts, 20); // same 1% distance as the long case
});

test("SL distance of zero is rejected, not divided by", () => {
  assert.equal(computePositionSize({ equityUsdt: 100, entry: 10, sl: 10, spec: DOT_SPEC }), null);
});

test("non-positive entry is rejected", () => {
  assert.equal(computePositionSize({ equityUsdt: 100, entry: 0, sl: -1, spec: DOT_SPEC }), null);
  assert.equal(computePositionSize({ equityUsdt: 100, entry: -5, sl: -6, spec: DOT_SPEC }), null);
});

test("rounds down to zero contracts below minSz returns null, never rounds up", () => {
  // equity=1 -> riskUsdt=0.02 -> targetNotional=2 -> coinQty=0.2 -> rawContracts=0.2 -> floors to 0 < minSz(1)
  const result = computePositionSize({ equityUsdt: 1, entry: 10, sl: 9.9, spec: DOT_SPEC });
  assert.equal(result, null);
});

test("a very wide SL (large slPct) that still clears minSz by exactly one lot", () => {
  // equity=1000 -> riskUsdt=20 -> slPct=0.5 -> targetNotional=40 -> coinQty=4 -> rawContracts=4
  const result = computePositionSize({ equityUsdt: 1000, entry: 10, sl: 5, spec: DOT_SPEC });
  assert.ok(result);
  assert.equal(result.contracts, 4);
});

test("fractional lotSz and ctVal are respected exactly (not just integer specs)", () => {
  const spec: InstrumentSpec = { ...DOT_SPEC, ctVal: 0.1, lotSz: "0.5", minSz: 0.5 };
  // riskUsdt=2, slPct=0.01, targetNotional=200, coinQty=20, ctVal=0.1 -> rawContracts=200
  // lotSz=0.5 -> already a clean multiple, floors to 200
  const result = computePositionSize({ equityUsdt: 100, entry: 10, sl: 9.9, spec });
  assert.ok(result);
  assert.equal(result.contracts, 200);
  assert.equal(result.actualNotionalUsdt, 200 * 0.1 * 10);
});

test("actual risk after flooring never exceeds target risk (property check across many combos)", () => {
  // Algebraically, floor(x/step)*step <= x always, so actualNotional <=
  // targetNotional and actualRiskUsdt <= riskUsdt for any spec - this is
  // what makes the >1.05 guard in computePositionSize unreachable in
  // practice. Sweep a grid of equities/entries/SLs (including values known
  // to produce IEEE754 rounding noise) to confirm no combination pushes
  // actual risk past target by more than float noise (~1e-9 relative).
  for (let equity = 10; equity <= 2000; equity += 37) {
    for (let entryCents = 100; entryCents <= 5500; entryCents += 733) {
      const entry = entryCents / 100;
      for (let slOffsetMils = 1; slOffsetMils <= 300; slOffsetMils += 41) {
        const sl = entry - slOffsetMils / 1000;
        if (sl <= 0) continue;
        const result = computePositionSize({ equityUsdt: equity, entry, sl, spec: DOT_SPEC });
        if (result === null) continue;
        const riskUsdt = equity * RISK_PER_TRADE;
        assert.ok(
          result.actualRiskUsdt <= riskUsdt * (1 + 1e-9),
          `actualRiskUsdt ${result.actualRiskUsdt} exceeded target ${riskUsdt} for equity=${equity} entry=${entry} sl=${sl}`,
        );
      }
    }
  }
});
