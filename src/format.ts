export function pct(x: number, digits = 2): string {
  return Number.isFinite(x) ? `${x.toFixed(digits)}%` : "N/A";
}

export function usd(x: number, digits = 4): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "N/A";
}

export function num(x: number, digits = 3): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "N/A";
}
