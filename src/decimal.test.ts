import { test } from "node:test";
import assert from "node:assert/strict";
import { floorToStep, ceilToStep, roundToStep } from "./decimal.js";

test("floorToStep rounds down to the nearest lot for an integer step", () => {
  assert.equal(floorToStep(4.9, "1"), 4);
  assert.equal(floorToStep(5, "1"), 5);
  assert.equal(floorToStep(0.9, "1"), 0);
});

test("floorToStep on a tickSz-like fractional step avoids float drift", () => {
  // 0.1 + 0.2 !== 0.3 in raw IEEE754; this must still floor exactly.
  assert.equal(floorToStep(0.30000000000000004, "0.1"), 0.3);
  assert.equal(floorToStep(1.2345, "0.0001"), 1.2345);
  assert.equal(floorToStep(1.23456, "0.0001"), 1.2345);
});

test("ceilToStep rounds up to the nearest step", () => {
  assert.equal(ceilToStep(4.1, "1"), 5);
  assert.equal(ceilToStep(1.23449, "0.0001"), 1.2345);
});

test("roundToStep rounds to the nearest step", () => {
  assert.equal(roundToStep(4.4, "1"), 4);
  assert.equal(roundToStep(4.5, "1"), 5);
});

test("a fractional lot size (e.g. 0.1) floors without drifting to the wrong lot", () => {
  assert.equal(floorToStep(2.3, "0.1"), 2.3);
  assert.equal(floorToStep(2.29, "0.1"), 2.2);
});

test("an invalid (zero) step throws instead of dividing by zero", () => {
  assert.throws(() => floorToStep(1, "0"));
});
