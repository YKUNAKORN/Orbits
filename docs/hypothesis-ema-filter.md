# EMA filter hypothesis: does 7/30/99 flip 5m net expectancy positive?

Status: pre-registered. Written before any hypothesis-EMA-filter code change,
backtest run, or result file exists. **This file's "Background", "What is
tested", "Pass criteria", "Supplementary statistical context", and
"Implementation constraint" sections are never edited after that point,
regardless of the result.** If a criterion turns out to be ambiguous or
inconvenient once results are in, that is reported as a limitation in the
"Results" section appended below (per the reporting requirements), not fixed
here retroactively.

## Background

Phase 2 and Phase 2b (`docs/hypothesis-2b.md`, `docs/phase2b-results.md`)
established that the frozen 5m signal (CLAUDE.md section 4: EMA12/26/100
trend filter + 3 consecutive strong candles) has negative net expectancy in
every cost scenario tested, both in-sample and out-of-sample, despite a thin
positive gross edge (previously measured around 34-35% win rate, against the
33.33% zero-cost break-even for 2:1 reward:risk).

This is a separate, standalone hypothesis test of one specific idea: that
changing the three EMA trend-filter periods from 12/26/100 to 7/30/99 raises
the gross win rate on 5m enough to flip net expectancy positive. It is
explicitly **not** a proposal to change CLAUDE.md section 4. Per the task
instructions, CLAUDE.md section 4 is not touched by this work in any letter,
and the result of this test - pass or fail - is never merged back into the
frozen spec regardless of how it comes out.

## What is tested

Two EMA period sets, replayed on the exact same 5m candle history already
cached from Phase 2 (`data/DOT-USDT-SWAP-5m.json`, 630,530 candles,
2020-08-25T04:35Z -> 2026-08-23T12:40Z - not refetched, so this run is
directly comparable to the existing 5m baseline numbers on identical data):

- **Baseline**: EMA 12/26/100 (CLAUDE.md section 4's frozen formula, unmodified)
- **Hypothesis**: EMA 7/30/99

Unmodified, in both runs:
- The 3-consecutive-strong-candle test (body > 50% of range, same bar taken
  as bar[0], bar[1], bar[2]).
- Entry = close of bar[0]. SL = low[2] (long) / high[2] (short).
  TP = entry +/- 2R.
- One-position-at-a-time, same engine (`backtestEngine.ts`'s `runScenario`).
- Same fee/slippage/ambiguity/funding model as CLAUDE.md sections 4-5 and the
  existing backtest engine.
- Same live-fetched instrument spec (`data/instrument-DOT-USDT-SWAP.json`:
  ctVal=1, tickSz=0.0001, lotSz=1, minSz=1).
- 500-bar warmup before trusting the slow EMA (`SIGNAL_MIN_WARMUP_BARS`,
  unchanged): verified sufficient for both period sets tested here (a
  period-100 EMA's seed error after 500 bars is ~5e-5; a period-99 EMA's is
  ~4e-5 - both negligible). This is not turned into a formula of the slow
  period, since only these two specific period sets are ever tested (see
  below).

The only variable that changes between the two runs is the three EMA periods
fed into `computeSignal`'s trend filter. This requires `computeSignal` to
accept the periods as a parameter - see "Implementation constraint" below.

**Sizing: fixed-risk only, for both EMA sets.** Both runs are measured using
`computeFixedRiskPositionSize` (flat 2 USDT risk per trade, no equity, no
compounding - the existing measurement-only mode from the prior phase, see
README "Fixed-risk measurement mode"), never the frozen spec's 2%-of-equity
compounding sizing. Phase 2b found that compounding sizing lets a losing
stretch shrink equity far enough that later signals get rejected for falling
under `minSz`, truncating the very sample this comparison needs (5m's
compounding out-of-sample run kept only 155 of 1,963 signals that reached
sizing). Fixed-risk sizing is used for **both** EMA sets so neither side of
the comparison is an artifact of one side's sizing truncating its sample
differently from the other's, and so the out-of-sample trade-count criterion
below is measured on an untruncated sample.

Only these two period sets are tested. **No other EMA period combination is
tried, regardless of how this result comes out.** This is a single, specific
hypothesis test, not a parameter search - running more combinations after
seeing this one's result would be exactly the kind of post-hoc tuning this
pre-registration exists to prevent.

This is Phase 2 (backtest) discipline, applied to a standalone side
hypothesis - not Phase 3. A pass here is not, by itself, authorization to
start paper trading, to change CLAUDE.md section 4, or to try further EMA
period combinations.

## Pass criteria (fixed in advance, ALL required for the hypothesis (7/30/99) to be reported as passing)

These four criteria apply to the **hypothesis (7/30/99)** run. The baseline
(12/26/100) run is measured alongside purely as (a) the comparison reference
for the win-rate-delta reporting below, and (b) the byte-for-byte-behavior
regression check on the parameterization refactor - it is not itself
"graded" against these criteria (Phase 2/2b already established the frozen
spec fails on net expectancy; that is not re-litigated here).

1. **Net expectancy (mean R-multiple) is positive in BOTH the in-sample
   (first 70% of the data's chronological range) and out-of-sample (last
   30%) windows.** Split point per `computeSplitTs` (`src/backtestEngine.ts`),
   the same 70/30 rule Phase 2 and Phase 2b used.

2. **Measured in the canonical scenario: slippage = 1 tick, ambiguity
   resolved to the LOWER bound** (a bar that touches both TP and SL in the
   same period resolves as SL) **, limit-tp fee model** (entry taker 0.05%,
   TP maker 0.02%, SL taker 0.05% - CLAUDE.md section 4's execution policy).
   The same canonical scenario Phase 2 and Phase 2b both used.

3. **The out-of-sample net expectancy specifically must be positive under
   the limit-tp fee model** (not merely under the all-taker fee model, which
   is an easier bar to clear because it drops the maker-TP assumption). This
   restates part of criteria 1-2 rather than naming an independent scenario -
   it is called out on its own because the out-of-sample number, under the
   real execution policy, is what this whole hypothesis stands or falls on.

4. **Out-of-sample trade count (sample size in the criterion-2 scenario's
   out-of-sample window) is at least 100.** Below that, a positive
   out-of-sample expectancy is not trusted regardless of sign - too few
   trades for the number to mean anything. Fixed-risk sizing (above) is what
   makes this criterion measurable on an untruncated sample.

A hypothesis run that fails any single one of these four is reported as
**not passing** - full stop, there is no "close" or "3 out of 4."

## Supplementary statistical context (reported, not a pass/fail gate)

This hypothesis is fundamentally a comparison of two win rates (proportions).
A two-proportion z-test comparing the hypothesis's overall gross win rate
against the baseline's overall gross win rate (both fixed-risk sizing, gross
= fee/slippage/funding all zero) is reported alongside the pass/fail table,
with the resulting z-statistic and two-tailed p-value. This is disclosed for
context on whether an observed win-rate lift is distinguishable from sampling
noise - it does **not** gate the pass/fail verdict above, which is decided
purely by criteria 1-4. Sample-size and multiple-testing caveats are reported
alongside this number, not hidden, per the lesson from Phase 2b's permutation-
null bug (see `docs/phase2b-results.md`'s auditor finding).

## Implementation constraint (fixed in advance)

`computeSignal` (`src/signal.ts`) gains an optional second parameter carrying
the three EMA periods, defaulting to `{ fast: 12, mid: 26, slow: 100 }` (the
frozen spec's values). No other line of signal logic changes - not the
strong-candle test, the warmup gate, the consecutive-spacing check, the
entry/SL/TP formula, or the degenerate-SL guard. A test must show the default
periods produce identical output to the pre-refactor function on the existing
fixtures, and the `auditor` subagent independently re-verifies this claim
from the diff before results are reported as final.

## Reporting requirements

- Results are appended to this file, in a new section below this line
  (clearly marked as added after the fact), and to `README.md` - never edited
  into the sections above this line.
- Both EMA sets' full metrics (trade counts, gross win rate, gross
  expectancy R, net expectancy R, break-even win rate vs. achieved win rate)
  are reported side by side for both in-sample and out-of-sample, not just
  whichever set looks better.
- The win-rate delta (hypothesis minus baseline, in percentage points) is
  reported explicitly against the measured baseline from this run. The task
  that requested this test cited a prior reference figure of 34.48% for the
  existing baseline; that figure is compared against what this run actually
  measures for the 12/26/100 baseline under fixed-risk sizing, and if the two
  do not match exactly, the gap and its likely cause (sizing mode or
  measurement-path differences from the Phase 2/2b figures, which used
  compounding sizing and/or a different comparator scenario) are disclosed,
  not silently reconciled.
- Every criterion above is checked and shown individually as pass/fail, not
  just a final verdict.

## Auditor gate

Per CLAUDE.md section 7, the `auditor` subagent reviews this work before
results are reported as final, specifically including:

(a) whether this file's frozen sections (listed at the top of this document)
were altered after being written. **Correction, recorded once discovered
rather than silently fixed:** the original plan here was to rely on
Windows/NTFS `CreationTime` (`Get-Item <path> | Select CreationTime`),
verified when this file was first written to read 2026-08-26 21:01:11 -
before `src/hypothesisEmaFilter.ts` existed or had been run. That plan
assumed CreationTime survives later in-place edits. It does not survive
edits made by this coding agent's file-editing tool: every edit to this
file (including the one that first documented this very problem) resets its
own CreationTime forward to that edit's time. This has now been observed
happening on this file **at least twice** in the course of writing this
section alone, which is itself sufficient proof that CreationTime cannot be
used as evidence for this specific file, in either direction, from this
point on - citing whatever CreationTime happens to read at any given moment
would itself go stale on the next edit, so this document deliberately does
not cite one. (`data/hypothesis-ema-filter-results.json` and
`data/hypothesis-ema-filter-report.txt`, being written once by the backtest
script and never edited afterward, do not have this problem themselves -
this specifically affects only this hypothesis document, because step 5's
instructions have its own results appended into it rather than into a
separate file the way `docs/phase2b-results.md` was.) What is actually being
relied on instead: (i) the session record - the hypothesis and criteria
sections were written and their CreationTime independently checked via
PowerShell before `src/hypothesisEmaFilter.ts` existed or ran, which the
auditor cannot re-verify from disk alone but can weigh as testimony, and
(ii) content consistency - whether the criteria as stated here match what
`src/hypothesisEmaFilter.ts` actually computes and gates on, and whether the
criteria read as generic pre-registered bars rather than as values
reverse-engineered from the specific result (the `auditor` subagent
performed exactly this consistency check and rated it "weak-positive" -
credible on content, but explicitly **not** confirmed, and not upgradable
from disk at this point). This is a real limitation, not a formality: per
`docs/phase2b-results.md`'s own auditor finding on the same question, "a
filesystem mtime is not cryptographically tamper-evident... the fix is to
commit the hypothesis file by itself, before the first run" - that fix was
not applied here either (no commit was made at any point during this task,
and by the time this was noticed it was too late to retroactively apply);
and

(b) whether the `computeSignal` parameterization preserves identical output
at the default (12/26/100) periods versus the pre-refactor implementation,
verified from the diff and the test suite, not merely asserted.

---

## Results (added 2026-08-26, after the run below)

Everything in the five frozen sections listed at the top of this document
(Background / What is tested / Pass criteria / Supplementary statistical
context / Implementation constraint) is unedited since it was first written.
The "Auditor gate" section above this one is *not* in that freeze list and
was updated once, after the run, to document a provenance-mechanism problem
discovered along the way (see there) - an earlier version of this line
claimed nothing above it had been touched at all, which the `auditor`
subagent correctly flagged as false (that section's own edit postdates the
run it describes). Corrected here rather than left standing.

Ran via `npm run hypothesis:ema-filter` against the cached 5m data (630,530
candles, 2020-08-25T04:35Z -> 2026-08-23T12:40Z - the same range Phase 2/2b
used, not refetched). Full output: `data/hypothesis-ema-filter-report.txt`,
`data/hypothesis-ema-filter-results.json` (both gitignored, regenerated by
rerunning the command above; their file creation time was 2026-08-26
21:07:00). This document's own criteria sections were written and checked
via PowerShell at 21:01:11, before `src/hypothesisEmaFilter.ts` existed -
6 minutes before the result files above - but that ordering is no longer
independently verifiable from this file's current filesystem metadata,
because appending this Results section reset its own CreationTime forward
past the result files it predates. See the correction in the "Auditor gate"
section above for the full explanation; this is disclosed rather than
glossed over.

### Side by side (fixed-risk sizing, both EMA sets)

| | baseline (12/26/100) | hypothesis (7/30/99) |
|---|---|---|
| in-sample n | 2,856 | 2,903 |
| out-of-sample n | 1,277 | 1,276 |
| gross win rate, overall | 34.48% | 34.53% |
| gross win rate, in-sample | 34.24% | 34.41% |
| gross win rate, out-of-sample | 35.00% | 34.80% |
| gross expectancy R, overall | +0.034 | +0.036 |
| gross expectancy R, in-sample | +0.027 | +0.032 |
| gross expectancy R, out-of-sample | +0.050 | +0.044 |
| net expectancy R, in-sample | -0.109 | -0.104 |
| net expectancy R, out-of-sample | -0.086 | -0.093 |
| break-even win rate, in-sample | 37.82% | 37.84% |
| achieved win rate (net), in-sample | 34.24% | 34.41% |
| break-even win rate, out-of-sample | 37.83% | 37.84% |
| achieved win rate (net), out-of-sample | 35.00% | 34.80% |
| ambiguous bars, in-sample | 0 (0.00%) | 0 (0.00%) |
| ambiguous bars, out-of-sample | 2 (0.16%) | 2 (0.16%) |

Funding: ~30.5% of canonical-scenario trades on both EMA sets cross a
funding settlement (above the 5% materiality bar), modeled at a constant
0.00337%/8h (mean realized rate over the 279 cached records, 2026-05-25 to
2026-08-26 - same approximation-disclosure caveat as every prior phase: OKX
only retains a few months of this endpoint, so this rate is a proxy for the
full 2020-2026 history, not a real historical rate).

### Refactor verification (Implementation constraint, above)

The `auditor` subagent independently confirmed the `computeSignal`
parameterization preserves identical default (12/26/100) behavior, three
ways: (1) `git diff` review showing only the EMA-period lines changed, every
other line of signal logic byte-for-byte unchanged; (2) running `prepareData`
on the full 630,530-candle series with the parameter omitted vs. passed
explicitly as `{12,26,100}` and diffing the serialized signal sets
(identical, 6,901 signals both ways); (3) cross-checking against this
repo's own pre-existing (pre-refactor) artifacts, `data/backtest-report.txt`
and `data/diagnosis-report.txt`, both of which independently state the same
6,901 raw signals / 4,133 sized trades / 34.4786% gross win rate this run's
baseline reproduces. One wording nuance the auditor raised: the "Implementation
constraint" section above says a test must show the default periods match
"the pre-refactor function" - no such test can literally exist once the
refactor lands, since the pre-refactor function no longer exists to call.
The claim is nonetheless established, by items (2) and (3) above rather than
by the single before/after-style unit test in `signal.test.ts` alone. That
section's wording is left as originally written (it is in the frozen list),
noted here rather than edited there.

### Win-rate delta

Measured baseline gross win rate (fixed-risk, overall): **34.48%** (34.4786%
unrounded) - matches the cited reference figure from the task that
requested this test to the cited figure's own precision. The `auditor`
subagent traced this exact number to `data/diagnosis-report.txt`'s existing
fixed-risk gross comparator, confirming it is the same sizing mode and the
same measurement path, not a coincidence - so there is no sizing-mode
discrepancy to disclose here (the hedge built into the pre-registered doc
above turned out not to be needed). Hypothesis:
**34.53%**, a lift of **+0.05 percentage points**.

That headline number hides a split that matters: the lift is entirely an
in-sample effect (34.24% -> 34.41%, +0.17pp). Out-of-sample, the
hypothesis's gross win rate is actually **lower** than baseline (35.00% ->
34.80%, -0.20pp). A change that only shows up in-sample and inverts
out-of-sample is the signature of noise or mild in-sample overfitting, not a
real, generalizing improvement - disclosed here even though it isn't one of
the four pass criteria, because it directly bears on whether "+0.05pp"
should be read as a real effect at all.

Supplementary two-proportion z-test (gross win rate, overall, hypothesis
n=4,179 vs baseline n=4,133): **z=0.049, two-tailed p=0.961**. This is about
as close to "no detectable difference" as this kind of test produces - the
+0.05pp overall delta is statistically indistinguishable from sampling
noise. (Reported for context only, per the pre-registered doc above - this
was never a pass/fail gate.)

**Correction flagged by the `auditor` subagent, not caught before that
review:** the two-proportion z-test above assumes the two samples are
independent. They are not - both EMA sets are filterings of the same
underlying candle series through the same 3-strong-candle pattern, and the
auditor measured 94.0% of gross trades sharing the same entry timestamp and
side across both sets, with 100% concordant win/loss outcomes on that shared
subset. The correct test for this comparison is a paired test over the
discordant trades (e.g. McNemar-style), not a pooled independent-samples
z-test - the independent-samples formula overstates the standard error here,
which means the *true* z-statistic is larger and the true p-value smaller
than reported above. Reassuringly, that error points in the conservative
direction for this hypothesis: correcting it would make "no detectable
difference" an even stronger conclusion, not a weaker one, so it does not
put the FAIL verdict (which does not depend on this test at all) at any
risk. Flagged here rather than quietly recomputed, because silently
replacing a reported statistic after an audit finding is exactly the kind
of thing this document's own reporting requirements exist to prevent -
readers should be able to see that the number above was checked and found
imprecise, not just see a different number appear.

### Pass criteria (hypothesis run only)

| # | Criterion | Result | Pass? |
|---|---|---|---|
| 1 | Net expectancy positive in-sample AND out-of-sample | in-sample -0.104R, out-of-sample -0.093R | **FAIL** (both negative) |
| 2 | Scenario = slip 1 tick, lower bound, limit-tp fee | applied throughout | PASS (by construction) |
| 3 | Out-of-sample net expectancy positive under limit-tp | -0.093R | **FAIL** |
| 4 | Out-of-sample trade count >= 100 | n=1,276 | PASS |

**Verdict: the hypothesis FAILS.** It fails on criteria 1 and 3 (net
expectancy stays negative both in-sample and out-of-sample under 7/30/99,
same sign as the 12/26/100 baseline). Per the pre-registered reporting rule,
failing even one criterion is sufficient - there is no partial credit - and
per the same rule, no other EMA period combination is tried on the strength
of "maybe a different one works."

**Upper ambiguity bound, checked by the `auditor` subagent (CLAUDE.md
section 5 requires reporting both bounds, not just the lower one this
script runs by default).** Ambiguous bars are rare here (2 of 4,133 trades,
0.05%, both in the out-of-sample window), but per CLAUDE.md section 5's own
rule both bounds must still be checked before concluding 1m data isn't
needed. The auditor reran the hypothesis set's out-of-sample scenario at the
upper bound (TP wins ties): **-0.08812R**, against **-0.09293R** at the
lower bound reported above. Both bounds are negative, so per CLAUDE.md
section 5 the system fails regardless of how the (very few) ambiguous bars
resolve, and 1m data is confirmed not needed for this conclusion.

Note also, flagged by the auditor: criterion 3 above is arithmetically the
second conjunct of criterion 1 (`hNetOut.expectancyR > 0` appears in both),
not an independent fourth check - the pre-registered doc already says as
much ("this restates part of criteria 1-2 rather than naming an independent
scenario"), so this is confirmation of an already-disclosed overlap, not a
new finding.

### Why: the gross edge barely moved, and it wasn't enough to matter

Baseline's own net expectancy is also negative here (in-sample -0.109R,
out-of-sample -0.086R), consistent with Phase 2/2b's existing finding that
the frozen spec has negative net expectancy under real costs - this run did
not overturn that, it re-confirms it under fixed-risk sizing on an
untruncated sample. The mechanism this hypothesis proposed - different EMA
periods changing the trend filter enough to raise gross win rate - moved in
the proposed direction on the overall number, but the magnitude is roughly
two orders of magnitude too small to matter: the persistent gap between
break-even win rate (~37.8%) and achieved win rate (~34-35%) is about
3-3.5 percentage points on both EMA sets; a +0.05pp (or even the more
favorable +0.17pp in-sample-only) shift closes essentially none of it.
Changing these 3 EMA periods within this plausible range does not materially
change how often 3 consecutive candles are "strong" or how the trend filter
gates them - the dominant cost problem (fees/slippage against a thin,
roughly period-invariant gross edge) that Phase 2's diagnosis identified is
not addressed by this lever.

Costs as a percentage of R (hypothesis, out-of-sample; computed by the
`auditor` subagent from the underlying trade data, not previously stated
here): fees alone are **~12.6% of R**; total cost drag (gross E[R] minus net
E[R]) is **~13.7% of R**, meaning slippage plus funding together contribute
roughly another 1% of R on top of fees. The ~3.3 percentage-point gap
between break-even win rate and achieved win rate is what a ~13.7%-of-R cost
load does to a thin edge at 2:1 reward:risk - not something a 3-period EMA
adjustment was ever likely to close.

### Conclusion

**This hypothesis does not pass the pre-registered bar.** EMA 7/30/99 does
not flip 5m net expectancy positive; it produces a win-rate lift
statistically indistinguishable from noise (+0.05pp overall, p=0.96) that
does not survive an in-sample/out-of-sample split (positive in-sample,
negative out-of-sample) and would not have been large enough to matter even
if it had. Per the task's explicit instruction, this result is not merged
into CLAUDE.md section 4 in any form, and no further EMA period combinations
are tried on the strength of this one falling short.
