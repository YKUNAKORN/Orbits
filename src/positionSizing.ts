import { floorToStep } from "./decimal.js";
import type { InstrumentSpec } from "./instrumentSpec.js";

// Frozen spec (CLAUDE.md section 4): risk 2% of current equity per trade,
// measured as the loss if SL is hit. Not a tunable parameter.
export const RISK_PER_TRADE = 0.02;

// Measurement-only constant (NOT part of the frozen spec - CLAUDE.md section
// 4 stays 2% of equity for the live bot and the canonical backtest). Used
// only by computeFixedRiskPositionSize, whose purpose is explained there.
export const FIXED_RISK_USDT_FOR_MEASUREMENT = 2;

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
  // What this call aimed for (equityUsdt * RISK_PER_TRADE, or the flat
  // riskUsdt passed to computeFixedRiskPositionSize) - kept alongside
  // actualRiskUsdt so callers can report "actual as % of target" without
  // needing to know which sizing mode produced the result.
  targetRiskUsdt: number;
  actualRiskUsdt: number;
  actualNotionalUsdt: number;
  marginUsdt: number;
}

// Shared by both sizing modes below: given a target risk in USDT (however
// derived) and entry/sl/spec, floors to the exchange lot size, rejects below
// minSz, and guards actual risk against the target. Flooring only ever
// reduces contracts below the exact risk-target value, so actualRiskUsdt <=
// riskUsdt holds by construction; the >1.05 guard is unreachable through
// this floor path under exact arithmetic (verified in positionSizing.test.ts)
// and is kept only as defense-in-depth against a future change to the
// rounding logic.
function sizeForTargetRisk(riskUsdt: number, entry: number, sl: number, spec: InstrumentSpec): PositionSizingResult | null {
  if (!(entry > 0)) return null;
  const slPct = Math.abs(entry - sl) / entry;
  if (!(slPct > 0)) return null; // zero or degenerate SL distance: reject, do not divide

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

  return { contracts, targetRiskUsdt: riskUsdt, actualRiskUsdt, actualNotionalUsdt, marginUsdt };
}

// Pure. All inputs must come from live sources (equity, entry, sl, spec) -
// nothing here is hardcoded. This is the frozen spec (CLAUDE.md section 4):
// risk 2% of CURRENT equity, so it compounds - used by the live bot and
// every canonical (non-measurement) backtest scenario.
export function computePositionSize(input: PositionSizingInput): PositionSizingResult | null {
  const { equityUsdt, entry, sl, spec } = input;
  return sizeForTargetRisk(equityUsdt * RISK_PER_TRADE, entry, sl, spec);
}

export interface FixedRiskPositionSizingInput {
  entry: number;
  sl: number;
  spec: InstrumentSpec;
  // Defaults to FIXED_RISK_USDT_FOR_MEASUREMENT; overridable for tests.
  riskUsdt?: number;
}

// MEASUREMENT-ONLY sizing mode, not the frozen spec. Risks a flat USDT
// amount per trade regardless of current equity - no compounding. Purpose:
// under the frozen 2%-of-equity formula, a losing stretch shrinks equity
// until computePositionSize starts rejecting signals for falling under
// minSz, which silently truncates the sample that win-rate/expectancy-R
// statistics are computed from (later signals never get a chance to size,
// let alone trade). Flat-risk sizing removes that feedback loop so every
// signal that survives the one-position-at-a-time rule gets a fair shot at
// sizing, for measuring R-multiple statistics on the full sample - it does
// not change, and must never be used to change, CLAUDE.md section 4's live
// sizing formula.
export function computeFixedRiskPositionSize(input: FixedRiskPositionSizingInput): PositionSizingResult | null {
  const { entry, sl, spec, riskUsdt = FIXED_RISK_USDT_FOR_MEASUREMENT } = input;
  return sizeForTargetRisk(riskUsdt, entry, sl, spec);
}
