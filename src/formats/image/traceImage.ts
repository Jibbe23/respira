/**
 * Image tracing: reduce an image to a few colors and turn each color into
 * filled regions (outer contour plus holes), using imagetracerjs.
 */

import ImageTracer from "imagetracerjs";
import type { Point, Ring } from "./fillStitches";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TracedRegion {
  colorIndex: number; // index into palette
  rings: Ring[]; // outer contour first, then holes (pixel coordinates)
}

export interface TracedImage {
  width: number;
  height: number;
  palette: RGBA[];
  regions: TracedRegion[];
  backgroundIndex: number | null; // palette entry of the background, if any
}

interface TraceSegment {
  type: "L" | "Q";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3?: number;
  y3?: number;
}

interface TracePath {
  segments: TraceSegment[];
  isholepath: boolean;
  holechildren: number[];
}

/** Share of border pixels a color needs to count as background */
const BACKGROUND_BORDER_SHARE = 0.6;
/** k-means rounds for the palette */
const PALETTE_ITERATIONS = 10;
/** Neighbours closer than this (RGB distance) are not an edge to mix across */
const MIN_EDGE_CONTRAST = 40;

/**
 * Pixels whose color is a mix of their two opposite neighbours (left and
 * right, or above and below): anti-aliased edges, and the mixed colors that
 * scaling an image adds along every edge
 */
function mixedPixels({ data, width, height }: ImageData): Uint8Array {
  const mixed = new Uint8Array(width * height);
  const isMix = (i: number, a: number, b: number) => {
    if (data[a + 3] < 128 || data[b + 3] < 128) return false;
    const dr = data[b] - data[a];
    const dg = data[b + 1] - data[a + 1];
    const db = data[b + 2] - data[a + 2];
    const length2 = dr * dr + dg * dg + db * db;
    if (length2 < MIN_EDGE_CONTRAST ** 2) return false;
    const pr = data[i] - data[a];
    const pg = data[i + 1] - data[a + 1];
    const pb = data[i + 2] - data[a + 2];
    const t = (pr * dr + pg * dg + pb * db) / length2;
    if (t < 0.1 || t > 0.9) return false;
    const off = Math.hypot(pr - t * dr, pg - t * dg, pb - t * db);
    return off < Math.max(12, 0.25 * Math.sqrt(length2));
  };
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      if (isMix(i, i - 4, i + 4) || isMix(i, i - width * 4, i + width * 4)) {
        mixed[y * width + x] = 1;
      }
    }
  }
  return mixed;
}

/**
 * Palette of `colors` colors for the opaque pixels: k-means on a 5-bit color
 * histogram, seeded with frequent colors that are far apart from each other
 * (so anti-aliased edge pixels do not get a color of their own). Pixels that
 * mix their neighbours' colors are not counted: scaling an image mixes colors
 * along every edge, and the gray along black lines on white would otherwise
 * take the place of a real color. Thin lines still count with their own
 * color, unless a 1 px line has a color between its neighbours' (it cannot
 * be told apart from an edge). A transparent entry is added when the image
 * has transparent pixels.
 */
export function quantizePalette(imageData: ImageData, colors: number): RGBA[] {
  const { data } = imageData;
  const mixed = mixedPixels(imageData);
  const bins = new Map<
    number,
    { n: number; r: number; g: number; b: number }
  >();
  let transparent = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      transparent = true;
      continue;
    }
    if (mixed[i / 4]) continue;
    const key =
      ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += data[i];
    bin.g += data[i + 1];
    bin.b += data[i + 2];
    bins.set(key, bin);
  }
  const points = [...bins.values()].map((bin) => ({
    n: bin.n,
    r: bin.r / bin.n,
    g: bin.g / bin.n,
    b: bin.b / bin.n,
  }));
  const distance = (
    p: { r: number; g: number; b: number },
    q: { r: number; g: number; b: number },
  ) => (p.r - q.r) ** 2 + (p.g - q.g) ** 2 + (p.b - q.b) ** 2;

  const centers: { r: number; g: number; b: number }[] = [];
  if (points.length > 0) {
    centers.push(points.reduce((a, b) => (b.n > a.n ? b : a)));
  }
  while (centers.length < Math.min(colors, points.length)) {
    let best = points[0];
    let bestScore = -1;
    for (const p of points) {
      const score = p.n * Math.min(...centers.map((c) => distance(p, c)));
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (bestScore <= 0) break;
    centers.push({ ...best });
  }

  for (let round = 0; round < PALETTE_ITERATIONS; round++) {
    const sums = centers.map(() => ({ n: 0, r: 0, g: 0, b: 0 }));
    for (const p of points) {
      let k = 0;
      let kDistance = Infinity;
      centers.forEach((c, i) => {
        const d = distance(p, c);
        if (d < kDistance) {
          kDistance = d;
          k = i;
        }
      });
      sums[k].n += p.n;
      sums[k].r += p.r * p.n;
      sums[k].g += p.g * p.n;
      sums[k].b += p.b * p.n;
    }
    sums.forEach((sum, i) => {
      if (sum.n > 0) {
        centers[i] = { r: sum.r / sum.n, g: sum.g / sum.n, b: sum.b / sum.n };
      }
    });
  }

  const palette: RGBA[] = centers.map((c) => ({
    r: Math.round(c.r),
    g: Math.round(c.g),
    b: Math.round(c.b),
    a: 255,
  }));
  if (transparent) palette.push({ r: 0, g: 0, b: 0, a: 0 });
  return palette;
}

/** Closed polygon from a traced path; quadratic curves are flattened */
function pathToRing(path: TracePath): Ring {
  const ring: Point[] = [];
  for (const s of path.segments) {
    ring.push({ x: s.x1, y: s.y1 });
    if (s.type === "Q" && s.x3 !== undefined && s.y3 !== undefined) {
      for (const t of [0.25, 0.5, 0.75]) {
        const u = 1 - t;
        ring.push({
          x: u * u * s.x1 + 2 * u * t * s.x2 + t * t * s.x3,
          y: u * u * s.y1 + 2 * u * t * s.y2 + t * t * s.y3,
        });
      }
    }
  }
  return ring;
}

export function nearestPaletteIndex(
  palette: RGBA[],
  r: number,
  g: number,
  b: number,
) {
  let best = 0;
  let bestDistance = Infinity;
  palette.forEach((c, i) => {
    if (c.a < 128) return; // the transparent entry is not a color
    const d = (c.r - r) ** 2 + (c.g - g) ** 2 + (c.b - b) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

/** Palette color covering most of the image border, if it dominates */
export function findBackground(
  imageData: ImageData,
  palette: RGBA[],
): number | null {
  const { width, height, data } = imageData;
  const counts = new Array<number>(palette.length).fill(0);
  let total = 0;
  const count = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 128) return; // transparent pixels are skipped anyway
    counts[nearestPaletteIndex(palette, data[i], data[i + 1], data[i + 2])]++;
    total++;
  };
  for (let x = 0; x < width; x++) {
    count(x, 0);
    count(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    count(0, y);
    count(width - 1, y);
  }
  if (total === 0) return null;
  const best = counts.indexOf(Math.max(...counts));
  return counts[best] / total >= BACKGROUND_BORDER_SHARE ? best : null;
}

/**
 * Trace an image into colored regions
 *
 * @param palette - colors to map the pixels to (see quantizePalette)
 * @param backgroundIndex - palette entry that is the background, if any
 */
/**
 * Copy of the image with alpha set to fully transparent or fully opaque, so
 * half-transparent pixels are traced the same way the palette treats them
 */
export function binarizeAlpha(imageData: ImageData): ImageData {
  const data = new Uint8ClampedArray(imageData.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
    } else {
      data[i + 3] = 255;
    }
  }
  return {
    width: imageData.width,
    height: imageData.height,
    data,
    colorSpace: imageData.colorSpace,
  } as ImageData;
}

export function traceImage(
  imageData: ImageData,
  palette: RGBA[],
  backgroundIndex: number | null,
): TracedImage {
  const traced = ImageTracer.imagedataToTracedata(imageData, {
    // Copy: the tracer keeps a reference and may average it
    pal: palette.map((c) => ({ ...c })),
    colorquantcycles: 1, // only map pixels to the palette above
    pathomit: 16, // drop specks smaller than this many pixels
    ltres: 1,
    qtres: 1,
    rightangleenhance: false,
    blurradius: 0,
  }) as {
    width: number;
    height: number;
    palette: RGBA[];
    layers: TracePath[][];
  };

  const regions: TracedRegion[] = [];
  traced.layers.forEach((paths, colorIndex) => {
    // Fully transparent colors (e.g. PNG background) are never sewn
    if (traced.palette[colorIndex].a < 128) return;
    for (const path of paths) {
      if (path.isholepath) continue;
      const outer = pathToRing(path);
      if (outer.length < 3) continue;
      const holes = path.holechildren
        .map((i) => pathToRing(paths[i]))
        .filter((ring) => ring.length >= 3);
      regions.push({ colorIndex, rings: [outer, ...holes] });
    }
  });

  return {
    width: traced.width,
    height: traced.height,
    palette: traced.palette,
    regions,
    backgroundIndex,
  };
}
