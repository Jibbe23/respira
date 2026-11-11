import { describe, it, expect } from "vitest";
import {
  imageToPattern,
  imageToPatternFitting,
  patternHeightMm,
  type ImageToPatternOptions,
} from "./imageToPattern";
import { crossStitchRuns } from "./crossStitch";
import {
  tatamiFill,
  runAroundRing,
  regionArea,
  repeatClosedRun,
} from "./fillStitches";
import { createTravelGraph, connectBlocks } from "./travel";
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

describe("travel inside a region", () => {
  // U shape: the fill rows are split by the gap between the arms
  const u = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 200 },
    { x: 140, y: 200 },
    { x: 140, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 260 },
    { x: 0, y: 260 },
  ];
  const insideU = (p: { x: number; y: number }) =>
    p.x >= -1 &&
    p.x <= 201 &&
    p.y >= -1 &&
    p.y <= 261 &&
    !(p.x > 61 && p.x < 139 && p.y < 199);

  it("sews a split fill as one thread that stays inside the shape", () => {
    const blocks = tatamiFill([u], { angle: 45, spacing: 5, stitchLength: 40 });
    expect(blocks.length).toBeGreaterThan(1);
    const graph = createTravelGraph([u], 45, 15);
    const runs = connectBlocks(blocks, graph, null, { travelStitch: 25 });
    expect(runs).toHaveLength(1);
    const run = runs[0];
    for (let i = 0; i < run.length; i++) {
      expect(insideU(run[i])).toBe(true);
      if (i === 0) continue;
      // No stitch crosses the gap between the arms
      const mid = {
        x: (run[i].x + run[i - 1].x) / 2,
        y: (run[i].y + run[i - 1].y) / 2,
      };
      expect(insideU(mid)).toBe(true);
    }
  });

  it("never stitches across a narrow slit", () => {
    // Square with a 0.6 mm slit from the right edge to the middle
    const slit = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 97 },
      { x: 100, y: 97 },
      { x: 100, y: 103 },
      { x: 200, y: 103 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ];
    // Underlay rows end inside the shape: their hop onto the travel graph
    // must not cross the slit
    const blocks = tatamiFill([slit], {
      angle: 135,
      spacing: 25,
      stitchLength: 30,
      inset: 5,
    });
    const graph = createTravelGraph([slit], 45, 15);
    const [run] = connectBlocks(blocks, graph, null, { travelStitch: 25 });
    for (let i = 1; i < run.length; i++) {
      for (let k = 1; k < 10; k++) {
        const x = run[i - 1].x + ((run[i].x - run[i - 1].x) * k) / 10;
        const y = run[i - 1].y + ((run[i].y - run[i - 1].y) * k) / 10;
        expect(x > 101 && y > 97.5 && y < 102.5).toBe(false);
      }
    }
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
    // A blue thread (pure blue is nearest to ULTRA MARINE)
    expect(names.some((n) => /BLUE|MARINE/i.test(n ?? ""))).toBe(true);

    // Width as requested (lock stitches add a few tenths of a millimetre)
    expect(Math.abs(bounds.maxX - bounds.minX - 600)).toBeLessThanOrEqual(10);

    // Each shape is one area: underlay, fill and outline without a jump
    expect(stitches.some((s) => s[2] & MOVE)).toBe(false);
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

  it("keeps small details such as a full stop", () => {
    // Square on the left, a 6 × 6 px dot at the right edge: 60 mm over
    // 376 px makes the dot about 0.9 mm²
    const BLACK: Pixel = [0, 0, 0, 255];
    const image = makeImage(400, 200, (x, y) => {
      if (x >= 10 && x < 200 && y >= 10 && y < 190) return BLACK;
      if (x >= 380 && x < 386 && y >= 150 && y < 156) return BLACK;
      return WHITE;
    });
    const { stitches } = imageToPattern(image, {
      colors: 1,
      widthMm: 60,
      removeBackground: true,
      ...TATAMI,
    })!;
    // The square ends near the center, the dot is near +29 mm
    expect(stitches.some((s) => !(s[2] & MOVE) && s[0] > 250)).toBe(true);
  });

  it("gives colors with the same nearest thread their own threads", () => {
    // Two creams told apart by the palette, both nearest to LINEN
    const CREAM: Pixel = [241, 232, 216, 255];
    const SKIN: Pixel = [250, 225, 195, 255];
    const image = makeImage(120, 60, (x, y) => {
      if (y < 10 || y >= 50 || x < 10 || x >= 110) return WHITE;
      return x < 60 ? CREAM : SKIN;
    });
    const { threads } = imageToPattern(image, {
      colors: 2,
      widthMm: 60,
      removeBackground: true,
      ...TATAMI,
    })!;
    expect(threads).toHaveLength(2);
    expect(threads[0].catalogNumber).not.toBe(threads[1].catalogNumber);
  });

  it("scales a design down until it fits the hoop height", () => {
    // 40 × 100 px: 80 mm wide would be 200 mm tall
    const tall = makeImage(60, 120, (x, y) =>
      x >= 10 && x < 50 && y >= 10 && y < 110 ? RED : WHITE,
    );
    const options = {
      colors: 1,
      widthMm: 80,
      removeBackground: true,
      ...TATAMI,
    };
    expect(patternHeightMm(imageToPattern(tall, options)!)).toBeGreaterThan(
      100,
    );

    const { pattern, widthMm } = imageToPatternFitting(tall, options, 100, 10);
    expect(widthMm).toBeLessThan(80);
    expect(patternHeightMm(pattern!)).toBeLessThanOrEqual(100);
    expect(patternHeightMm(pattern!)).toBeGreaterThan(95);
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

  const crossPattern = (image: ImageData, widthMm: number) =>
    imageToPattern(image, {
      ...TATAMI,
      fill: "cross",
      colors: 1,
      widthMm,
      removeBackground: false,
      crossSizeMm: 2,
    })!;

  it("travels over sewn lines instead of across empty cells", () => {
    // Two diagonal cells at 2 mm: a direct move between the run starts
    // (2.8 mm) would be a stray diagonal through an empty cell
    const image = makeImage(20, 20, (x, y) =>
      x < 10 === y < 10 ? RED : [0, 0, 0, 0],
    );
    const { stitches } = crossPattern(image, 4);
    expect(stitches.some((s) => s[2] & MOVE)).toBe(false);
    // Cells span x, y in [-20, 0] and [0, 20]; nothing in the empty quarters
    for (let i = 1; i < stitches.length; i++) {
      const x = (stitches[i][0] + stitches[i - 1][0]) / 2;
      const y = (stitches[i][1] + stitches[i - 1][1]) / 2;
      expect((x > 1 && y < -1) || (x < -1 && y > 1)).toBe(false);
    }
  });

  it("jumps between cells that do not touch", () => {
    const image = makeImage(30, 10, (x) =>
      x < 10 || x >= 20 ? RED : [0, 0, 0, 0],
    );
    const { stitches } = crossPattern(image, 6);
    expect(stitches.filter((s) => s[2] & MOVE)).toHaveLength(1);
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
