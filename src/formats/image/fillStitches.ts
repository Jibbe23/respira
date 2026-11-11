/**
 * Stitch generation for filled regions (image to embroidery)
 *
 * All coordinates are in 0.1 mm units. A region is a list of closed rings
 * (outer contour plus holes) filled with the even-odd rule, so the rings do
 * not need a particular winding order.
 */

export interface Point {
  x: number;
  y: number;
}

export type Ring = Point[];

export interface FillOptions {
  angle: number; // row direction in degrees
  spacing: number; // distance between rows
  stitchLength: number; // maximum stitch length along a row
  // Shortens every row at both ends (keeps underlay inside the top stitches)
  inset?: number;
}

/** Point on ring `ring`, on the edge from vertex `edge` to the next, at fraction `t` */
export interface RingPosition {
  ring: number;
  edge: number;
  t: number;
}

/** Row segment on scanline `row`, x range in rotated coordinates */
interface Segment {
  row: number;
  y: number;
  x0: number;
  x1: number;
  // Where the row crosses the rings (before the inset)
  start: RingPosition;
  end: RingPosition;
}

const rotate = (p: Point, cos: number, sin: number): Point => ({
  x: p.x * cos - p.y * sin,
  y: p.x * sin + p.y * cos,
});

/** Area of a ring (absolute value of the shoelace formula) */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Signed area of a ring (shoelace): the sign gives its direction */
function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * Grow a region by `distance` in all directions: the outer ring moves out,
 * holes get smaller (holes too small to keep are dropped). Each vertex moves
 * along the bisector of its two edges.
 */
export function offsetRings(rings: Ring[], distance: number): Ring[] {
  const result: Ring[] = [];
  rings.forEach((ring, index) => {
    const area = signedArea(ring);
    if (ring.length < 3 || area === 0) return;
    const isHole = index > 0;
    if (isHole && Math.abs(area) < (4 * distance) ** 2) return;
    // Normal pointing away from the filled area: out of the outer ring,
    // into a hole
    const side = (area > 0 ? 1 : -1) * (isHole ? -1 : 1);
    const normal = (a: Point, b: Point) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return {
        x: (side * (b.y - a.y)) / length,
        y: (side * -(b.x - a.x)) / length,
      };
    };
    const moved = ring.map((p, i) => {
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const next = ring[(i + 1) % ring.length];
      const n1 = normal(prev, p);
      const n2 = normal(p, next);
      let mx = n1.x + n2.x;
      let my = n1.y + n2.y;
      const length = Math.hypot(mx, my);
      if (length < 1e-6) {
        mx = n1.x;
        my = n1.y;
      } else {
        mx /= length;
        my /= length;
      }
      // Corners move farther to keep both edges at the distance, at most 2x
      const scale = distance / Math.max(0.5, mx * n1.x + my * n1.y);
      return { x: p.x + mx * scale, y: p.y + my * scale };
    });
    // A hole that turned inside out is gone
    if (isHole && Math.sign(signedArea(moved)) !== Math.sign(area)) return;
    result.push(moved);
  });
  return result;
}

/** Area of a region: outer ring minus holes */
export function regionArea(rings: Ring[]): number {
  if (rings.length === 0) return 0;
  return Math.max(
    0,
    ringArea(rings[0]) -
      rings.slice(1).reduce((sum, hole) => sum + ringArea(hole), 0),
  );
}

/**
 * Horizontal scanline segments inside the rings (even-odd rule), with the
 * rings rotated so that rows run along `angle`
 */
function scanlineSegments(
  rings: Ring[],
  cos: number,
  sin: number,
  spacing: number,
  inset: number,
): Segment[] {
  const rotated = rings.map((ring) => ring.map((p) => rotate(p, cos, sin)));
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rotated) {
    for (const p of ring) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }

  const segments: Segment[] = [];
  let row = 0;
  for (let y = minY + spacing / 2; y < maxY; y += spacing, row++) {
    const xs: { x: number; position: RingPosition }[] = [];
    rotated.forEach((ring, r) => {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        // Half-open rule so a vertex on the scanline counts once
        if (a.y <= y !== b.y <= y) {
          const t = (y - a.y) / (b.y - a.y);
          xs.push({
            x: a.x + t * (b.x - a.x),
            position: { ring: r, edge: i, t },
          });
        }
      }
    });
    xs.sort((p, q) => p.x - q.x);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i].x + inset;
      const x1 = xs[i + 1].x - inset;
      if (x1 - x0 >= 1) {
        segments.push({
          row,
          y,
          x0,
          x1,
          start: xs[i].position,
          end: xs[i + 1].position,
        });
      }
    }
  }
  return segments;
}

/**
 * Group row segments into blocks that can be sewn back and forth without a
 * jump: each block takes at most one overlapping segment per row, and only
 * if the stitch from the end of one row to the start of the next stays
 * within `maxConnect` (rows alternate direction, see tatamiFill).
 */
function groupIntoBlocks(segments: Segment[], maxConnect: number): Segment[][] {
  const byRow = new Map<number, Segment[]>();
  for (const s of segments) {
    const list = byRow.get(s.row) ?? [];
    list.push(s);
    byRow.set(s.row, list);
  }

  const used = new Set<Segment>();
  const blocks: Segment[][] = [];
  for (const start of segments) {
    if (used.has(start)) continue;
    const block = [start];
    used.add(start);
    let current = start;
    for (;;) {
      // Odd rows run right to left: the previous row ended on the right
      const endsRight = (block.length - 1) % 2 === 0;
      const next = (byRow.get(current.row + 1) ?? []).find(
        (s) =>
          !used.has(s) &&
          s.x0 < current.x1 &&
          s.x1 > current.x0 &&
          Math.abs(endsRight ? s.x1 - current.x1 : s.x0 - current.x0) <=
            maxConnect,
      );
      if (!next) break;
      block.push(next);
      used.add(next);
      current = next;
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * Points along one row from `from` to `to` (rotated coordinates). Needle
 * points sit on a grid shifted per row (brick pattern), so the stitch ends do
 * not line up into visible lines.
 */
function rowPoints(
  y: number,
  from: number,
  to: number,
  row: number,
  stitchLength: number,
): Point[] {
  const points: Point[] = [{ x: from, y }];
  const dir = to > from ? 1 : -1;
  const offset = ((row % 3) * stitchLength) / 3;
  // First grid position after `from` in the direction of travel
  const k0 =
    dir > 0
      ? Math.floor((from - offset) / stitchLength) + 1
      : Math.ceil((from - offset) / stitchLength) - 1;
  const minGap = stitchLength / 3;
  for (let k = k0; ; k += dir) {
    const x = k * stitchLength + offset;
    if ((x - to) * dir > -minGap) break;
    if ((x - from) * dir >= minGap) points.push({ x, y });
  }
  points.push({ x: to, y });
  return points;
}

/**
 * Tatami fill: rows along `angle`, sewn back and forth per block. Returns one
 * point list per block (consecutive points are stitches; the caller decides
 * how to travel between blocks).
 */
export function tatamiFill(rings: Ring[], options: FillOptions): Point[][] {
  const rad = (options.angle * Math.PI) / 180;
  // Rotate by -angle so rows become horizontal, and back afterwards
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const segments = scanlineSegments(
    rings,
    cos,
    sin,
    options.spacing,
    options.inset ?? 0,
  );

  const maxStitch = (options.stitchLength * 4) / 3;
  return groupIntoBlocks(segments, options.stitchLength).map((block) => {
    const points: Point[] = [];
    let rowStart = 0;
    block.forEach((s, i) => {
      const leftToRight = i % 2 === 0;
      const row = rowPoints(
        s.y,
        leftToRight ? s.x0 : s.x1,
        leftToRight ? s.x1 : s.x0,
        s.row,
        options.stitchLength,
      );
      // Skip the last stitch of the previous row: its end and the start of
      // this row would be two needle holes right next to each other at the
      // edge (short stitch that strains the thread)
      const end = points.length - 1;
      if (
        end - rowStart >= 2 &&
        Math.hypot(
          points[end - 1].x - row[0].x,
          points[end - 1].y - row[0].y,
        ) <= maxStitch
      ) {
        points.pop();
      }
      rowStart = points.length;
      points.push(...row);
    });
    return points.map((p) => rotate(p, Math.cos(rad), Math.sin(rad)));
  });
}

/**
 * Where the fill rows along `angle` cross the rings: one pair of ring
 * positions per row segment (used to travel inside a region)
 */
export function fillRowCrossings(
  rings: Ring[],
  angle: number,
  spacing: number,
): [RingPosition, RingPosition][] {
  const rad = (angle * Math.PI) / 180;
  return scanlineSegments(
    rings,
    Math.cos(-rad),
    Math.sin(-rad),
    spacing,
    0,
  ).map((s) => [s.start, s.end]);
}

/**
 * Running stitch along an open path: needle points every `stitchLength`,
 * sharp corners kept so lines stay crisp, ends at the last point. A corner
 * closer than `minCorner` to the previous needle point is cut short, unless
 * `minCorner` is 0 (travel must not cut across a narrow gap).
 */
export function runAlongPath(
  path: Point[],
  stitchLength: number,
  minCorner = stitchLength / 4,
): Point[] {
  if (path.length === 0) return [];
  const points: Point[] = [path[0]];
  let carried = 0; // distance travelled since the last needle point
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1];
    const b = path[n];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    let along = stitchLength - carried;
    while (along < length) {
      const t = along / length;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      along += stitchLength;
    }
    carried = length - (along - stitchLength);
    const last = n === path.length - 1;
    let sharpCorner = false;
    if (!last) {
      const c = path[n + 1];
      const turn = Math.abs(
        Math.atan2(
          (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x),
          (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y),
        ),
      );
      sharpCorner = turn > Math.PI / 6 && carried > minCorner;
    }
    if (sharpCorner || last) {
      points.push(b);
      carried = 0;
    }
  }
  return points;
}

/**
 * Running stitch around a closed ring, starting at the vertex closest to
 * `near` and ending there again
 */
export function runAroundRing(
  ring: Ring,
  stitchLength: number,
  near?: Point,
): Point[] {
  if (ring.length < 2) return [];
  let start = 0;
  if (near) {
    let best = Infinity;
    ring.forEach((p, i) => {
      const d = Math.hypot(p.x - near.x, p.y - near.y);
      if (d < best) {
        best = d;
        start = i;
      }
    });
  }
  const closed = [...ring.slice(start), ...ring.slice(0, start), ring[start]];
  return runAlongPath(closed, stitchLength);
}

/**
 * Sew a closed run (first point = last point) several times: twice goes
 * around twice, three times sews every stitch forward, back and forward
 * again (bean stitch), which gives a bold line
 */
export function repeatClosedRun(points: Point[], repeats: 1 | 2 | 3): Point[] {
  if (repeats === 1 || points.length < 2) return points;
  if (repeats === 2) return [...points, ...points.slice(1)];
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    result.push(points[i], points[i - 1], points[i]);
  }
  return result;
}
