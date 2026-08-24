// Minimal, dependency-free SVG chart primitives. Not a general charting
// library - just enough shared plumbing (scales, axes, paths) for the three
// static diagnostic charts in charts.ts.

export interface Scale {
  (value: number): number;
  invert(pixel: number): number;
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  fn.invert = (pixel: number) => d0 + ((pixel - r0) / (r1 - r0)) * span;
  return fn;
}

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface ChartCanvas {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  elements: string[];
}

export function createCanvas(width: number, height: number, margin: ChartCanvas["margin"]): ChartCanvas {
  return { width, height, margin, elements: [] };
}

export function plotArea(c: ChartCanvas): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: c.margin.left,
    y0: c.margin.top,
    x1: c.width - c.margin.right,
    y1: c.height - c.margin.bottom,
  };
}

export function addLine(c: ChartCanvas, x1: number, y1: number, x2: number, y2: number, opts: { stroke?: string; width?: number; dash?: string } = {}): void {
  const { stroke = "#333", width = 1, dash } = opts;
  c.elements.push(
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`,
  );
}

export function addPolyline(c: ChartCanvas, points: readonly [number, number][], opts: { stroke?: string; width?: number } = {}): void {
  const { stroke = "#1f6feb", width = 1.5 } = opts;
  const d = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  c.elements.push(`<polyline points="${d}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`);
}

export function addRect(c: ChartCanvas, x: number, y: number, w: number, h: number, opts: { fill?: string; stroke?: string } = {}): void {
  const { fill = "#1f6feb", stroke = "none" } = opts;
  c.elements.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0, w).toFixed(2)}" height="${Math.max(0, h).toFixed(2)}" fill="${fill}" stroke="${stroke}"/>`);
}

export function addText(c: ChartCanvas, x: number, y: number, content: string, opts: { size?: number; anchor?: "start" | "middle" | "end"; fill?: string; rotate?: number } = {}): void {
  const { size = 11, anchor = "start", fill = "#111", rotate } = opts;
  const transform = rotate !== undefined ? ` transform="rotate(${rotate} ${x.toFixed(2)} ${y.toFixed(2)})"` : "";
  c.elements.push(
    `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${transform}>${esc(content)}</text>`,
  );
}

export function render(c: ChartCanvas, title: string): string {
  const header = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}">`,
    `<rect x="0" y="0" width="${c.width}" height="${c.height}" fill="#ffffff"/>`,
    `<text x="${c.width / 2}" y="24" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" text-anchor="middle" fill="#111">${esc(title)}</text>`,
  ];
  return [...header, ...c.elements, "</svg>"].join("\n");
}
