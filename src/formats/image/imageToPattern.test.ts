import { describe, it, expect } from "vitest";
import { imageToPattern, type ImageToPatternOptions } from "./imageToPattern";
import { crossStitchRuns } from "./crossStitch";
import {
  tatamiFill,
  runAroundRing,
  regionArea,
  repeatClosedRun,
} from "./fillStitches";
import { MOVE } from "../import/constants";

type Pixel = [number, number, number, number];

const TATAMI = {
  fill: "tatami",
  density: "normal",
  outlineRepeats: 1,
  crossSizeMm: 2.5,
  crossRepeats: 1,
} satisfies Partial<ImageToPatternOptions>;

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
      ...TATAMI,
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
      ...TATAMI,
    });
    expect(pattern!.threads).toHaveLength(1);
  });

  it("keeps a white logo on an off-white background", () => {
    const offWhite: Pixel = [236, 236, 230, 255];
    const image = makeImage(80, 80, (x, y) =>
      (x - 40) ** 2 + (y - 40) ** 2 < 25 ** 2 ? WHITE : offWhite,
    );
    const pattern = imageToPattern(image, {
      colors: 1,
      widthMm: 40,
      removeBackground: true,
      ...TATAMI,
    });
    expect(pattern).not.toBeNull();
    expect(pattern!.threads).toHaveLength(1);
    // Only the circle is sewn: about 40 mm wide
    const { minX, maxX } = pattern!.bounds;
    expect(Math.abs(maxX - minX - 400)).toBeLessThanOrEqual(10);
  });

  it("does not sew half-transparent pixels", () => {
    const glow: Pixel = [255, 255, 255, 100];
    const image = makeImage(80, 80, (x, y) => {
      const d = (x - 40) ** 2 + (y - 40) ** 2;
      if (d < 15 ** 2) return RED;
      if (d < 30 ** 2) return glow;
      return [0, 0, 0, 0];
    });
    const pattern = imageToPattern(image, {
      colors: 2,
      widthMm: 30,
      removeBackground: true,
      ...TATAMI,
    });
    expect(pattern!.threads.map((t) => t.description)).toEqual([
      expect.stringMatching(/RED|CARMINE/i),
    ]);
  });

  it("returns null when only the background is left", () => {
    const blank = makeImage(40, 40, () => WHITE);
    expect(
      imageToPattern(blank, {
        colors: 2,
        widthMm: 50,
        removeBackground: true,
        ...TATAMI,
      }),
    ).toBeNull();
  });
});

describe("repeatClosedRun", () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 0 },
  ];

  it("goes around twice for double", () => {
    expect(repeatClosedRun(ring, 2)).toHaveLength(5);
  });

  it("sews every stitch forward, back and forward for triple", () => {
    expect(repeatClosedRun(ring, 3)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});

describe("cross stitch", () => {
  const cell = (col: number, row: number) => ({
    col,
    row,
    colorIndex: 0,
    x: col * 25,
    y: row * 25,
  });

  it("sews a row of cells as / forward and \\ back", () => {
    const [run] = crossStitchRuns([cell(0, 0), cell(1, 0)], 25, 1);
    expect(run).toEqual([
      { x: 0, y: 25 },
      { x: 25, y: 0 }, // "/" of cell 0
      { x: 25, y: 25 },
      { x: 50, y: 0 }, // "/" of cell 1
      { x: 50, y: 25 },
      { x: 25, y: 0 }, // "\\" of cell 1
      { x: 25, y: 25 },
      { x: 0, y: 0 }, // "\\" of cell 0
      { x: 0, y: 25 },
    ]);
  });

  it("splits rows at gaps and sews more for double and triple", () => {
    const cells = [cell(0, 0), cell(2, 0)];
    expect(crossStitchRuns(cells, 25, 1)).toHaveLength(2);
    const single = crossStitchRuns([cell(0, 0)], 25, 1)[0].length;
    expect(crossStitchRuns([cell(0, 0)], 25, 2)[0].length).toBe(2 * single - 1);
    expect(crossStitchRuns([cell(0, 0)], 25, 3)[0].length).toBe(single + 4);
  });

  it("jumps between runs instead of sewing across empty cells", () => {
    // Two diagonal cells at 2 mm: the move between them (2.8 mm) would be
    // a stray diagonal stitch through the empty cell
    const image = makeImage(20, 20, (x, y) =>
      x < 10 === y < 10 ? RED : [0, 0, 0, 0],
    );
    const pattern = imageToPattern(image, {
      ...TATAMI,
      fill: "cross",
      colors: 1,
      widthMm: 4,
      removeBackground: false,
      crossSizeMm: 2,
    });
    expect(pattern!.stitches.filter((s) => s[2] & MOVE)).toHaveLength(1);
  });

  it("turns the logo into crosses of the chosen size", () => {
    const pattern = imageToPattern(logo, {
      ...TATAMI,
      fill: "cross",
      colors: 3,
      widthMm: 60,
      removeBackground: true,
      crossSizeMm: 3,
    });
    expect(pattern).not.toBeNull();
    expect(pattern!.threads).toHaveLength(2);
    // Never wider than asked for (lock stitches add a few tenths of a mm)
    const { minX, maxX } = pattern!.bounds;
    expect(maxX - minX).toBeLessThanOrEqual(600 + 5);
    // Every diagonal is a cell diagonal: no stitch longer than 3 mm * sqrt 2
    const { stitches } = pattern!;
    for (let i = 1; i < stitches.length; i++) {
      if (stitches[i][2] !== 0 || stitches[i][3] !== stitches[i - 1][3]) {
        continue;
      }
      const d = Math.hypot(
        stitches[i][0] - stitches[i - 1][0],
        stitches[i][1] - stitches[i - 1][1],
      );
      expect(d).toBeLessThanOrEqual(30 * Math.SQRT2 + 1.5);
    }
  });
});
