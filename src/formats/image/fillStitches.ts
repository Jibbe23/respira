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
  // "nonzero" for rings from offsetRings (they may overlap themselves)
  rule?: FillRule;
}

/**
 * Which points are inside: "evenodd" (any ring direction), or "nonzero" for
 * rings with outer rings counter-clockwise and holes clockwise (math
 * orientation), where parts of a ring that overlap stay filled
 */
export type FillRule = "evenodd" | "nonzero";

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
 * holes get smaller (holes narrower than 2 x distance are dropped). Each
 * vertex moves along the bisector of its two edges. Where the grown ring
 * overlaps itself (narrow notches), fill with the "nonzero" rule.
 */
/**
 * Is a hole too narrow to stay open when the area grows by `distance`?
 * Width estimated as 2 x area / perimeter (exact for long strips, half the
 * side for squares, where the hole closes at the same distance)
 */
export function holeClosesAt(hole: Ring, distance: number): boolean {
  let perimeter = 0;
  for (let i = 0; i < hole.length; i++) {
    const a = hole[i];
    const b = hole[(i + 1) % hole.length];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return (
    (2 * Math.abs(signedArea(hole))) / Math.max(1e-9, perimeter) < distance
  );
}

export function offsetRings(rings: Ring[], distance: number): Ring[] {
  const result: Ring[] = [];
  rings.forEach((input, index) => {
    // Repeated points have no direction (their normal would be zero)
    const ring = input.filter((p, i) => {
      const prev = input[(i - 1 + input.length) % input.length];
      return Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6;
    });
    const area = signedArea(ring);
    if (ring.length < 3 || area === 0) return;
    const isHole = index > 0;
    if (isHole && holeClosesAt(ring, distance)) return;
    // Normal pointing away from the filled area: out of the outer ring,
    // into a hole
    const side = (area > 0 ? 1 : -1) * (isHole ? -1 : 1);
    const normal = (a: Point, b: Point) => {
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      return {
        x: (side * (b.y - a.y)) / length,
        y: (side * -(b.x - a.x)) / length,
      };
    };
    let moved = ring.map((p, i) => {
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
    // Outer rings counter-clockwise, holes clockwise (for the nonzero rule)
    if (signedArea(moved) > 0 === isHole) moved = moved.reverse();
    result.push(moved);
  });
  return result;
}

/** Distance from p to the nearest edge of the rings */
export function distanceToRings(p: Point, rings: Ring[]): number {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
        ),
      );
      best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
    }
  }
  return best;
}

/** Is p inside the rings, by the same rule as the fill (see FillRule)? */
export function insideRings(
  p: Point,
  rings: Ring[],
  rule: FillRule = "evenodd",
): boolean {
  let winding = 0;
  let crossings = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a.y <= p.y !== b.y <= p.y) {
        const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x > p.x) {
          crossings++;
          winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return rule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
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
 * Horizontal scanline segments inside the rings (see FillRule), with the
 * rings rotated so that rows run along `angle`
 */
function scanlineSegments(
  rings: Ring[],
  cos: number,
  sin: number,
  spacing: number,
  inset: number,
  rule: FillRule = "evenodd",
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
    const xs: { x: number; up: number; position: RingPosition }[] = [];
    rotated.forEach((ring, r) => {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        // Half-open rule so a vertex on the scanline counts once
        if (a.y <= y !== b.y <= y) {
          const t = (y - a.y) / (b.y - a.y);
          xs.push({
            x: a.x + t * (b.x - a.x),
            up: b.y > a.y ? 1 : -1,
            position: { ring: r, edge: i, t },
          });
        }
      }
    });
    xs.sort((p, q) => p.x - q.x);
    // Pairs of crossings that enter and leave the inside
    const spans: [number, number][] = [];
    if (rule === "evenodd") {
      for (let i = 0; i + 1 < xs.length; i += 2) spans.push([i, i + 1]);
    } else {
      let winding = 0;
      let from = 0;
      xs.forEach((crossing, i) => {
        const before = winding;
        winding += crossing.up;
        if (before === 0 && winding !== 0) from = i;
        if (before !== 0 && winding === 0) spans.push([from, i]);
      });
    }
    for (const [i, j] of spans) {
      const x0 = xs[i].x + inset;
      const x1 = xs[j].x - inset;
      if (x1 - x0 >= 1) {
        segments.push({
          row,
          y,
          x0,
          x1,
          start: xs[i].position,
          end: xs[j].position,
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
    options.rule,
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
  rule: FillRule = "evenodd",
): [RingPosition, RingPosition][] {
  const rad = (angle * Math.PI) / 180;
  return scanlineSegments(
    rings,
    Math.cos(-rad),
    Math.sin(-rad),
    spacing,
    0,
    rule,
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
