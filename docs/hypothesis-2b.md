# Phase 2b hypothesis: does timeframe explain Phase 2's cost problem?

Status: pre-registered. Written before any Phase 2b data is fetched or any
Phase 2b scenario is run. **This file is never edited after that point,
regardless of the result.** If a criterion turns out to be ambiguous or
inconvenient once results are in, that is reported as a limitation in
`docs/phase2b-results.md`, not fixed here retroactively.

## Background

Phase 2 (see README.md "Why Phase 2 is negative") found that the frozen
5m signal (CLAUDE.md section 4) has a thin gross edge (~34-35% win rate,
just above the 33.3% zero-cost break-even for 2:1 R:R) that is
statistically indistinguishable from a coin flip at the 100-trial
permutation test's resolution, and that real trading costs consistently
exceed that thin edge.

One candidate explanation: 5m is a high-turnover timeframe, so fixed
per-trade costs (fees, slippage, the tick-based ambiguity rule) eat a
larger fraction of a typically-tighter stop. A slower timeframe produces
wider SL distances in price terms, so the same fixed costs are a smaller
fraction of R. This phase asks whether that is true, and whether a
slower timeframe's edge (if any) is real or also within the noise floor.

## What is tested

The exact rule set in CLAUDE.md section 4 - unmodified - replayed on
candles of four timeframes: **5m** (carried over from the completed
Phase 2 run, not refetched or rerun), **15m**, **1H**, **4H**.

Unmodified means, precisely:
- `computeSignal` (`src/signal.ts`): EMA12/26/100 stacking, 3 consecutive
  strong candles (body > 50% of range), same source code, byte-for-byte.
- SL = `low[2]` / `high[2]`, TP = entry +/- 2R. Same formula.
- Position sizing: 2% equity risk, same formula, same live-fetched
  instrument spec (`ctVal`/`lotSz`/`minSz`/`tickSz` - these describe the
  DOT-USDT-SWAP contract, not the candle interval, so the same cached
  spec is correct for every timeframe in this test).
- One-position-at-a-time, same engine (`backtestEngine.ts`'s
  `runScenario`), same fee/slippage/funding model as CLAUDE.md section 5.

The only variable that changes between the four runs is which OKX candle
endpoint (`bar=5m|15m|1H|4H`) the input data comes from. This is a
measurement of the existing frozen spec on different data, not a
proposal to change CLAUDE.md section 4. **CLAUDE.md section 4 itself is
not modified by this phase, in any letter, regardless of outcome.**

This is still Phase 2 discipline (measure/backtest), not Phase 3. No
timeframe "passing" this phase authorizes starting paper trading by
itself - that requires a separate, explicit go-ahead per CLAUDE.md
section 5.

## Pass criteria (fixed in advance, ALL four required per timeframe)

For a given timeframe to be reported as passing, every one of the
following must hold. Partial credit does not count as passing.

1. **Net expectancy (mean R-multiple) is positive in BOTH the in-sample
   (first 70% of that timeframe's own chronological data range) and
   out-of-sample (last 30%) windows.** Split point per
   `computeSplitTs` (`src/backtestEngine.ts`), same 70/30 rule as Phase 2.

2. **Measured at slippage = 1 tick and the LOWER ambiguity bound** (a bar
   that touches both TP and SL in the same period resolves as SL) **with
   the `limit-tp` fee model** (entry taker 0.05%, TP maker 0.02%, SL
   taker 0.05% - CLAUDE.md section 4's execution policy). This is the
   same "canonical" scenario Phase 2 and the Phase 2 diagnosis both used
   (`slip=1t bound=lower fee=limit-tp`), applied here for continuity, not
   the most flattering of the 12 scenarios the backtest engine computes.
   Funding cost is included if that timeframe's canonical run crosses the
   same >=5% materiality bar `backtest.ts` already applies; left at 0
   otherwise, exactly as in Phase 2.

3. **Gross win rate (fee=0, slippage=0, funding=0) is strictly above the
   95th percentile of a 1000-trial permutation null**, at that same
   timeframe. The permutation null is unchanged from Phase 2's method
   (`src/randomBaseline.ts`): every real signal anchor's exact bar[0]/
   bar[2] is reused, only long-vs-short is re-drawn by a fair coin per
   anchor, fed through the same unmodified `runScenario`. 1000 trials
   (not the 100 Phase 2 used) for finer resolution around the 95th
   percentile; same fixed seed (`20260824`) reused for every timeframe -
   chosen once, before any run, not tuned per timeframe.

4. **Out-of-sample trade count (sample size in the criterion-2 scenario's
   out-of-sample window) is at least 100.** Below that, a positive
   out-of-sample expectancy is not trusted regardless of sign - too few
   trades for the number to mean anything.

A timeframe that fails any single one of these four is reported as
**not passing**, full stop - there is no "close" or "3 out of 4."

## Multiple-testing disclosure (required, not a pass/fail gate)

Four timeframes are tested (5m + 15m + 1H + 4H). Running the same
permutation-percentile test four times raises the chance that at least
one shows a spuriously high percentile by chance alone, even if none of
the four have real directional edge. `docs/phase2b-results.md` reports,
for every timeframe that meets criterion 3 at the raw 95th-percentile
bar, whether it would still meet it after a Bonferroni correction for 4
comparisons: family-wise alpha 0.05 / 4 tests = 0.0125 per-test alpha,
i.e. the corrected bar is the **98.75th** percentile of that timeframe's
own 1000-trial null, not the 95th. This correction is reported
alongside the raw result for every timeframe that clears criterion 3,
not used to silently redefine "pass" in the criteria above.

## Reporting requirements

- `docs/phase2b-results.md` reports all four timeframes, in the fixed
  order 5m, 15m, 1H, 4H - never sorted or filtered by which looks best.
- Every timeframe's pass/fail is shown against all four criteria
  individually, not just the final verdict.
- If zero timeframes pass, the conclusion is that this pattern has no
  demonstrated edge on any tested timeframe, and Phase 2b closes the
  timeframe question - no further timeframes get tried on the strength
  of "maybe a different one works."
- If one or more timeframes pass, that is reported as a candidate for a
  future, separate, explicit proposal against CLAUDE.md section 4 - not
  as an automatic green light to edit the spec or start Phase 3.

## Auditor gate

Per CLAUDE.md section 7, the `auditor` subagent reviews this work before
results are reported as final, specifically including whether this
criteria file was altered after being written (its file mtime must
precede every Phase 2b result file's mtime, and its content must match
what is quoted/applied in `docs/phase2b-results.md`).
