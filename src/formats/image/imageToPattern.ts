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
  tatamiFill,
  runAroundRing,
  regionArea,
  type Point,
  type Ring,
} from "./fillStitches";
import {
  traceImage,
  quantizePalette,
  type RGBA,
  type TracedImage,
} from "./traceImage";

export type FillDensity = "normal" | "dense";

export interface ImageToPatternOptions {
  colors: number; // colors to reduce the image to (before thread matching)
  widthMm: number; // width of the embroidery
  removeBackground: boolean; // skip the dominant border color
  density: FillDensity;
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
 * so areas that end up in the same thread are traced as one region
 */
function toThreadPalette(palette: RGBA[]): RGBA[] {
  const seen = new Set<string>();
  const result: RGBA[] = [];
  for (const c of palette) {
    if (c.a < 128) {
      result.push(c);
      continue;
    }
    const thread = nearestBrotherColor(c.r, c.g, c.b);
    if (seen.has(thread.ColorCode)) continue;
    seen.add(thread.ColorCode);
    result.push({ r: thread.R, g: thread.G, b: thread.B, a: 255 });
  }
  return result;
}

interface ThreadGroup {
  color: BrotherColor;
  regions: Ring[][]; // scaled regions (0.1 mm)
  area: number;
}

/**
 * Group traced regions by thread color, scaled to the target width and
 * centered on the origin. Palette colors that map to the same Brother thread
 * are merged so they need no extra thread change.
 */
function groupByThread(
  traced: TracedImage,
  options: ImageToPatternOptions,
): ThreadGroup[] {
  const regions = traced.regions.filter(
    (r) =>
      !(options.removeBackground && r.colorIndex === traced.backgroundIndex),
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

  const groups = new Map<string, ThreadGroup>();
  for (const region of regions) {
    const rings = region.rings.map((ring) => ring.map(toPattern));
    const area = regionArea(rings);
    if (area < MIN_REGION_AREA) continue;

    const { r, g, b } = traced.palette[region.colorIndex];
    const color = nearestBrotherColor(r, g, b);
    const group = groups.get(color.ColorCode) ?? {
      color,
      regions: [],
      area: 0,
    };
    group.regions.push(rings);
    group.area += area;
    groups.set(color.ColorCode, group);
  }

  // Merge the smallest group into the one with the closest color while there
  // are more threads than asked for, or a thread would only sew tiny bits
  // (e.g. anti-aliased edges)
  const list = [...groups.values()];
  const total = list.reduce((sum, g) => sum + g.area, 0);
  const smallestArea = () => Math.min(...list.map((g) => g.area));
  while (
    list.length > 1 &&
    (list.length > options.colors || smallestArea() < total * MIN_THREAD_SHARE)
  ) {
    list.sort((a, b) => b.area - a.area);
    const smallest = list.pop()!;
    const target = list.reduce((best, g) =>
      colorDistance(g.color, smallest.color) <
      colorDistance(best.color, smallest.color)
        ? g
        : best,
    );
    target.regions.push(...smallest.regions);
    target.area += smallest.area;
  }

  // Large areas first, details on top
  return list.sort((a, b) => b.area - a.area);
}

/**
 * Stitches for all thread groups: per region underlay, tatami fill and an
 * outline running stitch. Stitch format [x, y, cmd, colorIndex].
 */
function groupsToStitches(groups: ThreadGroup[], density: FillDensity) {
  const stitches: number[][] = [];
  let position: Point | null = null;

  groups.forEach((group, colorIndex) => {
    let colorStarted = false;

    // Append a run of points, travelling to its start first
    const sew = (points: Point[]) => {
      if (points.length === 0) return;
      const [first, ...rest] = points;
      if (
        colorStarted &&
        position &&
        Math.hypot(first.x - position.x, first.y - position.y) >
          MAX_TRAVEL_STITCH
      ) {
        stitches.push([first.x, first.y, MOVE, colorIndex]);
      } else {
        stitches.push([first.x, first.y, 0, colorIndex]);
      }
      colorStarted = true;
      for (const p of rest) stitches.push([p.x, p.y, 0, colorIndex]);
      position = points[points.length - 1];
    };

    // Next region: the one whose outline starts closest to the needle
    const remaining = [...group.regions];
    while (remaining.length > 0) {
      const here = position;
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
        spacing: ROW_SPACING[density],
        stitchLength: FILL_STITCH_LENGTH,
      }).forEach(sew);
      for (const ring of rings) {
        sew(runAroundRing(ring, OUTLINE_STITCH_LENGTH, position ?? undefined));
      }
    }
  });

  // PEN coordinates are whole 0.1 mm units; rounding can create stitches of
  // length zero, which are dropped
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
  const palette = quantizePalette(
    imageData,
    options.colors + (options.removeBackground ? 1 : 0),
  );
  const traced = traceImage(imageData, toThreadPalette(palette));
  const groups = groupByThread(traced, options);
  const stitches = groupsToStitches(groups, options.density);
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
