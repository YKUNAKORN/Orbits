import { floorToStep } from "./decimal.js";
import type { InstrumentSpec } from "./instrumentSpec.js";

// Frozen spec (CLAUDE.md section 4): risk 2% of current equity per trade,
// measured as the loss if SL is hit. Not a tunable parameter.
export const RISK_PER_TRADE = 0.02;

// Hard guard tolerance: actual risk after flooring to a lot may not exceed
// target risk by more than this fraction.
const RISK_GUARD_MULTIPLIER = 1.05;

export interface PositionSizingInput {
  equityUsdt: number;
  entry: number;
  sl: number;
  spec: InstrumentSpec;
}

export interface PositionSizingResult {
  contracts: number;
  actualRiskUsdt: number;
  actualNotionalUsdt: number;
  marginUsdt: number;
}

// Pure. All inputs must come from live sources (equity, entry, sl, spec) -
// nothing here is hardcoded. Flooring only ever reduces contracts below the
// exact risk-target value, so actualRiskUsdt <= riskUsdt holds by
// construction; the >1.05 guard below is unreachable through this floor
// path under exact arithmetic (verified in positionSizing.test.ts) and is
// kept only as defense-in-depth against a future change to the rounding
// logic, per the frozen spec.
export function computePositionSize(input: PositionSizingInput): PositionSizingResult | null {
  const { equityUsdt, entry, sl, spec } = input;

  if (!(entry > 0)) return null;
  const slPct = Math.abs(entry - sl) / entry;
  if (!(slPct > 0)) return null; // zero or degenerate SL distance: reject, do not divide

  const riskUsdt = equityUsdt * RISK_PER_TRADE;
  const targetNotional = riskUsdt / slPct;
  const coinQty = targetNotional / entry;
  const rawContracts = coinQty / spec.ctVal;

  // Always floor. Rounding up exceeds the risk budget.
  const contracts = floorToStep(rawContracts, spec.lotSz);
  if (contracts < spec.minSz) return null; // skip the trade, never round up

  // Recompute what the risk actually is after rounding, and check it.
  const actualNotionalUsdt = contracts * spec.ctVal * entry;
  const actualRiskUsdt = actualNotionalUsdt * slPct;
  if (actualRiskUsdt > riskUsdt * RISK_GUARD_MULTIPLIER) return null;

  const marginUsdt = actualNotionalUsdt / spec.lever; // informational only

  return { contracts, actualRiskUsdt, actualNotionalUsdt, marginUsdt };
}
