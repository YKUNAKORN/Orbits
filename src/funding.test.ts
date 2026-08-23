import { test } from "node:test";
import assert from "node:assert/strict";
import { FUNDING_INTERVAL_MS, isFundingTs, countFundingCrossings, crossesFunding } from "./funding.js";

// Confirmed live via GET /public/funding-rate on 2026-08-23.
const KNOWN_BOUNDARY = Date.parse("2026-08-23T08:00:00.000Z");

test("isFundingTs is true on real 00:00/08:00/16:00 UTC boundaries and false off them", () => {
  assert.equal(isFundingTs(Date.parse("2026-08-23T00:00:00.000Z")), true);
  assert.equal(isFundingTs(Date.parse("2026-08-23T08:00:00.000Z")), true);
  assert.equal(isFundingTs(Date.parse("2026-08-23T16:00:00.000Z")), true);
  assert.equal(isFundingTs(Date.parse("2026-08-23T08:05:00.000Z")), false);
  assert.equal(isFundingTs(Date.parse("2026-08-23T04:00:00.000Z")), false);
});

test("a trade opened and closed inside the same funding window crosses none", () => {
  const entry = KNOWN_BOUNDARY - 60_000;
  const exit = KNOWN_BOUNDARY - 1_000;
  assert.equal(countFundingCrossings(entry, exit), 0);
  assert.equal(crossesFunding(entry, exit), false);
});

test("a trade held across one boundary counts exactly one crossing", () => {
  const entry = KNOWN_BOUNDARY - 60_000;
  const exit = KNOWN_BOUNDARY + 60_000;
  assert.equal(countFundingCrossings(entry, exit), 1);
  assert.equal(crossesFunding(entry, exit), true);
});

test("entering exactly at a boundary does not charge that boundary, only later ones", () => {
  assert.equal(countFundingCrossings(KNOWN_BOUNDARY, KNOWN_BOUNDARY + 60_000), 0);
  assert.equal(countFundingCrossings(KNOWN_BOUNDARY, KNOWN_BOUNDARY + FUNDING_INTERVAL_MS), 1);
});

test("a long-held trade counts every boundary it spans", () => {
  const entry = KNOWN_BOUNDARY - 60_000;
  const exit = KNOWN_BOUNDARY + 2 * FUNDING_INTERVAL_MS + 60_000;
  assert.equal(countFundingCrossings(entry, exit), 3);
});

test("exit at or before entry crosses nothing", () => {
  assert.equal(countFundingCrossings(KNOWN_BOUNDARY, KNOWN_BOUNDARY), 0);
  assert.equal(countFundingCrossings(KNOWN_BOUNDARY, KNOWN_BOUNDARY - 1), 0);
});
