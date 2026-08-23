// Decimal-safe rounding to an exchange step size (tickSz, lotSz, ...).
// Plain float math (Math.floor(x / step) * step) drifts by binary
// representation error. Parsing the step's own decimal-string precision
// keeps rounding exact for the step sizes OKX actually publishes.

function stepDecimals(step: string): number {
  const idx = step.indexOf(".");
  return idx === -1 ? 0 : step.length - idx - 1;
}

function stepUnits(step: string, scale: number): number {
  const units = Math.round(Number(step) * scale);
  if (!(units > 0)) throw new Error(`invalid step size "${step}"`);
  return units;
}

type RoundMode = "floor" | "ceil" | "round";

function toStep(value: number, step: string, mode: RoundMode): number {
  const scale = 10 ** stepDecimals(step);
  const units = stepUnits(step, scale);
  const valueUnits = value * scale;
  const n =
    mode === "floor" ? Math.floor(valueUnits / units) : mode === "ceil" ? Math.ceil(valueUnits / units) : Math.round(valueUnits / units);
  return (n * units) / scale;
}

// Rounds toward zero-risk / toward-book direction for order sizing: never
// round up past what was actually computed.
export function floorToStep(value: number, step: string): number {
  return toStep(value, step, "floor");
}

export function ceilToStep(value: number, step: string): number {
  return toStep(value, step, "ceil");
}

export function roundToStep(value: number, step: string): number {
  return toStep(value, step, "round");
}
