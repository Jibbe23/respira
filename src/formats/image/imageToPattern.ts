/**
 * Image to embroidery: traced color regions become a stitch pattern with
 * Brother thread colors, in the same PesPatternData shape as an imported PES
 * file (so preview, transform and upload work unchanged).
 */

import type { PesPatternData } from "../import/client";
import { MOVE } from "../import/constants";
import { encodeStitchesToPen } from "../pen/encoder";
import { decodePenData } from "../pen/decoder";
import { calculateBoundsFromDecodedStitches } from "../../components/PatternCanvas/patternCanvasHelpers";
import {
  getAllBrotherColors,
  brotherColorToThreadInfo,
  type BrotherColor,
} from "../../utils/brotherColors";
import {
  crossStitchGrid,
  crossStitchRuns,
  type CrossCell,
} from "./crossStitch";
import {
  tatamiFill,
  runAroundRing,
  repeatClosedRun,
  regionArea,
  type Point,
  type Ring,
} from "./fillStitches";
import {
  traceImage,
  quantizePalette,
  findBackground,
  binarizeAlpha,
  type RGBA,
  type TracedImage,
} from "./traceImage";

export type FillDensity = "normal" | "dense";
export type FillType = "tatami" | "cross";
/** How often a line is sewn: 1 = single, 2 = double, 3 = triple */
export type Repeats = 1 | 2 | 3;

export interface ImageToPatternOptions {
  colors: number; // maximum number of thread colors
  widthMm: number; // width of the embroidery
  removeBackground: boolean; // skip the dominant border color
  fill: FillType;
  density: FillDensity; // tatami row spacing
  outlineRepeats: Repeats; // tatami outline around each area
  crossSizeMm: number; // cross stitch cell size
  crossRepeats: Repeats; // how often each cross is sewn
}

/** Stitch parameters (0.1 mm units) */
const ROW_SPACING: Record<FillDensity, number> = { normal: 4.5, dense: 3.5 };
const FILL_ANGLE = 45;
const FILL_STITCH_LENGTH = 40;
const UNDERLAY = { spacing: 25, stitchLength: 30, inset: 5 };
const OUTLINE_STITCH_LENGTH = 25;
/** Regions smaller than this (2 mm²) are left out */
const MIN_REGION_AREA = 200;
/** Regions smaller than this (1 cm²) get no underlay */
const MIN_UNDERLAY_AREA = 1000;
/** Threads covering less than this share of the sewn area are merged */
const MIN_THREAD_SHARE = 0.02;
/** Longer moves inside one color become jumps instead of stitches */
const MAX_TRAVEL_STITCH = 30;

const brotherColors = getAllBrotherColors();

/** Weighted RGB distance, closer to perceived difference than plain RGB */
function rgbDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const rMean = (r1 + r2) / 2;
  return (
    (2 + rMean / 256) * (r1 - r2) ** 2 +
    4 * (g1 - g2) ** 2 +
    (2 + (255 - rMean) / 256) * (b1 - b2) ** 2
  );
}

const colorDistance = (a: BrotherColor, b: BrotherColor) =>
  rgbDistance(a.R, a.G, a.B, b.R, b.G, b.B);

function nearestBrotherColor(r: number, g: number, b: number): BrotherColor {
  let best = brotherColors[0];
  let bestDistance = Infinity;
  for (const c of brotherColors) {
    const d = rgbDistance(c.R, c.G, c.B, r, g, b);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}

/**
 * Replace palette colors by their Brother thread colors (duplicates removed),
 * so areas that end up in the same thread are traced as one region. The
 * background (if given) stays first and unchanged, so a foreground color
 * mapping to the same thread is not swallowed by it.
 */
function toThreadPalette(
  palette: RGBA[],
  backgroundIndex: number | null,
): RGBA[] {
  const seen = new Set<string>();
  const result: RGBA[] =
    backgroundIndex === null ? [] : [palette[backgroundIndex]];
  palette.forEach((c, i) => {
    if (i === backgroundIndex) return;
    if (c.a < 128) {
      result.push(c);
      return;
    }
    const thread = nearestBrotherColor(c.r, c.g, c.b);
    if (seen.has(thread.ColorCode)) return;
    seen.add(thread.ColorCode);
    result.push({ r: thread.R, g: thread.G, b: thread.B, a: 255 });
  });
  return result;
}

interface ThreadGroup<T> {
  color: BrotherColor;
  items: T[]; // what is sewn in this thread (regions or cross cells)
  area: number;
}

/**
 * Merge the smallest group into the one with the closest color while there
 * are more threads than asked for, or a thread would only sew tiny bits
 * (e.g. anti-aliased edges). Returns large areas first, details on top.
 */
function mergeGroups<T>(
  groups: ThreadGroup<T>[],
  maxColors: number,
): ThreadGroup<T>[] {
  const list = [...groups];
  const total = list.reduce((sum, g) => sum + g.area, 0);
  const smallestArea = () => Math.min(...list.map((g) => g.area));
  while (
    list.length > 1 &&
    (list.length > maxColors || smallestArea() < total * MIN_THREAD_SHARE)
  ) {
    list.sort((a, b) => b.area - a.area);
    const smallest = list.pop()!;
    const target = list.reduce((best, g) =>
      colorDistance(g.color, smallest.color) <
      colorDistance(best.color, smallest.color)
        ? g
        : best,
    );
    target.items.push(...smallest.items);
    target.area += smallest.area;
  }
  return list.sort((a, b) => b.area - a.area);
}

/** Add an item to the group of its thread color */
function addToGroup<T>(
  groups: Map<string, ThreadGroup<T>>,
  color: BrotherColor,
  item: T,
  area: number,
) {
  const group = groups.get(color.ColorCode) ?? { color, items: [], area: 0 };
  group.items.push(item);
  group.area += area;
  groups.set(color.ColorCode, group);
}

/**
 * Group traced regions by thread color, scaled to the target width and
 * centered on the origin
 */
function groupRegionsByThread(
  traced: TracedImage,
  options: ImageToPatternOptions,
): ThreadGroup<Ring[]>[] {
  const regions = traced.regions.filter(
    (r) => r.colorIndex !== traced.backgroundIndex,
  );
  if (regions.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const region of regions) {
    for (const p of region.rings[0]) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const scale = (options.widthMm * 10) / Math.max(1, maxX - minX);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const toPattern = (p: Point): Point => ({
    x: (p.x - cx) * scale,
    y: (p.y - cy) * scale,
  });

  const groups = new Map<string, ThreadGroup<Ring[]>>();
  for (const region of regions) {
    const rings = region.rings.map((ring) => ring.map(toPattern));
    const area = regionArea(rings);
    if (area < MIN_REGION_AREA) continue;
    const { r, g, b } = traced.palette[region.colorIndex];
    addToGroup(groups, nearestBrotherColor(r, g, b), rings, area);
  }
  return mergeGroups([...groups.values()], options.colors);
}

/**
 * Group cross stitch cells by thread color (cells in 0.1 mm, centered on the
 * origin)
 */
function groupCellsByThread(
  image: ImageData,
  palette: RGBA[],
  backgroundIndex: number | null,
  options: ImageToPatternOptions,
): ThreadGroup<CrossCell>[] {
  const grid = crossStitchGrid(
    image,
    palette,
    backgroundIndex,
    options.widthMm * 10,
    options.crossSizeMm * 10,
  );
  const groups = new Map<string, ThreadGroup<CrossCell>>();
  const cellArea = (options.crossSizeMm * 10) ** 2;
  for (const cell of grid) {
    const { r, g, b } = palette[cell.colorIndex];
    addToGroup(groups, nearestBrotherColor(r, g, b), cell, cellArea);
  }
  return mergeGroups([...groups.values()], options.colors);
}

/**
 * Collects stitches [x, y, cmd, colorIndex]; `sew` appends a run of points
 * and travels to its start first (a stitch for short moves, a jump otherwise)
 */
function createStitchWriter() {
  const stitches: number[][] = [];
  let position: Point | null = null;
  let currentColor = -1;

  return {
    stitches,
    get position() {
      return position;
    },
    sew(points: Point[], colorIndex: number) {
      if (points.length === 0) return;
      const [first, ...rest] = points;
      const jump =
        colorIndex === currentColor &&
        position !== null &&
        Math.hypot(first.x - position.x, first.y - position.y) >
          MAX_TRAVEL_STITCH;
      stitches.push([first.x, first.y, jump ? MOVE : 0, colorIndex]);
      for (const p of rest) stitches.push([p.x, p.y, 0, colorIndex]);
      position = points[points.length - 1];
      currentColor = colorIndex;
    },
  };
}

/** Tatami stitches: per region underlay, fill and outline */
function regionsToStitches(
  groups: ThreadGroup<Ring[]>[],
  options: ImageToPatternOptions,
): number[][] {
  const writer = createStitchWriter();
  groups.forEach((group, colorIndex) => {
    const sew = (points: Point[]) => writer.sew(points, colorIndex);

    // Next region: the one whose outline starts closest to the needle
    const remaining = [...group.items];
    while (remaining.length > 0) {
      const here = writer.position;
      let index = 0;
      if (here) {
        let best = Infinity;
        remaining.forEach((rings, i) => {
          for (const p of rings[0]) {
            const d = Math.hypot(p.x - here.x, p.y - here.y);
            if (d < best) {
              best = d;
              index = i;
            }
          }
        });
      }
      const [rings] = remaining.splice(index, 1);

      if (regionArea(rings) >= MIN_UNDERLAY_AREA) {
        tatamiFill(rings, { angle: FILL_ANGLE + 90, ...UNDERLAY }).forEach(sew);
      }
      tatamiFill(rings, {
        angle: FILL_ANGLE,
        spacing: ROW_SPACING[options.density],
        stitchLength: FILL_STITCH_LENGTH,
      }).forEach(sew);
      for (const ring of rings) {
        const outline = runAroundRing(
          ring,
          OUTLINE_STITCH_LENGTH,
          writer.position ?? undefined,
        );
        sew(repeatClosedRun(outline, options.outlineRepeats));
      }
    }
  });
  return writer.stitches;
}

/** Cross stitches, row by row per thread color */
function cellsToStitches(
  groups: ThreadGroup<CrossCell>[],
  options: ImageToPatternOptions,
): number[][] {
  const writer = createStitchWriter();
  groups.forEach((group, colorIndex) => {
    for (const run of crossStitchRuns(
      group.items,
      options.crossSizeMm * 10,
      options.crossRepeats,
    )) {
      writer.sew(run, colorIndex);
    }
  });
  return writer.stitches;
}

/**
 * PEN coordinates are whole 0.1 mm units; rounding can create stitches of
 * length zero, which are dropped
 */
function roundStitches(stitches: number[][]): number[][] {
  const result: number[][] = [];
  for (const [x, y, cmd, color] of stitches) {
    const stitch = [Math.round(x), Math.round(y), cmd, color];
    const prev = result[result.length - 1];
    if (
      prev &&
      prev[0] === stitch[0] &&
      prev[1] === stitch[1] &&
      prev[3] === stitch[3] &&
      cmd === 0
    ) {
      continue;
    }
    result.push(stitch);
  }
  return result;
}

/**
 * Convert image pixels to a stitch pattern
 *
 * @returns null if nothing is left to sew (e.g. only background)
 */
export function imageToPattern(
  imageData: ImageData,
  options: ImageToPatternOptions,
): PesPatternData | null {
  // The background takes a color slot of its own when it is left out
  const image = binarizeAlpha(imageData);
  const palette = quantizePalette(
    image,
    options.colors + (options.removeBackground ? 1 : 0),
  );
  const background = options.removeBackground
    ? findBackground(image, palette)
    : null;
  const threadPalette = toThreadPalette(palette, background);
  const backgroundIndex = background === null ? null : 0;

  let groups: ThreadGroup<unknown>[];
  let stitches: number[][];
  if (options.fill === "cross") {
    const cellGroups = groupCellsByThread(
      image,
      threadPalette,
      backgroundIndex,
      options,
    );
    groups = cellGroups;
    stitches = cellsToStitches(cellGroups, options);
  } else {
    const traced = traceImage(image, threadPalette, backgroundIndex);
    const regionGroups = groupRegionsByThread(traced, options);
    groups = regionGroups;
    stitches = regionsToStitches(regionGroups, options);
  }
  stitches = roundStitches(stitches);
  if (stitches.length < 2) return null;

  const penData = new Uint8Array(encodeStitchesToPen(stitches).penBytes);
  const penStitches = decodePenData(penData);

  const threads = groups.map((group, i) => {
    const info = brotherColorToThreadInfo(group.color);
    return {
      color: i,
      hex: info.hex,
      brand: info.brand,
      catalogNumber: info.catalogNumber,
      description: info.description,
      chart: info.chart,
    };
  });

  return {
    stitches,
    threads,
    uniqueColors: threads.map((thread, i) => ({
      ...thread,
      threadIndices: [i],
    })),
    penData,
    penStitches,
    colorCount: threads.length,
    stitchCount: stitches.length,
    bounds: calculateBoundsFromDecodedStitches(penStitches),
  };
}
