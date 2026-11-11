/**
 * Satin stitch for narrow shapes (lettering, contour lines): dense zigzag
 * across the stroke from edge to edge instead of a tatami fill, which leaves
 * gaps in strokes of 1-3 mm.
 *
 * The region is rasterized, its distance transform gives the stroke width
 * and its skeleton (Zhang-Suen thinning) the center lines. The skeleton is a
 * graph of strokes; each stroke is sewn out and back from the node it
 * starts at: a center run as underlay out, satin back. A depth-first walk
 * over the graph sews every stroke without jumping.
 *
 * Coordinates in 0.1 mm units; one raster pixel is one unit.
 */

import { runAlongPath, type Point, type Ring } from "./fillStitches";

export interface SatinOptions {
  spacing: number; // zigzag spacing: from one peak to the next on one side
  pullCompensation: number; // added to each side (fabric pulls the edges in)
  underlayStitch: number; // stitch length of the center run underlay
  maxWidth: number; // wider strokes are left to the tatami fill
}

/** Spurs of the skeleton shorter than this share of the width are cut */
const SPUR_FACTOR = 1.5;
/** Smoothing window (pixels each side) for the center lines */
const SMOOTH = 3;
/** Narrowest satin (half width): very thin tips still get a visible stitch */
const MIN_HALF_WIDTH = 2;
/** No satin stitch longer than this share of maxWidth, even at junctions */
const MAX_WIDTH_FACTOR = 1.25;
/** Share of the stroke samples that must be narrower than maxWidth */
const NARROW_SHARE = 0.9;

interface Raster {
  width: number;
  height: number;
  originX: number;
  originY: number;
  inside: Uint8Array;
}

/** Fill the rings (even-odd, holes included) into a 1 unit raster */
function rasterize(rings: Ring[]): Raster | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  // One empty pixel around the shape, so every inside pixel has an outside
  const originX = Math.floor(minX) - 2;
  const originY = Math.floor(minY) - 2;
  const width = Math.ceil(maxX) - originX + 3;
  const height = Math.ceil(maxY) - originY + 3;
  const inside = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const cy = originY + y + 0.5;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a.y <= cy !== b.y <= cy) {
          xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - originX - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - originX - 0.5));
      for (let x = from; x <= to; x++) inside[y * width + x] = 1;
    }
  }
  return { width, height, originX, originY, inside };
}

/** Exact Euclidean distance of each inside pixel to the nearest outside one */
function distanceTransform({ width, height, inside }: Raster): Float32Array {
  const INF = 1e12;
  const f = new Float64Array(width * height);
  for (let i = 0; i < f.length; i++) f[i] = inside[i] ? INF : 0;

  // 1D squared distance transform (Felzenszwalb and Huttenlocher)
  const n = Math.max(width, height);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const line = new Float64Array(n);
  const pass = (length: number, get: (i: number) => number) => {
    for (let i = 0; i < length; i++) line[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < length; q++) {
      let s =
        (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < length; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + line[v[k]];
    }
  };
  for (let x = 0; x < width; x++) {
    pass(height, (y) => f[y * width + x]);
    for (let y = 0; y < height; y++) f[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    pass(width, (x) => f[y * width + x]);
    for (let x = 0; x < width; x++) f[y * width + x] = d[x];
  }
  const result = new Float32Array(width * height);
  for (let i = 0; i < f.length; i++) result[i] = Math.sqrt(f[i]);
  return result;
}

/**
 * Zhang-Suen thinning: one pixel wide center lines of the shape. Each round
 * peels one pixel off every side; null if the shape is not thin after
 * `maxRounds` (a part wider than 2 × maxRounds)
 */
function skeletonize(
  { width, height, inside }: Raster,
  maxRounds: number,
): Uint8Array | null {
  const img = inside.slice();
  let changed = true;
  const remove: number[] = [];
  for (let round = 0; changed; round++) {
    if (round > maxRounds) return null;
    changed = false;
    for (const step of [0, 1]) {
      remove.length = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (!img[i]) continue;
          // Neighbours clockwise from north
          const p2 = img[i - width];
          const p3 = img[i - width + 1];
          const p4 = img[i + 1];
          const p5 = img[i + width + 1];
          const p6 = img[i + width];
          const p7 = img[i + width - 1];
          const p8 = img[i - 1];
          const p9 = img[i - width - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a =
            (!p2 && p3 ? 1 : 0) +
            (!p3 && p4 ? 1 : 0) +
            (!p4 && p5 ? 1 : 0) +
            (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) +
            (!p7 && p8 ? 1 : 0) +
            (!p8 && p9 ? 1 : 0) +
            (!p9 && p2 ? 1 : 0);
          if (a !== 1) continue;
          if (
            step === 0
              ? p2 * p4 * p6 || p4 * p6 * p8
              : p2 * p4 * p8 || p2 * p6 * p8
          ) {
            continue;
          }
          remove.push(i);
        }
      }
      for (const i of remove) img[i] = 0;
      if (remove.length > 0) changed = true;
    }
  }
  return img;
}

interface Stroke {
  a: number; // node at the start of `pixels`
  b: number; // node at the end
  pixels: number[]; // raster indices from node a to node b
  removed?: boolean;
}

interface SkeletonGraph {
  nodePixels: number[][]; // pixels of each node (clusters of junctions/ends)
  strokes: Stroke[];
}

const NEIGHBORS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/** Split the skeleton into strokes between end points and junctions */
function skeletonGraph(skeleton: Uint8Array, width: number): SkeletonGraph {
  const neighbors = (i: number) => {
    const x = i % width;
    const y = (i - x) / width;
    const result: number[] = [];
    for (const [dx, dy] of NEIGHBORS) {
      const j = (y + dy) * width + x + dx;
      if (skeleton[j]) result.push(j);
    }
    return result;
  };

  const pixels: number[] = [];
  for (let i = 0; i < skeleton.length; i++) if (skeleton[i]) pixels.push(i);

  // Nodes: pixels that are not on a plain line, clustered when they touch
  const nodeOf = new Map<number, number>();
  const nodePixels: number[][] = [];
  const isNodePixel = (i: number) => neighbors(i).length !== 2;
  for (const start of pixels) {
    if (nodeOf.has(start) || !isNodePixel(start)) continue;
    const id = nodePixels.length;
    const cluster: number[] = [];
    const stack = [start];
    nodeOf.set(start, id);
    while (stack.length > 0) {
      const i = stack.pop()!;
      cluster.push(i);
      for (const j of neighbors(i)) {
        if (!nodeOf.has(j) && isNodePixel(j)) {
          nodeOf.set(j, id);
          stack.push(j);
        }
      }
    }
    nodePixels.push(cluster);
  }

  const strokes: Stroke[] = [];
  const used = new Set<number>(); // line pixels already in a stroke
  const walk = (from: number, first: number) => {
    const line = [from, first];
    used.add(first);
    let prev = from;
    let current = first;
    for (;;) {
      if (nodeOf.has(current)) break;
      const next = neighbors(current).find(
        (j) => j !== prev && (nodeOf.has(j) || !used.has(j)),
      );
      if (next === undefined) break;
      if (!nodeOf.has(next)) used.add(next);
      line.push(next);
      prev = current;
      current = next;
    }
    const end = line[line.length - 1];
    if (!nodeOf.has(end)) {
      // Dead end without a node (should not happen): make it one
      nodeOf.set(end, nodePixels.length);
      nodePixels.push([end]);
    }
    strokes.push({ a: nodeOf.get(from)!, b: nodeOf.get(end)!, pixels: line });
  };
  for (const [id, cluster] of nodePixels.entries()) {
    for (const i of cluster) {
      for (const j of neighbors(i)) {
        if (nodeOf.get(j) === id || used.has(j)) continue;
        if (nodeOf.has(j)) {
          // Two node clusters touching directly cannot happen (clustered)
          continue;
        }
        walk(i, j);
      }
    }
  }
  // Closed loops without any node (e.g. the skeleton of an "o")
  for (const start of pixels) {
    if (nodeOf.has(start) || used.has(start)) continue;
    const id = nodePixels.length;
    nodePixels.push([start]);
    nodeOf.set(start, id);
    const next = neighbors(start).find((j) => !used.has(j) && !nodeOf.has(j));
    if (next !== undefined) walk(start, next);
  }
  return { nodePixels, strokes };
}

/**
 * Cut spurs at end points that reach hardly beyond the satin of the stroke
 * they branch off (thinning artifacts at corners). Real short arms, like
 * the bar of a t, reach farther and stay.
 */
function pruneSpurs(
  graph: SkeletonGraph,
  distance: Float32Array,
  width: number,
) {
  const point = (i: number) => ({ x: i % width, y: Math.floor(i / width) });
  for (let round = 0; round < 3; round++) {
    const degree = new Array(graph.nodePixels.length).fill(0);
    for (const s of graph.strokes) {
      if (s.removed) continue;
      degree[s.a]++;
      degree[s.b]++;
    }
    let cut = false;
    for (const s of graph.strokes) {
      if (s.removed || s.a === s.b) continue;
      const tipAtB = degree[s.b] === 1 && degree[s.a] >= 3;
      const tipAtA = degree[s.a] === 1 && degree[s.b] >= 3;
      if (!tipAtA && !tipAtB) continue;
      const base = tipAtB ? s.a : s.b;
      const tipPixel = tipAtB ? s.pixels[s.pixels.length - 1] : s.pixels[0];
      const basePixel = tipAtB ? s.pixels[0] : s.pixels[s.pixels.length - 1];
      // How far the stroke reaches from the junction, to the edge of the
      // shape, against the half width of the satin there
      const tip = point(tipPixel);
      const from = point(basePixel);
      const reach =
        Math.hypot(tip.x - from.x, tip.y - from.y) + distance[tipPixel];
      const baseHalf = Math.max(
        ...graph.nodePixels[base].map((i) => distance[i]),
      );
      if (reach < SPUR_FACTOR * baseHalf) {
        s.removed = true;
        cut = true;
        degree[s.a]--;
        degree[s.b]--;
      }
    }
    if (!cut) break;
  }
}

/**
 * Join strokes meeting at nodes with only two strokes (thinning leaves such
 * nodes at stair steps of diagonal lines), so each stroke is sewn in one go
 */
function joinStrokes(graph: SkeletonGraph) {
  const at = new Map<number, Set<Stroke>>();
  const attach = (s: Stroke) => {
    for (const node of [s.a, s.b]) {
      if (!at.has(node)) at.set(node, new Set());
      at.get(node)!.add(s);
    }
  };
  const detach = (s: Stroke) => {
    at.get(s.a)?.delete(s);
    at.get(s.b)?.delete(s);
  };
  // Number of stroke ends at a node (a loop counts twice)
  const degree = (node: number) => {
    let n = 0;
    for (const s of at.get(node) ?? []) n += s.a === s.b ? 2 : 1;
    return n;
  };
  for (const s of graph.strokes) if (!s.removed) attach(s);

  const queue = [...at.keys()];
  while (queue.length > 0) {
    const node = queue.pop()!;
    if (degree(node) !== 2) continue;
    const pair = [...at.get(node)!];
    if (pair.length !== 2) continue; // a loop on its own
    const [s1, s2] = pair;
    // s1 ends at the node, s2 starts there
    const first = s1.b === node ? s1.pixels : [...s1.pixels].reverse();
    const second = s2.a === node ? s2.pixels : [...s2.pixels].reverse();
    // Node clusters can have several pixels: keep both ends then
    const rest =
      first[first.length - 1] === second[0] ? second.slice(1) : second;
    const joined: Stroke = {
      a: s1.b === node ? s1.a : s1.b,
      b: s2.a === node ? s2.b : s2.a,
      pixels: [...first, ...rest],
    };
    s1.removed = true;
    s2.removed = true;
    detach(s1);
    detach(s2);
    graph.strokes.push(joined);
    attach(joined);
    queue.push(joined.a, joined.b);
  }
}

/** Distance transform at a sub-pixel position (bilinear) */
function sampleDistance(
  distance: Float32Array,
  width: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => distance[yy * width + xx] ?? 0;
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  );
}

/** Moving average that keeps both ends in place */
function smooth(points: Point[], radius: number): Point[] {
  if (points.length <= 2) return points;
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    const r = Math.min(radius, i, points.length - 1 - i);
    let x = 0;
    let y = 0;
    for (let k = i - r; k <= i + r; k++) {
      x += points[k].x;
      y += points[k].y;
    }
    return { x: x / (2 * r + 1), y: y / (2 * r + 1) };
  });
}

/**
 * Continue a stroke from its free end straight on to the edge of the shape:
 * the skeleton stops about half a width short of the tip
 */
function extendToEdge(points: Point[], raster: Raster): Point[] {
  const n = points.length;
  if (n < 2) return points;
  const end = points[n - 1];
  const back = points[Math.max(0, n - 1 - 4)];
  const length = Math.hypot(end.x - back.x, end.y - back.y);
  if (length === 0) return points;
  const dx = (end.x - back.x) / length;
  const dy = (end.y - back.y) / length;
  const extra: Point[] = [];
  for (let t = 1; t < 200; t++) {
    const x = end.x + dx * t;
    const y = end.y + dy * t;
    // Pixel centers are at whole numbers
    const i = Math.round(y) * raster.width + Math.round(x);
    if (!raster.inside[i]) break;
    extra.push({ x, y });
  }
  return [...points, ...extra];
}

interface SatinStroke {
  a: number;
  b: number;
  center: Point[]; // pattern coordinates from node a to node b
  left: Point[]; // satin edge points, one per sample, from a to b
  right: Point[];
}

/**
 * Satin stitches for a narrow region: one run (underlay and satin) per
 * connected part, the first starting near `start`; null if the region is
 * too wide for satin or has no usable center line (then it gets a tatami
 * fill)
 */
export function satinStitches(
  rings: Ring[],
  start: Point | null,
  options: SatinOptions,
): Point[][] | null {
  const raster = rasterize(rings);
  if (!raster) return null;
  const distance = distanceTransform(raster);
  // The center line runs through the widest spot: too wide, no satin (and
  // no thinning, which is slow for large areas)
  const maxStitch = options.maxWidth * MAX_WIDTH_FACTOR;
  let widest = 0;
  for (const d of distance) widest = Math.max(widest, d);
  if (2 * (widest - 0.5) > maxStitch) return null;
  // Thin shapes are done after about half their width in rounds
  const skeleton = skeletonize(raster, Math.ceil(options.maxWidth / 2) + 4);
  if (!skeleton) return null;
  const graph = skeletonGraph(skeleton, raster.width);
  joinStrokes(graph);
  pruneSpurs(graph, distance, raster.width);
  joinStrokes(graph);
  const live = graph.strokes.filter((s) => !s.removed);
  if (live.length === 0) return null;

  const degree = new Array(graph.nodePixels.length).fill(0);
  for (const s of live) {
    degree[s.a]++;
    degree[s.b]++;
  }
  const toPattern = (p: Point): Point => ({
    x: p.x + raster.originX + 0.5,
    y: p.y + raster.originY + 0.5,
  });

  const strokes: SatinStroke[] = [];
  const halfWidths: number[] = [];
  for (const s of live) {
    let points = s.pixels.map((i) => {
      const x = i % raster.width;
      return { x, y: (i - x) / raster.width };
    });
    points = smooth(points, SMOOTH);
    // Free ends reach to the tip of the stroke
    if (degree[s.b] === 1) points = extendToEdge(points, raster);
    if (degree[s.a] === 1)
      points = extendToEdge([...points].reverse(), raster).reverse();

    // Peaks alternate sides: a sample every half spacing
    const samples = runAlongPath(points, options.spacing / 2, 0);
    if (samples.length < 2) continue;
    const left: Point[] = [];
    const right: Point[] = [];
    samples.forEach((p, i) => {
      const prev = samples[Math.max(0, i - 1)];
      const next = samples[Math.min(samples.length - 1, i + 1)];
      const tx = next.x - prev.x;
      const ty = next.y - prev.y;
      const length = Math.hypot(tx, ty) || 1;
      const nx = -ty / length;
      const ny = tx / length;
      const half = Math.max(
        MIN_HALF_WIDTH,
        sampleDistance(distance, raster.width, p.x, p.y) - 0.5,
      );
      halfWidths.push(half);
      const reach = half + options.pullCompensation;
      left.push(toPattern({ x: p.x + nx * reach, y: p.y + ny * reach }));
      right.push(toPattern({ x: p.x - nx * reach, y: p.y - ny * reach }));
    });
    strokes.push({
      a: s.a,
      b: s.b,
      center: points.map(toPattern),
      left,
      right,
    });
  }
  if (strokes.length === 0) return null;

  // Narrow enough? Most of the stroke within maxWidth (junctions are
  // wider), and no stitch much longer anywhere (long satin snags)
  halfWidths.sort((a, b) => a - b);
  const typical =
    halfWidths[
      Math.min(
        halfWidths.length - 1,
        Math.floor(halfWidths.length * NARROW_SHARE),
      )
    ];
  if (2 * typical > options.maxWidth) return null;
  if (2 * halfWidths[halfWidths.length - 1] > maxStitch) return null;

  const byNode = new Map<number, SatinStroke[]>();
  for (const s of strokes) {
    byNode.set(s.a, [...(byNode.get(s.a) ?? []), s]);
    if (s.b !== s.a) byNode.set(s.b, [...(byNode.get(s.b) ?? []), s]);
  }
  const sewn = new Set<SatinStroke>();

  // Where sewing can start: the ends of unsewn strokes, free ends preferred
  const nearestStart = (from: Point | null): number => {
    let best = Infinity;
    let node = -1;
    for (const s of strokes) {
      if (sewn.has(s)) continue;
      for (const [id, p] of [
        [s.a, s.center[0]],
        [s.b, s.center[s.center.length - 1]],
      ] as const) {
        const d =
          (from ? Math.hypot(p.x - from.x, p.y - from.y) : 0) +
          (degree[id] === 1 ? 0 : 20);
        if (d < best) {
          best = d;
          node = id;
        }
      }
    }
    return node;
  };

  // Depth-first: every stroke out (center run) and back (satin), so the
  // needle is at the node again afterwards
  const visited = new Set<number>();
  const sewFrom = (node: number, run: Point[]) => {
    for (const s of byNode.get(node) ?? []) {
      if (sewn.has(s)) continue;
      sewn.add(s);
      const forward = s.a === node;
      const center = forward ? s.center : [...s.center].reverse();
      const left = forward ? s.left : [...s.left].reverse();
      const right = forward ? s.right : [...s.right].reverse();
      const other = forward ? s.b : s.a;

      run.push(...runAlongPath(center, options.underlayStitch, 0));
      if (!visited.has(other)) {
        visited.add(other);
        sewFrom(other, run);
      }
      // Back to `node` in zigzag from edge to edge, one stitch per sample
      for (let i = left.length - 1; i >= 0; i--) {
        run.push(i % 2 === 0 ? left[i] : right[i]);
      }
      run.push(center[0]);
    }
  };

  // One run per connected part (the caller jumps between them)
  const runs: Point[][] = [];
  let position = start;
  for (;;) {
    const first = nearestStart(position);
    if (first < 0) break;
    const run: Point[] = [];
    visited.add(first);
    sewFrom(first, run);
    if (run.length === 0) break;
    runs.push(run);
    position = run[run.length - 1];
  }
  return runs.length > 0 ? runs : null;
}
