import { describe, it, expect } from "vitest";
import { planSatin, sewSatin, type SatinOptions } from "./satin";
import type { Point, Ring } from "./fillStitches";

const OPTIONS: SatinOptions = {
  spacing: 4,
  pullCompensation: 2,
  underlayStitch: 20,
  maxWidth: 50,
};

/** Plan and sew as the conversion does; null when not satin */
function satinStitches(
  rings: Ring[],
  start: Point | null,
  options: SatinOptions,
): Point[][] | null {
  const plan = planSatin(rings, options);
  return plan ? sewSatin(plan, start, options) : null;
}

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

/** Satin of a shape that must come out as one connected run */
function sewOne(rings: Ring[], start: Point | null = null): Point[] {
  const runs = satinStitches(rings, start, OPTIONS);
  expect(runs).not.toBeNull();
  expect(runs).toHaveLength(1);
  return runs![0];
}

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
    const run = sewOne([rect(0, 0, 200, 15)]);

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
    const run = sewOne(rings);
    // Every point inside the shape lies close to a stitch
    for (let x = 2; x < 200; x += 4) {
      expect(distanceToRun({ x, y: 10 }, run)).toBeLessThan(2.5);
    }
    for (let y = 22; y < 148; y += 4) {
      expect(distanceToRun({ x: 100, y }, run)).toBeLessThan(2.5);
    }
  });

  it("sews a ring (an o) and stays on it", () => {
    const run = sewOne([circle(100, 100, 60), circle(100, 100, 45).reverse()]);
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
    const run = sewOne([rect(0, 0, 200, 15)], { x: 210, y: 7 });
    expect(run[0].x).toBeGreaterThan(180);
  });

  it("keeps short arms such as the bar of a t", () => {
    // Stem 1.5 mm wide, bar sticking out 1.5 mm on each side
    const t: Ring = [
      { x: 15, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 40 },
      { x: 45, y: 40 },
      { x: 45, y: 55 },
      { x: 30, y: 55 },
      { x: 30, y: 150 },
      { x: 15, y: 150 },
      { x: 15, y: 55 },
      { x: 0, y: 55 },
      { x: 0, y: 40 },
      { x: 15, y: 40 },
    ];
    const run = sewOne([t]);
    expect(distanceToRun({ x: 3, y: 47 }, run)).toBeLessThan(2.5);
    expect(distanceToRun({ x: 42, y: 47 }, run)).toBeLessThan(2.5);
  });

  it("sews parts that do not touch as separate runs", () => {
    const runs = satinStitches(
      [rect(0, 0, 200, 15), rect(0, 115, 200, 15)],
      null,
      OPTIONS,
    )!;
    expect(runs).toHaveLength(2);
    // No stitch from one bar to the other
    for (const run of runs) {
      const ys = run.map((p) => p.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(25);
    }
  });

  it("leaves wide shapes to the tatami fill", () => {
    // 8 mm wide bar
    expect(satinStitches([rect(0, 0, 300, 80)], null, OPTIONS)).toBeNull();
    // A thin line with a 6 mm blob: satin there would be too long
    const blob: Ring = [
      { x: 0, y: 0 },
      { x: 800, y: 0 },
      { x: 800, y: -25 },
      { x: 860, y: -25 },
      { x: 860, y: 35 },
      { x: 800, y: 35 },
      { x: 800, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(satinStitches([blob], null, OPTIONS)).toBeNull();
  });

  it("leaves short, wide blobs to the tatami fill", () => {
    // A bow lobe (6 x 4.4 mm) and the stubby tip of a shape (4 x 2.5 mm):
    // a short center line fans out and leaves the ends bare
    const lobe: Ring = Array.from({ length: 72 }, (_, i) => ({
      x: 30 * Math.cos((2 * Math.PI * i) / 72),
      y: 22 * Math.sin((2 * Math.PI * i) / 72),
    }));
    expect(satinStitches([lobe], null, OPTIONS)).toBeNull();
    expect(satinStitches([rect(0, 0, 40, 25)], null, OPTIONS)).toBeNull();
  });

  it("keeps short thin lines such as closed eyes in satin", () => {
    expect(satinStitches([rect(0, 0, 25, 8)], null, OPTIONS)).not.toBeNull();
    // A bold i stem: 6 mm long, 1.8 mm wide
    expect(satinStitches([rect(0, 0, 18, 60)], null, OPTIONS)).not.toBeNull();
  });

  it("keeps the peaks evenly spaced on the outside of curves", () => {
    // An o with a 2 mm stroke around a 1 mm hole: on the outer edge the
    // peaks would fan out to 1.5 times the spacing
    const plan = planSatin([circle(0, 0, 30), circle(0, 0, 10)], OPTIONS);
    expect(plan).not.toBeNull();
    let widest = 0;
    for (const s of plan!.strokes) {
      // Peaks alternate: left at even samples, right at odd ones
      const left = s.left.filter((_, i) => i % 2 === 0);
      const right = s.right.filter((_, i) => i % 2 === 1);
      for (const side of [left, right]) {
        for (let i = 1; i < side.length; i++) {
          widest = Math.max(
            widest,
            Math.hypot(side[i].x - side[i - 1].x, side[i].y - side[i - 1].y),
          );
        }
      }
    }
    // Some slack: the edge follows the pixel raster of the distance
    // transform (before: 1.9 times the spacing)
    expect(widest).toBeLessThanOrEqual(OPTIONS.spacing * 1.3);
  });

  it("spreads the needle points on the inside of tight curves", () => {
    // An o with a 1.2 mm stroke around a 0.8 mm hole: inside, the peaks
    // crowd together; every other close one is pulled in (short stitch)
    const plan = planSatin([circle(0, 0, 16), circle(0, 0, 4)], OPTIONS);
    expect(plan).not.toBeNull();
    let closest = Infinity;
    for (const s of plan!.strokes) {
      const left = s.left.filter((_, i) => i % 2 === 0);
      const right = s.right.filter((_, i) => i % 2 === 1);
      for (const side of [left, right]) {
        for (let i = 1; i < side.length; i++) {
          closest = Math.min(
            closest,
            Math.hypot(side[i].x - side[i - 1].x, side[i].y - side[i - 1].y),
          );
        }
      }
    }
    expect(closest).toBeGreaterThanOrEqual(1);
  });
});
