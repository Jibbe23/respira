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
  createCrossTravelGraph,
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
import { createTravelGraph, connectBlocks } from "./travel";

export type FillDensity = "normal" | "dense";
export type FillType = "tatami" | "cross";
/** How often a line is sewn: 1 = single, 2 = double, 3 = triple */
export type Repeats = 1 | 2 | 3;

export interface ImageToPatternOptions {
  colors: number; // maximum number of thread colors
  widthMm: number; // width of the embroidery
  maxHeightMm?: number; // narrower than widthMm if needed to fit this height
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
/**
 * Regions smaller than this (0.4 mm²) are left out; dots of i, ä or a full
 * stop and thin lines like closed eyes are larger
 */
const MIN_REGION_AREA = 40;
/** Regions smaller than this (1 cm²) get no underlay */
const MIN_UNDERLAY_AREA = 1000;
/** Threads covering less than this share of the sewn area are merged */
const MIN_THREAD_SHARE = 0.02;
/** Longer moves inside one color become jumps instead of stitches */
const MAX_TRAVEL_STITCH = 30;
/** Running stitches when travelling inside a region */
const TRAVEL_STITCH_LENGTH = 25;
/** Row spacing of the travel graph (coarser than the fill, enough to route) */
const TRAVEL_GRAPH_SPACING = 15;

/** Room kept for lock stitches when fitting the height (0.5 mm) */
const FIT_MARGIN = 5;

const brotherColors = getAllBrotherColors();

const oklabCache = new Map<number, [number, number, number]>();

/** sRGB to OKLab (cached: thread colors are compared again and again) */
function toOklab(r: number, g: number, b: number): [number, number, number] {
  const key = (r << 16) | (g << 8) | b;
  let lab = oklabCache.get(key);
  if (!lab) {
    lab = computeOklab(r, g, b);
    oklabCache.set(key, lab);
  }
  return lab;
}

/** sRGB to OKLab (perceptual color space, also even for blue hues) */
function computeOklab(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Squared OKLab distance, close to perceived difference (a weighted RGB
 * distance took a pink thread for cream)
 */
function rgbDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const [l1, a1, c1] = toOklab(r1, g1, b1);
  const [l2, a2, c2] = toOklab(r2, g2, b2);
  return (l1 - l2) ** 2 + (a1 - a2) ** 2 + (c1 - c2) ** 2;
}

const colorDistance = (a: BrotherColor, b: BrotherColor) =>
  rgbDistance(a.R, a.G, a.B, b.R, b.G, b.B);

/**
 * Brother thread for each palette color (null for the background and
 * transparent colors). Colors nearest to their thread claim it first. A
 * color whose nearest thread is taken gets a thread of its own only if one
 * is closer to it than the color owning that thread (e.g. skin next to
 * cream); otherwise both share it (e.g. shades of one red).
 */
function assignThreads(
  palette: RGBA[],
  backgroundIndex: number | null,
): (BrotherColor | null)[] {
  const result: (BrotherColor | null)[] = palette.map(() => null);
  const distanceTo = (c: RGBA, t: { R: number; G: number; B: number }) =>
    rgbDistance(c.r, c.g, c.b, t.R, t.G, t.B);
  const candidates = palette
    .map((c, i) => ({
      i,
      ranked: [...brotherColors].sort(
        (a, b) => distanceTo(c, a) - distanceTo(c, b),
      ),
    }))
    .filter(({ i }) => i !== backgroundIndex && palette[i].a >= 128)
    .sort(
      (a, b) =>
        distanceTo(palette[a.i], a.ranked[0]) -
        distanceTo(palette[b.i], b.ranked[0]),
    );

  const owner = new Map<string, number>(); // thread code to palette index
  for (const { i, ranked } of candidates) {
    const color = palette[i];
    const nearest = ranked[0];
    const taken = owner.get(nearest.ColorCode);
    const free = ranked.find((t) => !owner.has(t.ColorCode));
    const other = taken === undefined ? null : palette[taken];
    const own =
      other === null
        ? nearest
        : free &&
            distanceTo(color, free) <
              rgbDistance(color.r, color.g, color.b, other.r, other.g, other.b)
          ? free
          : null;
    result[i] = own ?? nearest;
    if (own) owner.set(own.ColorCode, i);
  }
  return result;
}

/**
 * Palette for tracing: colors sharing a thread are merged into the first one,
 * so their areas are traced (and sewn) as one region
 */
function tracingPalette(
  palette: RGBA[],
  threads: (BrotherColor | null)[],
  backgroundIndex: number | null,
): {
  palette: RGBA[];
  threads: (BrotherColor | null)[];
  backgroundIndex: number | null;
} {
  const seen = new Set<string>();
  const result = {
    palette: [] as RGBA[],
    threads: [] as (BrotherColor | null)[],
    backgroundIndex: null as number | null,
  };
  palette.forEach((color, i) => {
    const thread = threads[i];
    if (thread) {
      if (seen.has(thread.ColorCode)) return;
      seen.add(thread.ColorCode);
    }
    if (i === backgroundIndex) result.backgroundIndex = result.palette.length;
    result.palette.push(color);
    result.threads.push(thread);
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
  threads: (BrotherColor | null)[],
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
  // Lock stitches reach a little beyond the outline
  const scale = Math.min(
    (options.widthMm * 10) / Math.max(1, maxX - minX),
    options.maxHeightMm
      ? (options.maxHeightMm * 10 - FIT_MARGIN) / Math.max(1, maxY - minY)
      : Infinity,
  );
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
    const thread = threads[region.colorIndex];
    if (thread) addToGroup(groups, thread, rings, area);
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
  threads: (BrotherColor | null)[],
  options: ImageToPatternOptions,
): ThreadGroup<CrossCell>[] {
  const grid = crossStitchGrid(
    image,
    palette,
    backgroundIndex,
    options.widthMm * 10,
    options.crossSizeMm * 10,
    options.maxHeightMm ? options.maxHeightMm * 10 - FIT_MARGIN : Infinity,
  );
  const groups = new Map<string, ThreadGroup<CrossCell>>();
  const cellArea = (options.crossSizeMm * 10) ** 2;
  for (const cell of grid) {
    const thread = threads[cell.colorIndex];
    if (thread) addToGroup(groups, thread, cell, cellArea);
  }
  return mergeGroups([...groups.values()], options.colors);
}

/**
 * Collects stitches [x, y, cmd, colorIndex]; `sew` appends a run of points
 * and travels to its start first (a stitch for moves up to `maxTravel`, a
 * jump otherwise)
 */
function createStitchWriter(maxTravel: number) {
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
        Math.hypot(first.x - position.x, first.y - position.y) > maxTravel;
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
  const writer = createStitchWriter(MAX_TRAVEL_STITCH);
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

      // Underlay, fill and outline as one thread: travel inside the region
      // instead of jumping (and trimming) between blocks
      const graph = createTravelGraph(rings, FILL_ANGLE, TRAVEL_GRAPH_SPACING);
      const sewBlocks = (blocks: Point[][]) =>
        connectBlocks(blocks, graph, writer.position, {
          travelStitch: TRAVEL_STITCH_LENGTH,
        }).forEach(sew);

      if (regionArea(rings) >= MIN_UNDERLAY_AREA) {
        sewBlocks(tatamiFill(rings, { angle: FILL_ANGLE + 90, ...UNDERLAY }));
      }
      sewBlocks(
        tatamiFill(rings, {
          angle: FILL_ANGLE,
          spacing: ROW_SPACING[options.density],
          stitchLength: FILL_STITCH_LENGTH,
        }),
      );
      for (const ring of rings) {
        const outline = runAroundRing(
          ring,
          OUTLINE_STITCH_LENGTH,
          writer.position ?? undefined,
        );
        sewBlocks([repeatClosedRun(outline, options.outlineRepeats)]);
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
  // Runs of one color are connected along lines the crosses sew anyway;
  // between unconnected pieces always jump (a travel stitch would show)
  const writer = createStitchWriter(0);
  groups.forEach((group, colorIndex) => {
    const cellSize = options.crossSizeMm * 10;
    const runs = crossStitchRuns(group.items, cellSize, options.crossRepeats);
    const graph = createCrossTravelGraph(group.items, cellSize);
    for (const piece of connectBlocks(runs, graph, writer.position, {
      allowReverse: false,
    })) {
      writer.sew(piece, colorIndex);
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
  const traced = tracingPalette(
    palette,
    assignThreads(palette, background),
    background,
  );

  let groups: ThreadGroup<unknown>[];
  let stitches: number[][];
  if (options.fill === "cross") {
    const cellGroups = groupCellsByThread(
      image,
      traced.palette,
      traced.backgroundIndex,
      traced.threads,
      options,
    );
    groups = cellGroups;
    stitches = cellsToStitches(cellGroups, options);
  } else {
    const regions = traceImage(image, traced.palette, traced.backgroundIndex);
    const regionGroups = groupRegionsByThread(regions, traced.threads, options);
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

/** Size of a converted pattern in mm */
export const patternSizeMm = (pattern: PesPatternData) => ({
  width: (pattern.bounds.maxX - pattern.bounds.minX) / 10,
  height: (pattern.bounds.maxY - pattern.bounds.minY) / 10,
});
