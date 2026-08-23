# DOT 5m Trading Bot

Personal automated trading bot for OKX. Single user, single instrument, no multi-tenancy.

---

## 1. Communication and skills

- Use the **caveman** skill for all chat responses in this project, to save tokens.
  It compresses chat prose only. Code, comments, commit messages, docs, and the
  auditor's reports stay in normal English.
- Drop caveman for: security warnings, irreversible actions, and any multi-step
  instruction where compression could cause a misread.
- Before creating any file or writing code, check for relevant skills and read them.
- Never enable caveman for the `auditor` subagent. Its findings must be fully explained.

---

## 2. Coding rules (non-negotiable)

- Comments in English only.
- No emoji anywhere in code, output, logs, or commit messages.
- TypeScript everywhere. `any` is banned. If a type is genuinely unknown, use `unknown`
  and narrow it. Build must pass with no type errors.
- Clean naming. A variable called `total` that actually holds required margin is a bug
  waiting to happen. Name things what they are.
- Do not over-engineer. No abstraction layers, plugin systems, or config frameworks that
  serve a hypothetical future. One user, one instrument, one timeframe.
- After writing or changing code, run it and verify it does what it is supposed to do.
  "It compiles" is not verification.
- Money-related numbers: never use floating point for order sizes or prices where
  precision matters. Follow the exchange's tick and lot sizes exactly.

---

## 3. Language choice

Everything in TypeScript, including the backtest.

Rationale: the signal logic must be written **once** and imported by both the backtest
and the live bot. If the backtest is Python and the bot is TypeScript, the two will
drift, and the drift will not be discovered until real money is lost. The indicator
math here is simple (EMA plus a candle body ratio) and does not need pandas.

The signal module must be pure: `(candles: Candle[]) => Signal | null`. No network
calls, no clock reads, no side effects. Both the backtest and the live bot feed it
the same shaped input.

---

## 4. Frozen trading spec

Any change to this section requires explicit approval from the user. Do not "improve" it.

**Instrument:** `DOT-USDT-SWAP` on OKX. Timeframe 5m. Perpetual. Cross margin.
Leverage setting 50x (this is a ceiling for margin efficiency, not the risk model).

**Signal (closed bars only, never the in-progress candle):**

```
strong(bar)  = (high - low) > 0 AND |close - open| > 0.5 * (high - low)
bar[0] = the signal bar, bar[2] = first candle of the three

LONG  = strong up on [0],[1],[2]   AND  EMA12 > EMA26 > EMA100
SHORT = strong down on [0],[1],[2] AND  EMA12 < EMA26 < EMA100
```

EMAs are computed on close. Feed at least 500 warm-up bars before trusting EMA100.

**Trade levels:**

```
entry = close of bar[0]
SL    = low[2]   for long
        high[2]  for short
TP    = entry + 2 * (entry - SL)   for long
        entry - 2 * (SL - entry)   for short
```

**Position rule:** exactly one open position at a time. A new signal while a position
is open is ignored and logged, never queued, never merged. This is enforced by the
bot's own state machine. OKX will NOT reject a second order: in net mode it merges
into the existing position and recalculates avgPx, silently invalidating the SL and TP.

**Position sizing:** risk 2% of account equity per trade, measured as the loss if SL
is hit. Fees are deliberately excluded from this formula (but must always be included
in backtest P&L).

```ts
// All inputs from live sources. Nothing hardcoded.
const riskUsdt = equityUsdt * RISK_PER_TRADE;        // 0.02
const slPct = Math.abs(entry - sl) / entry;          // fraction, not percent
if (slPct <= 0) return null;                         // reject, do not divide

const targetNotional = riskUsdt / slPct;
const coinQty = targetNotional / entry;
const rawContracts = coinQty / ctVal;

// Always floor. Rounding up exceeds the risk budget.
const contracts = Math.floor(rawContracts / lotSz) * lotSz;
if (contracts < minSz) return null;                  // skip the trade, never round up

// Recompute what the risk actually is after rounding, and check it.
const actualNotional = contracts * ctVal * entry;
const actualRiskUsdt = actualNotional * slPct;
if (actualRiskUsdt > riskUsdt * 1.05) return null;   // hard guard

const marginUsdt = actualNotional / leverage;        // informational only
```

`ctVal`, `lotSz`, `minSz`, `tickSz` are fetched from
`GET /api/v5/public/instruments?instType=SWAP&instId=DOT-USDT-SWAP`.
Hardcoding any of them is a bug.

**Order execution policy:**

| Leg   | Order type | Fee tier | Why |
| ----- | ---------- | -------- | --- |
| Entry | Market (taker) | 0.05% | The strategy is momentum continuation. A passive limit at the signal bar's close only fills when price comes back to it, so it fills on reversals and misses continuations. Certain fill matters more than 0.03%. |
| TP    | Limit (maker)  | 0.02% | The exit price is known in advance and sits away from market, so it can rest on the book. This is the one place where maker pricing is free. |
| SL    | Market on trigger (taker) | 0.05% | A stop-limit can fail to fill in a fast move. Under cross margin there is no automatic loss cap, so an unfilled stop exposes the whole account. Slippage is the cheaper risk. |

On OKX, market execution for a triggered algo order is expressed as `slOrdPx: "-1"`.

Never chase a resting TP with a market order to "make sure it closes". That converts a
maker fill into a taker fill at a worse price and destroys the reason for using a limit
in the first place. If the TP has not filled, the position is simply still open and the
SL still protects it.

---

## 5. Phase discipline

Do not build ahead of the current phase. Ask before starting the next one.

1. **Measure** — fetch OKX history, count signals, measure the SL distance
   distribution, count how many signals survive the one-position rule.
2. **Backtest** — full P&L with fees, slippage, and funding. 1m data used to resolve
   intrabar TP/SL ordering. In-sample and out-of-sample split.

   Fill model, matching the execution policy above:
   - Entry fills at the signal bar's close, plus slippage against the trade, taker fee.
   - TP fills only when price trades at least one `tickSz` **beyond** the TP level, not
     merely touching it. A resting limit that is only tagged by a wick may not fill.
     Fills at the TP price exactly, maker fee, no slippage.
   - SL triggers on touch, fills at the SL price minus slippage against the trade,
     taker fee.
   - If a single 5m bar reaches both levels, resolve the order with 1m data. If the 1m
     data is also ambiguous, assume SL first.
   - Report results twice: once with this model, and once assuming every exit is a
     taker fill. The gap between the two is the value of the limit TP, and it is only
     real if the demo phase confirms a comparable maker fill rate.
3. **Paper trade** — OKX demo. Verify live signals match backtest signals exactly.
4. **Live** — smallest size that clears `minSz`, plus a kill switch.
5. **Dashboard** — read-only status plus kill switch. Mobile-responsive. Single user,
   no auth framework, no accounts, no roles. Only after phase 4 is stable.

Building a dashboard before phase 2 passes is wasted work.

---

## 6. Execution safety requirements

These apply to any code that touches a real or demo account.

- Every order carries a `clOrdId`. A retry after a timeout must never double-fill.
- On startup, reconcile against OKX: query open positions AND open algo orders before
  making any decision. Local state files are never trusted.
- A network timeout is not a failure. The order may have filled. Query before retrying.
- If entry fills but the SL order fails to place, this is a critical incident. The bot
  must attempt to flatten the position and then halt. In cross margin there is no
  automatic loss cap.
- Kill switch: a single action that cancels all orders, flattens the position, and stops
  the bot from opening anything new.
- Daily loss limit. When hit, stop trading until manually reset.
- API keys: trade permission only, never withdraw. IP allowlist enabled. Keys in
  environment variables, never in the repo, never in logs.

---

## 7. Audit gate

Run the `auditor` subagent before:

- any commit that touches signal logic, the backtest engine, position sizing,
  order execution, or the position state machine
- any run against the demo or live account

The auditor is read-only by design. Do not grant it write tools, and do not act on
its findings by silently patching. Report findings to the user first.
