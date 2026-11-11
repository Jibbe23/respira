/**
 * Image to embroidery: traced color regions become a stitch pattern with
 * Brother thread colors, in the same PesPatternData shape as an imported PES
 * file (so preview, transform and upload work unchanged).
 */

import type { PesPatternData } from "../import/client";
import { MOVE, TRIM } from "../import/constants";
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
  offsetRings,
  holeClosesAt,
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
import { planSatin, sewSatin, type SatinPlan } from "./satin";

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
const ROW_SPACING: Record<FillDensity, number> = { normal: 3.5, dense: 3 };
/**
 * Fill rows reach this far past the edge: the fabric pulls them in, and
 * neighbouring areas overlap instead of leaving a gap (0.3 mm)
 */
const FILL_PULL_COMPENSATION = 3;
/** Satin for strokes up to 5 mm wide (lettering, contour lines) */
const SATIN = { pullCompensation: 2, underlayStitch: 20, maxWidth: 50 };
const SATIN_SPACING: Record<FillDensity, number> = { normal: 4, dense: 3 };
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
/** Longer moves inside one region become jumps instead of stitches */
const MAX_TRAVEL_STITCH = 30;
/**
 * Moving on to a separate part of the same color (another letter, digit or
 * dot): longer than this (1 mm) it is a jump marked for a cut, so no thread
 * spans the gap; shorter, the parts practically touch
 */
const MAX_GAP_STITCH = 10;
/** Running stitches when travelling inside a region */
const TRAVEL_STITCH_LENGTH = 25;
/** Row spacing of the travel graph (coarser than the fill, enough to route) */
const TRAVEL_GRAPH_SPACING = 15;

/**
 * Room kept when fitting width and height (1 mm): fill and satin reach past
 * the edges on both sides, lock stitches a little more
 */
const FIT_MARGIN = 10;

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
    (options.widthMm * 10 - FIT_MARGIN) / Math.max(1, maxX - minX),
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
 * and travels to its start first: a stitch for moves up to `maxTravel`,
 * otherwise a jump. With `newPart` (first run of a separate part) the limit
 * is MAX_GAP_STITCH and the jump is marked for a cut.
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
    sew(points: Point[], colorIndex: number, newPart = false) {
      if (points.length === 0) return;
      const [first, ...rest] = points;
      const gap =
        colorIndex === currentColor && position !== null
          ? Math.hypot(first.x - position.x, first.y - position.y)
          : 0;
      const cmd = newPart
        ? gap > MAX_GAP_STITCH
          ? MOVE | TRIM
          : 0
        : gap > maxTravel
          ? MOVE
          : 0;
      stitches.push([first.x, first.y, cmd, colorIndex]);
      for (const p of rest) stitches.push([p.x, p.y, 0, colorIndex]);
      position = points[points.length - 1];
      currentColor = colorIndex;
    },
  };
}

const satinOptions = (options: ImageToPatternOptions) => ({
  ...SATIN,
  spacing: SATIN_SPACING[options.density],
});

/** Share of a thread sewn in satin from which its lines get their own block */
const SPLIT_LINE_SHARE = 0.25;

/**
 * Sewing order: lines sewn in satin (lettering, contour lines) come after
 * all areas, so they lie on top of the area edges; areas keep their order
 * (largest thread first). A thread that is mostly lines moves to the end as
 * a whole; one with a fair share of both is split into an area block and a
 * line block; a few narrow strips of an area color stay with it (no extra
 * thread change for them).
 */
function orderForSewing(
  groups: ThreadGroup<Ring[]>[],
  options: ImageToPatternOptions,
): { groups: ThreadGroup<Ring[]>[]; satin: Map<Ring[], SatinPlan> } {
  const satin = new Map<Ring[], SatinPlan>();
  const areas: ThreadGroup<Ring[]>[] = [];
  const lines: ThreadGroup<Ring[]>[] = [];
  for (const group of groups) {
    const line: ThreadGroup<Ring[]> = {
      color: group.color,
      items: [],
      area: 0,
    };
    const area: ThreadGroup<Ring[]> = {
      color: group.color,
      items: [],
      area: 0,
    };
    for (const rings of group.items) {
      const plan = planSatin(rings, satinOptions(options));
      if (plan) satin.set(rings, plan);
      const target = plan ? line : area;
      target.items.push(rings);
      target.area += regionArea(rings);
    }
    const share = line.area / Math.max(1, group.area);
    if (share > 0.5) lines.push(group);
    else if (share >= SPLIT_LINE_SHARE) {
      areas.push(area);
      lines.push(line);
    } else areas.push(group);
  }
  return { groups: [...areas, ...lines], satin };
}

/** Tatami stitches: per region underlay, fill and outline */
function regionsToStitches(
  groups: ThreadGroup<Ring[]>[],
  options: ImageToPatternOptions,
  satin: Map<Ring[], SatinPlan>,
): number[][] {
  const writer = createStitchWriter(MAX_TRAVEL_STITCH);
  groups.forEach((group, colorIndex) => {
    // The first run of each region moves on to a separate part
    let newPart = true;
    const sew = (points: Point[]) => {
      if (points.length === 0) return;
      writer.sew(points, colorIndex, newPart);
      newPart = false;
    };

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
      newPart = true;

      // Outline along the edge (`only`: just the outer ring or the holes)
      const sewOutline = (
        sewRuns: (runs: Point[][]) => void,
        repeats: Repeats,
        only?: "outer" | "holes",
      ) => {
        for (const [i, ring] of rings.entries()) {
          if (only === "outer" && i > 0) continue;
          if (only === "holes" && i === 0) continue;
          // Holes too small to stay open under the grown fill get none
          if (i > 0 && holeClosesAt(ring, FILL_PULL_COMPENSATION)) continue;
          const outline = runAroundRing(
            ring,
            OUTLINE_STITCH_LENGTH,
            writer.position ?? undefined,
          );
          sewRuns([repeatClosedRun(outline, repeats)]);
        }
      };

      // Narrow shapes: satin across the stroke instead of a tatami fill.
      // The holes (inside of a, e, o) get their edge run first, under the
      // satin, which covers the travel to them; the outer edge run comes
      // last, on top of the satin, and makes the outline crisp (holes on
      // top would need travel or a cut across the finished letter)
      const plan = satin.get(rings);
      if (plan) {
        // Travel inside the letter (covered by the satin), not across it
        const graph = createTravelGraph(
          rings,
          FILL_ANGLE,
          TRAVEL_GRAPH_SPACING,
        );
        const sewInside = (runs: Point[][]) =>
          connectBlocks(runs, graph, writer.position, {
            travelStitch: TRAVEL_STITCH_LENGTH,
            // A satin run is underlay out, satin back: never reversed
            allowReverse: false,
          }).forEach(sew);
        sewOutline(sewInside, options.outlineRepeats, "holes");
        sewInside(sewSatin(plan, writer.position, satinOptions(options)));
        // The satin ends inside the letter: the step out to the edge goes
        // through the travel graph like all travel here (never across a
        // hole, no bare jump over the letter)
        sewOutline(sewInside, options.outlineRepeats, "outer");
        continue;
      }

      // Underlay, fill and outline as one thread: travel inside the region
      // instead of jumping (and trimming) between blocks
      // The fill reaches past the edge on all sides (pull compensation)
      const fillRings = offsetRings(rings, FILL_PULL_COMPENSATION);
      const graph = createTravelGraph(
        fillRings,
        FILL_ANGLE,
        TRAVEL_GRAPH_SPACING,
        "nonzero",
      );
      const sewBlocks = (blocks: Point[][]) =>
        connectBlocks(blocks, graph, writer.position, {
          travelStitch: TRAVEL_STITCH_LENGTH,
        }).forEach(sew);

      if (regionArea(rings) >= MIN_UNDERLAY_AREA) {
        sewBlocks(tatamiFill(rings, { angle: FILL_ANGLE + 90, ...UNDERLAY }));
      }
      sewBlocks(
        tatamiFill(fillRings, {
          angle: FILL_ANGLE,
          rule: "nonzero",
          spacing: ROW_SPACING[options.density],
          stitchLength: FILL_STITCH_LENGTH,
        }),
      );
      sewOutline(sewBlocks, options.outlineRepeats);
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
    const order = orderForSewing(
      groupRegionsByThread(regions, traced.threads, options),
      options,
    );
    groups = order.groups;
    stitches = regionsToStitches(order.groups, options, order.satin);
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
