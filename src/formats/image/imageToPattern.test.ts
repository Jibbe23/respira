import { describe, it, expect } from "vitest";
import {
  imageToPattern,
  patternSizeMm,
  type ImageToPatternOptions,
} from "./imageToPattern";
import { crossStitchRuns } from "./crossStitch";
import {
  tatamiFill,
  offsetRings,
  runAroundRing,
  regionArea,
  repeatClosedRun,
} from "./fillStitches";
import { createTravelGraph, connectBlocks } from "./travel";
import { MOVE, TRIM } from "../import/constants";
import { quantizePalette } from "./traceImage";

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
  it("does not hop onto the shape from a point beside it", () => {
    // Needle 2 mm left of a square (e.g. the end of the previous letter):
    // reaching the square is a jump, not a travel run starting at its edge
    const square = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
      { x: 0, y: 200 },
    ];
    const blocks = tatamiFill([square], {
      angle: 45,
      spacing: 25,
      stitchLength: 30,
      inset: 5,
    });
    const graph = createTravelGraph([square], 45, 15);
    const [run] = connectBlocks(
      blocks,
      graph,
      { x: -20, y: 100 },
      {
        travelStitch: 25,
      },
    );
    const ends = blocks.flatMap((b) => [b[0], b[b.length - 1]]);
    expect(ends).toContainEqual(run[0]);
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
    const isBlue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      return b > 100 && b > r + 50 && b > g + 50;
    };
    expect(threads.some((t) => isBlue(t.hex))).toBe(true);

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
    // Both are nearest to MINT GREEN, but LEAF GREEN is closer to the second
    // than the first color is (like skin next to cream)
    const LIGHT: Pixel = [112, 230, 114, 255];
    const SAGE: Pixel = [139, 193, 124, 255];
    const image = makeImage(120, 60, (x, y) => {
      if (y < 10 || y >= 50 || x < 10 || x >= 110) return WHITE;
      return x < 60 ? LIGHT : SAGE;
    });
    const { threads } = imageToPattern(image, {
      colors: 2,
      widthMm: 60,
      removeBackground: true,
      ...TATAMI,
    })!;
    expect(threads.map((t) => t.description).sort()).toEqual([
      "LEAF GREEN",
      "MINT GREEN",
    ]);
  });

  it("lets shades of one color share their thread", () => {
    const SHADE: Pixel = [170, 20, 20, 255];
    const image = makeImage(120, 60, (x, y) => {
      if (y < 10 || y >= 50 || x < 10 || x >= 110) return WHITE;
      return x < 60 ? [200, 30, 30, 255] : SHADE;
    });
    const { threads, stitches } = imageToPattern(image, {
      colors: 2,
      widthMm: 60,
      removeBackground: true,
      ...TATAMI,
    })!;
    expect(threads).toHaveLength(1);
    // Traced as one area: no jump between the halves
    expect(stitches.some((s) => s[2] & MOVE)).toBe(false);
  });

  it("sews black on a transparent background in black", () => {
    const CLEAR: Pixel = [0, 0, 0, 0];
    const image = makeImage(60, 60, (x, y) =>
      x >= 10 && x < 50 && y >= 10 && y < 50 ? [0, 0, 0, 255] : CLEAR,
    );
    const { threads } = imageToPattern(image, {
      colors: 1,
      widthMm: 40,
      removeBackground: true,
      ...TATAMI,
    })!;
    expect(threads.map((t) => t.description)).toEqual(["BLACK"]);
  });

  it.each(["tatami", "cross"] as const)(
    "scales a %s design down until it fits the height",
    (fill) => {
      // 40 × 100 px: 80 mm wide would be 200 mm tall
      const tall = makeImage(60, 120, (x, y) =>
        x >= 10 && x < 50 && y >= 10 && y < 110 ? RED : WHITE,
      );
      const options = {
        colors: 1,
        widthMm: 80,
        removeBackground: true,
        ...TATAMI,
        fill,
      };
      expect(
        patternSizeMm(imageToPattern(tall, options)!).height,
      ).toBeGreaterThan(100);

      const fitted = patternSizeMm(
        imageToPattern(tall, { ...options, maxHeightMm: 100 })!,
      );
      expect(fitted.height).toBeLessThanOrEqual(100);
      expect(fitted.height).toBeGreaterThan(90);
      expect(fitted.width).toBeLessThan(45);
    },
  );

  it("sews thin strokes in satin across the stroke", () => {
    // A 1.5 mm wide line (5 px at 0.3 mm per px)
    const BLACK: Pixel = [0, 0, 0, 255];
    const line = makeImage(200, 20, (_x, y) =>
      y >= 8 && y < 13 ? BLACK : WHITE,
    );
    const { stitches } = imageToPattern(line, {
      colors: 1,
      widthMm: 60,
      removeBackground: true,
      ...TATAMI,
    })!;
    // Satin: most stitches go across the line, edge to edge
    const across = stitches.filter(
      (s, i) => i > 0 && Math.abs(s[1] - stitches[i - 1][1]) > 12,
    );
    expect(across.length).toBeGreaterThan(stitches.length * 0.5);
    // Then an outline: running stitches along both edges (y = ±7.5)
    for (const edge of [-7.5, 7.5]) {
      const along = stitches.filter(
        (s, i) =>
          i > 0 &&
          Math.abs(s[1] - edge) < 1 &&
          Math.abs(stitches[i - 1][1] - edge) < 1 &&
          Math.abs(s[0] - stitches[i - 1][0]) > 15,
      );
      expect(along.length).toBeGreaterThan(10);
    }
  });

  it("sews the lines of a thread with large areas too after all areas", () => {
    // Black: a large square and thin lines (about a third of its area);
    // red: a square
    const BLACK: Pixel = [0, 0, 0, 255];
    const image = makeImage(300, 200, (x, y) => {
      if (x >= 10 && x < 80 && y >= 10 && y < 80) return BLACK;
      if (x >= 220 && x < 260 && y >= 80 && y < 120) return RED;
      if (x >= 100 && x < 196 && y >= 10 && y < 120 && x % 12 < 4) {
        return BLACK;
      }
      return WHITE;
    });
    const { threads } = imageToPattern(image, {
      colors: 2,
      widthMm: 90,
      removeBackground: true,
      ...TATAMI,
    })!;
    expect(threads.map((t) => t.description)).toEqual([
      "BLACK",
      expect.stringMatching(/RED|CARMINE/i),
      "BLACK",
    ]);
  });

  it("fills areas a little past their edge against gaps", () => {
    const { stitches } = imageToPattern(logo, {
      colors: 2,
      widthMm: 60,
      removeBackground: true,
      ...TATAMI,
    })!;
    const xs = stitches.map((s) => s[0]);
    // The outline keeps 0.5 mm room on each side (left edge at -29.5 mm),
    // the fill reaches 0.3 mm past it, and all stays within the 60 mm
    expect(Math.min(...xs)).toBeLessThanOrEqual(-297.5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(600);
  });

  it("fills areas with rows 0.35 mm apart", () => {
    const image = makeImage(100, 100, () => RED);
    const { stitches } = imageToPattern(image, {
      colors: 1,
      widthMm: 20,
      removeBackground: false,
      ...TATAMI,
    })!;
    // Fill rows run at 45 degrees: their offset across the rows, for the
    // stitches in the middle of the square
    const offsets = stitches
      .filter((s) => Math.abs(s[0]) < 50 && Math.abs(s[1]) < 50)
      .map((s) => (s[0] - s[1]) / Math.SQRT2)
      .sort((a, b) => a - b);
    const rows: number[] = [];
    for (const o of offsets) {
      if (rows.length === 0 || o - rows[rows.length - 1] > 1.5) rows.push(o);
    }
    const gaps = rows.slice(1).map((o, i) => o - rows[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(3.2);
    expect(mean).toBeLessThan(3.8);
  });

  it("sews lines last, on top of the areas", () => {
    // Many thin black lines (more area than the red square) and a square
    const BLACK: Pixel = [0, 0, 0, 255];
    const image = makeImage(300, 200, (x, y) => {
      if (x >= 200 && x < 240 && y >= 80 && y < 120) return RED;
      if (x < 180 && y >= 10 && y < 190 && x % 12 < 4) return BLACK;
      return WHITE;
    });
    const { threads } = imageToPattern(image, {
      colors: 2,
      widthMm: 90,
      removeBackground: true,
      ...TATAMI,
    })!;
    expect(threads.map((t) => t.description)).toEqual([
      expect.stringMatching(/RED|CARMINE/i),
      "BLACK",
    ]);
  });

  it("cuts between separate parts instead of stitching across the gap", () => {
    // Two squares with a 2 mm gap around x = 0
    const image = makeImage(100, 40, (x, y) => {
      if (y < 10 || y >= 30) return WHITE;
      if (x >= 10 && x < 40) return RED;
      if (x >= 47 && x < 77) return RED;
      return WHITE;
    });
    const { stitches } = imageToPattern(image, {
      colors: 1,
      widthMm: 20,
      removeBackground: true,
      ...TATAMI,
    })!;
    const jumps = stitches.filter((s) => s[2] & MOVE);
    expect(jumps).toHaveLength(1);
    expect(jumps[0][2] & TRIM).toBeTruthy();
    // No sewn stitch crosses the middle of the gap
    const crossing = stitches.filter(
      (s, i) =>
        i > 0 &&
        !(s[2] & MOVE) &&
        Math.min(s[0], stitches[i - 1][0]) < 0 &&
        Math.max(s[0], stitches[i - 1][0]) > 0,
    );
    expect(crossing).toHaveLength(0);
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

describe("offsetRings", () => {
  const sq = square(100)[0];
  const hole = [
    { x: 40, y: 40 },
    { x: 40, y: 60 },
    { x: 60, y: 60 },
    { x: 60, y: 40 },
  ];

  it("grows the area on all sides and shrinks holes", () => {
    for (const outer of [sq, [...sq].reverse()]) {
      const [grown, shrunk] = offsetRings([outer, hole], 3);
      const xs = grown.map((p) => p.x);
      const ys = grown.map((p) => p.y);
      expect([Math.min(...xs), Math.max(...xs)]).toEqual([-3, 103]);
      expect([Math.min(...ys), Math.max(...ys)]).toEqual([-3, 103]);
      expect(regionArea([shrunk])).toBeCloseTo(14 * 14);
    }
  });

  it("covers edges parallel to the fill rows too", () => {
    // Diamond: two of its edges run along the 45 degree rows
    const diamond = [
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ];
    const points = tatamiFill(offsetRings([diamond], 3), {
      angle: 45,
      spacing: 4,
      stitchLength: 40,
    }).flat();
    // Reaches past every edge (without the offset two edges stay short)
    for (const [sx, sy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      expect(points.some((p) => sx * (p.x - 50) + sy * (p.y - 50) > 50.2)).toBe(
        true,
      );
    }
  });

  it("fills across a notch where the grown ring overlaps itself", () => {
    // U shape with a 0.4 mm slit between its arms: grown by 0.3 mm the arms
    // overlap; the nonzero rule keeps the overlap filled
    const u = [
      { x: 0, y: 0 },
      { x: 48, y: 0 },
      { x: 48, y: 80 },
      { x: 52, y: 80 },
      { x: 52, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const blocks = tatamiFill(offsetRings([u], 3), {
      angle: 45,
      spacing: 4,
      stitchLength: 40,
      rule: "nonzero",
    });
    // Every point of the arms near the slit lies on or between fill rows:
    // its nearest stitch is closer than the row spacing
    const stitches = blocks.flatMap((b) => b.slice(1).map((p, i) => [b[i], p]));
    for (const p of [
      { x: 44, y: 40 },
      { x: 56, y: 40 },
      { x: 50, y: 90 },
    ]) {
      const nearest = Math.min(
        ...stitches.map(([a, b]) => {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const t = Math.max(
            0,
            Math.min(
              1,
              ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
            ),
          );
          return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
        }),
      );
      expect(nearest).toBeLessThan(4);
    }
  });

  it("drops holes too small to keep", () => {
    const tiny = [
      { x: 50, y: 50 },
      { x: 50, y: 54 },
      { x: 54, y: 54 },
      { x: 54, y: 50 },
    ];
    expect(offsetRings([sq, tiny], 3)).toHaveLength(1);
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

describe("quantizePalette", () => {
  it("ignores the mixed colors along edges of a scaled image", () => {
    // Black lines with gray (anti-aliased) edges, and two close light
    // colors that must both get a palette entry
    const CREAM: Pixel = [241, 232, 216, 255];
    const SKIN: Pixel = [242, 218, 203, 255];
    const image = makeImage(200, 200, (x, y) => {
      if (y >= 120) return x < 100 ? CREAM : SKIN;
      const m = x % 10;
      if (m === 4) return [0, 0, 0, 255];
      if (m === 3 || m === 5) return [128, 128, 128, 255];
      return WHITE;
    });
    const palette = quantizePalette(image, 4).map((c) => [c.r, c.g, c.b]);
    const near = (target: number[]) =>
      palette.some((c) => c.every((v, k) => Math.abs(v - target[k]) < 8));
    expect(near([241, 232, 216])).toBe(true);
    expect(near([242, 218, 203])).toBe(true);
    // The 1 px lines keep their color, their gray edges get none
    expect(near([0, 0, 0])).toBe(true);
    expect(near([128, 128, 128])).toBe(false);
  });
});
