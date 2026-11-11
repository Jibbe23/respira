/**
 * Travel inside a region (image to embroidery): instead of jumping between
 * the blocks of a fill (and trimming the thread), the needle runs along the
 * region's outline or along fill rows to the next block. The outline is sewn
 * over afterwards and the rows are covered by fill, so the travel stitches
 * do not show. Same idea as the auto fill of Ink/Stitch.
 *
 * Coordinates in 0.1 mm units.
 */

import {
  distanceToRings,
  fillRowCrossings,
  insideRings,
  runAlongPath,
  type FillRule,
  type Point,
  type Ring,
  type RingPosition,
} from "./fillStitches";

/** Travel along a fill row shows more than along the outline (sewn over) */
const ROW_TRAVEL_COST = 2;
/** Farther from the graph than this, a point is reached by a jump */
const MAX_HOP = 30;
/**
 * A hop may start this far outside the region (0.5 mm): satin reaches a
 * little past the edge
 */
const NEAR_REGION = 5;
/** Candidates checked when looking for a node reachable in a straight line */
const HOP_CANDIDATES = 8;

export interface TravelEdge {
  to: number;
  cost: number;
  path: Point[]; // points after the start node, ending with node `to`
}

export interface TravelGraph {
  nodes: Point[];
  edges: TravelEdge[][];
  // Straight hops onto the graph must not cross these (none: no check)
  // and must stay inside them by `rule`
  rings?: Ring[];
  rule?: FillRule;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Does segment ab cross segment cd (touching at an end does not count)? */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  // Points on a ring are computed with rounding errors: treat almost
  // collinear as touching
  const side = (p: Point, q: Point, r: Point) => {
    const cross = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return Math.abs(cross) < 1e-6 ? 0 : Math.sign(cross);
  };
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/**
 * Graph along the outline (every ring vertex and every point where a fill
 * row meets the ring, connected in ring order) plus the fill rows between
 * their two ends
 */
export function createTravelGraph(
  rings: Ring[],
  angle: number,
  spacing: number,
  rule: FillRule = "evenodd",
): TravelGraph {
  const graph: TravelGraph = { nodes: [], edges: [], rings, rule };
  const addNode = (p: Point) => {
    graph.nodes.push(p);
    graph.edges.push([]);
    return graph.nodes.length - 1;
  };
  const link = (a: number, b: number, factor = 1) => {
    const cost = distance(graph.nodes[a], graph.nodes[b]) * factor;
    graph.edges[a].push({ to: b, cost, path: [graph.nodes[b]] });
    graph.edges[b].push({ to: a, cost, path: [graph.nodes[a]] });
  };

  // Per ring: nodes sorted by their position along the ring
  const onRing = rings.map((ring) =>
    ring.map((p, i) => ({ at: i, node: addNode(p) })),
  );
  const nodeAt = (at: RingPosition) => {
    const ring = rings[at.ring];
    if (at.t === 0) return onRing[at.ring][at.edge].node;
    const a = ring[at.edge];
    const b = ring[(at.edge + 1) % ring.length];
    const node = addNode({
      x: a.x + (b.x - a.x) * at.t,
      y: a.y + (b.y - a.y) * at.t,
    });
    onRing[at.ring].push({ at: at.edge + at.t, node });
    return node;
  };
  for (const [start, end] of fillRowCrossings(rings, angle, spacing, rule)) {
    link(nodeAt(start), nodeAt(end), ROW_TRAVEL_COST);
  }
  for (const list of onRing) {
    list.sort((p, q) => p.at - q.at);
    list.forEach((item, i) => {
      if (list.length > 1) link(item.node, list[(i + 1) % list.length].node);
    });
  }
  return graph;
}

/**
 * Nearest node that can be reached from `p` in a straight line without
 * leaving the region; -1 if there is none close enough. The hop must not
 * cross an edge, and its middle must lie in the region (or next to it): a
 * hop from a point outside onto a node on the edge crosses nothing, but
 * would be a stitch across the gap to the next region.
 */
function hopNode(graph: TravelGraph, p: Point): number {
  const order = graph.nodes
    .map((node, i) => ({ i, d: distance(node, p) }))
    .filter((c) => c.d <= MAX_HOP)
    .sort((a, b) => a.d - b.d)
    .slice(0, HOP_CANDIDATES);
  const rings = graph.rings;
  for (const { i } of order) {
    const node = graph.nodes[i];
    const blocked = rings?.some((ring) =>
      ring.some((a, k) => crosses(p, node, a, ring[(k + 1) % ring.length])),
    );
    if (blocked) continue;
    const middle = { x: (p.x + node.x) / 2, y: (p.y + node.y) / 2 };
    if (
      rings &&
      !insideRings(middle, rings, graph.rule) &&
      distanceToRings(middle, rings) > NEAR_REGION
    ) {
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Cheapest travel from `source` (Dijkstra, binary heap), stopping at the
 * first node in `targets`; null if none can be reached
 */
function travelToNearest(
  graph: TravelGraph,
  source: number,
  targets: Set<number>,
): { node: number; path: Point[] } | null {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const via: (TravelEdge | null)[] = new Array(n).fill(null);
  const prev = new Int32Array(n).fill(-1);
  dist[source] = 0;
  const heap: [number, number][] = [[0, source]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  while (heap.length > 0) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (targets.has(u)) {
      const parts: Point[][] = [];
      for (let v = u; v !== source; v = prev[v]) parts.push(via[v]!.path);
      return {
        node: u,
        path: [graph.nodes[source], ...parts.reverse().flat()],
      };
    }
    for (const edge of graph.edges[u]) {
      const next = d + edge.cost;
      if (next < dist[edge.to]) {
        dist[edge.to] = next;
        via[edge.to] = edge;
        prev[edge.to] = u;
        push([next, edge.to]);
      }
    }
  }
  return null;
}

export interface ConnectOptions {
  // Resample travel paths to this stitch length (sewn as they are without)
  travelStitch?: number;
  // Blocks may be sewn backwards (not for cross stitch: the top diagonal
  // would change direction)
  allowReverse?: boolean;
}

/**
 * Sew `blocks` (point lists) one after another: next is the block that is
 * cheapest to reach by travelling inside the region. Returns one run per
 * piece that could be connected; a block that cannot be reached starts a
 * new run (the caller jumps there), the nearest one first.
 */
export function connectBlocks(
  blocks: Point[][],
  graph: TravelGraph,
  start: Point | null,
  { travelStitch, allowReverse = true }: ConnectOptions = {},
): Point[][] {
  const remaining = blocks
    .filter((b) => b.length > 0)
    .map((points) => ({
      points,
      ends: [
        { node: hopNode(graph, points[0]), reversed: false },
        ...(allowReverse
          ? [
              {
                node: hopNode(graph, points[points.length - 1]),
                reversed: true,
              },
            ]
          : []),
      ],
    }));
  const runs: Point[][] = [];
  let position = start;
  let run: Point[] = [];

  while (remaining.length > 0) {
    let index = 0;
    let reversed = false;
    let travel: Point[] | null = null;

    const source = position ? hopNode(graph, position) : -1;
    if (source >= 0) {
      const targets = new Set<number>();
      for (const block of remaining) {
        for (const end of block.ends) if (end.node >= 0) targets.add(end.node);
      }
      const found = travelToNearest(graph, source, targets);
      if (found) {
        index = remaining.findIndex((b) =>
          b.ends.some((e) => e.node === found.node),
        );
        reversed = remaining[index].ends.find(
          (e) => e.node === found.node,
        )!.reversed;
        travel = found.path;
      }
    }
    if (!travel && position) {
      // Nothing reachable: jump to the nearest block end
      let best = Infinity;
      remaining.forEach((block, i) => {
        for (const end of block.ends) {
          const p = end.reversed
            ? block.points[block.points.length - 1]
            : block.points[0];
          const d = distance(p, position!);
          if (d < best) [best, index, reversed] = [d, i, end.reversed];
        }
      });
    }

    const [block] = remaining.splice(index, 1);
    const points = reversed ? [...block.points].reverse() : block.points;
    if (travel) {
      const path = [...travel, points[0]];
      run.push(...(travelStitch ? runAlongPath(path, travelStitch, 0) : path));
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
    run.push(...points);
    position = points[points.length - 1];
  }
  if (run.length > 0) runs.push(run);
  return runs;
}
