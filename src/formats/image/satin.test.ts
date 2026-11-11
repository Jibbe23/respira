import { describe, it, expect } from "vitest";
import { satinStitches, type SatinOptions } from "./satin";
import type { Point, Ring } from "./fillStitches";

const OPTIONS: SatinOptions = {
  spacing: 4,
  pullCompensation: 2,
  underlayStitch: 20,
  maxWidth: 50,
};

const rect = (x: number, y: number, w: number, h: number): Ring => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const circle = (cx: number, cy: number, r: number, n = 72): Ring =>
  Array.from({ length: n }, (_, i) => ({
    x: cx + r * Math.cos((2 * Math.PI * i) / n),
    y: cy + r * Math.sin((2 * Math.PI * i) / n),
  }));

/** Distance from p to the nearest stitch (segment between run points) */
function distanceToRun(p: Point, run: Point[]): number {
  let best = Infinity;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1];
    const b = run[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

describe("satinStitches", () => {
  it("sews a bar with stitches across it from edge to edge", () => {
    // 20 mm long, 1.5 mm wide
    const run = satinStitches([rect(0, 0, 200, 15)], null, OPTIONS)!;
    expect(run).not.toBeNull();

    // Stitches reach both edges plus the pull compensation, no further
    const ys = run.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(-2, 0);
    expect(Math.max(...ys)).toBeCloseTo(17, 0);
    // From one end of the bar to the other
    const xs = run.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThan(3);
    expect(Math.max(...xs)).toBeGreaterThan(197);

    // Dense: a peak on each side every 0.4 mm along most of the bar
    const across = run.filter(
      (p, i) => i > 0 && Math.abs(p.y - run[i - 1].y) > 15,
    );
    expect(across.length).toBeGreaterThan(90);
  });

  it("covers a T junction without gaps, in one run", () => {
    const rings = [rect(0, 0, 200, 20)];
    // Stem below the middle of the bar, joined to it
    rings[0] = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 150 },
      { x: 90, y: 150 },
      { x: 90, y: 20 },
      { x: 0, y: 20 },
    ];
    const run = satinStitches(rings, null, OPTIONS)!;
    expect(run).not.toBeNull();
    // Every point inside the shape lies close to a stitch
    for (let x = 2; x < 200; x += 4) {
      expect(distanceToRun({ x, y: 10 }, run)).toBeLessThan(2.5);
    }
    for (let y = 22; y < 148; y += 4) {
      expect(distanceToRun({ x: 100, y }, run)).toBeLessThan(2.5);
    }
  });

  it("sews a ring (an o) and stays on it", () => {
    const run = satinStitches(
      [circle(100, 100, 60), circle(100, 100, 45).reverse()],
      null,
      OPTIONS,
    )!;
    expect(run).not.toBeNull();
    const radii = run.map((p) => Math.hypot(p.x - 100, p.y - 100));
    expect(Math.min(...radii)).toBeGreaterThan(42);
    expect(Math.max(...radii)).toBeLessThan(63);
    // All the way round
    for (let k = 0; k < 36; k++) {
      const angle = (2 * Math.PI * k) / 36;
      const p = {
        x: 100 + 52 * Math.cos(angle),
        y: 100 + 52 * Math.sin(angle),
      };
      expect(distanceToRun(p, run)).toBeLessThan(2.5);
    }
  });

  it("starts at the end nearest to the needle", () => {
    const run = satinStitches(
      [rect(0, 0, 200, 15)],
      { x: 210, y: 7 },
      OPTIONS,
    )!;
    expect(run[0].x).toBeGreaterThan(180);
  });

  it("leaves wide shapes to the tatami fill", () => {
    // 8 mm wide bar
    expect(satinStitches([rect(0, 0, 300, 80)], null, OPTIONS)).toBeNull();
  });
});
