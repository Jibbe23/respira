import { describe, it, expect } from "vitest";
import { imageToPattern } from "./imageToPattern";
import { tatamiFill, runAroundRing, regionArea } from "./fillStitches";
import { MOVE } from "../import/constants";

type Pixel = [number, number, number, number];

// Minimal ImageData stand-in (the tracer only reads width, height and data)
function makeImage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Pixel,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  return { width, height, data, colorSpace: "srgb" } as ImageData;
}

const WHITE: Pixel = [255, 255, 255, 255];
const RED: Pixel = [220, 0, 0, 255];
const BLUE: Pixel = [0, 0, 200, 255];

// White background, red square on the left, blue circle on the right
const logo = makeImage(120, 60, (x, y) => {
  if (x >= 10 && x < 50 && y >= 10 && y < 50) return RED;
  if ((x - 85) ** 2 + (y - 30) ** 2 < 20 ** 2) return BLUE;
  return WHITE;
});

const square = (size: number) => [
  [
    { x: 0, y: 0 },
    { x: size, y: 0 },
    { x: size, y: size },
    { x: 0, y: size },
  ],
];

describe("fillStitches", () => {
  it("fills a square with rows at the given spacing", () => {
    const blocks = tatamiFill(square(100), {
      angle: 0,
      spacing: 10,
      stitchLength: 40,
    });
    expect(blocks).toHaveLength(1);
    const points = blocks[0];
    const rows = new Set(points.map((p) => Math.round(p.y)));
    expect(rows.size).toBe(10);
    // Stitches stay near the stitch length (a grid point too close to the
    // row start is skipped, so up to 4/3 of it)
    for (let i = 1; i < points.length; i++) {
      const d = Math.hypot(
        points[i].x - points[i - 1].x,
        points[i].y - points[i - 1].y,
      );
      expect(d).toBeLessThanOrEqual((40 * 4) / 3 + 1e-6);
    }
  });

  it("keeps the stitches between rows short in shapes that widen", () => {
    // T shape: narrow stem below a wide bar
    const t = [
      [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
        { x: 300, y: 50 },
        { x: 170, y: 50 },
        { x: 170, y: 200 },
        { x: 130, y: 200 },
        { x: 130, y: 50 },
        { x: 0, y: 50 },
      ],
    ];
    const blocks = tatamiFill(t, { angle: 0, spacing: 5, stitchLength: 40 });
    expect(blocks.length).toBeGreaterThan(1);
    for (const points of blocks) {
      for (let i = 1; i < points.length; i++) {
        const d = Math.hypot(
          points[i].x - points[i - 1].x,
          points[i].y - points[i - 1].y,
        );
        expect(d).toBeLessThanOrEqual((40 * 4) / 3 + 1e-6);
      }
    }
  });

  it("leaves holes empty", () => {
    const rings = [
      ...square(100),
      [
        { x: 30, y: 30 },
        { x: 70, y: 30 },
        { x: 70, y: 70 },
        { x: 30, y: 70 },
      ],
    ];
    const points = tatamiFill(rings, {
      angle: 0,
      spacing: 5,
      stitchLength: 40,
    }).flat();
    const inHole = points.filter(
      (p) => p.x > 31 && p.x < 69 && p.y > 31 && p.y < 69,
    );
    expect(inHole).toHaveLength(0);
    expect(regionArea(rings)).toBe(100 * 100 - 40 * 40);
  });

  it("runs around a ring and comes back to the start", () => {
    const points = runAroundRing(square(100)[0], 25);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 0, y: 0 });
    // 400 units of outline at 25 per stitch
    expect(points.length).toBe(17);
  });
});

describe("imageToPattern", () => {
  it("turns a two-color logo into two threads without the background", () => {
    const pattern = imageToPattern(logo, {
      colors: 3,
      widthMm: 60,
      removeBackground: true,
      density: "normal",
    });
    expect(pattern).not.toBeNull();
    const { threads, bounds, stitches } = pattern!;

    expect(threads).toHaveLength(2);
    const names = threads.map((t) => t.description);
    expect(names.some((n) => /RED/i.test(n ?? ""))).toBe(true);
    expect(names.some((n) => /BLUE/i.test(n ?? ""))).toBe(true);

    // Width as requested (lock stitches add a few tenths of a millimetre)
    expect(Math.abs(bounds.maxX - bounds.minX - 600)).toBeLessThanOrEqual(10);

    // Fill and outline of one color are connected by jumps
    expect(stitches.some((s) => s[2] & MOVE)).toBe(true);
    expect(new Set(stitches.map((s) => s[3]))).toEqual(new Set([0, 1]));
  });

  it("never uses more threads than colors requested", () => {
    const pattern = imageToPattern(logo, {
      colors: 1,
      widthMm: 60,
      removeBackground: true,
      density: "normal",
    });
    expect(pattern!.threads).toHaveLength(1);
  });

  it("returns null when only the background is left", () => {
    const blank = makeImage(40, 40, () => WHITE);
    expect(
      imageToPattern(blank, {
        colors: 2,
        widthMm: 50,
        removeBackground: true,
        density: "normal",
      }),
    ).toBeNull();
  });
});
