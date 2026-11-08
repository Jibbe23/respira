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
  fillRowCrossings,
  runAlongPath,
  type Point,
  type Ring,
  type RingPosition,
} from "./fillStitches";

/** Travel along a fill row shows more than along the outline (sewn over) */
const ROW_TRAVEL_COST = 2;

export interface TravelEdge {
  to: number;
  cost: number;
  path: Point[]; // points after the start node, ending with node `to`
}

export interface TravelGraph {
  nodes: Point[];
  edges: TravelEdge[][];
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(start: Point, path: Point[]): number {
  let length = 0;
  let prev = start;
  for (const p of path) {
    length += distance(prev, p);
    prev = p;
  }
  return length;
}

/**
 * Graph of the points where fill rows meet the outline: neighbouring points
 * on a ring are connected along the ring, the two ends of a row by the row
 */
export function createTravelGraph(
  rings: Ring[],
  angle: number,
  spacing: number,
): TravelGraph {
  const nodes: Point[] = [];
  const edges: TravelEdge[][] = [];
  const perRing = rings.map(() => [] as { node: number; at: RingPosition }[]);

  const addNode = (at: RingPosition) => {
    const ring = rings[at.ring];
    const a = ring[at.edge];
    const b = ring[(at.edge + 1) % ring.length];
    nodes.push({ x: a.x + (b.x - a.x) * at.t, y: a.y + (b.y - a.y) * at.t });
    edges.push([]);
    perRing[at.ring].push({ node: nodes.length - 1, at });
    return nodes.length - 1;
  };
  const connect = (from: number, to: number, path: Point[]) => {
    edges[from].push({ to, cost: pathLength(nodes[from], path), path });
  };

  for (const [start, end] of fillRowCrossings(rings, angle, spacing)) {
    const a = addNode(start);
    const b = addNode(end);
    const cost = distance(nodes[a], nodes[b]) * ROW_TRAVEL_COST;
    edges[a].push({ to: b, cost, path: [nodes[b]] });
    edges[b].push({ to: a, cost, path: [nodes[a]] });
  }

  // Along each ring: from every crossing to the next one in ring order
  perRing.forEach((list, r) => {
    if (list.length < 2) return;
    const ring = rings[r];
    list.sort((p, q) => p.at.edge + p.at.t - (q.at.edge + q.at.t));
    list.forEach((from, i) => {
      const to = list[(i + 1) % list.length];
      let count = (to.at.edge - from.at.edge + ring.length) % ring.length;
      if (count === 0 && to.at.t < from.at.t) count = ring.length;
      const vertices: Point[] = [];
      for (let k = 1; k <= count; k++) {
        vertices.push(ring[(from.at.edge + k) % ring.length]);
      }
      connect(from.node, to.node, [...vertices, nodes[to.node]]);
      connect(to.node, from.node, [...vertices.reverse(), nodes[from.node]]);
    });
  });
  return { nodes, edges };
}

function nearestNode(graph: TravelGraph, p: Point): number {
  let best = -1;
  let bestDistance = Infinity;
  graph.nodes.forEach((node, i) => {
    const d = distance(node, p);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

/** Cheapest travel from `source` to every node (Dijkstra, binary heap) */
function shortestPaths(graph: TravelGraph, source: number) {
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

  return {
    dist,
    /** Points after the source node up to node `to` */
    pathTo(to: number): Point[] {
      const parts: Point[][] = [];
      for (let v = to; v !== source; v = prev[v]) parts.push(via[v]!.path);
      return parts.reverse().flat();
    },
  };
}

/**
 * Sew `blocks` (point lists) one after another, picking the next block, in
 * either direction, that is cheapest to reach and travelling to it inside
 * the region. Travel paths are resampled to `travelStitch`, or sewn as they
 * are without it. Returns one run per piece that could be connected; blocks
 * that cannot be reached start a new run (the caller jumps there).
 */
export function connectBlocks(
  blocks: Point[][],
  graph: TravelGraph,
  start: Point | null,
  travelStitch?: number,
): Point[][] {
  const remaining = blocks
    .filter((b) => b.length > 0)
    .map((points) => ({
      points,
      first: nearestNode(graph, points[0]),
      last: nearestNode(graph, points[points.length - 1]),
    }));
  const runs: Point[][] = [];
  let position = start;
  let run: Point[] = [];

  while (remaining.length > 0) {
    let index = 0;
    let reversed = false;
    let cost = Infinity;
    let travel: Point[] = [];
    const source = position ? nearestNode(graph, position) : -1;
    if (position && source >= 0) {
      const paths = shortestPaths(graph, source);
      const costTo = (node: number, p: Point) =>
        node < 0 ? Infinity : paths.dist[node] + distance(graph.nodes[node], p);
      remaining.forEach((block, i) => {
        const forward = costTo(block.first, block.points[0]);
        const end = block.points[block.points.length - 1];
        const backward = costTo(block.last, end);
        if (forward < cost) [cost, index, reversed] = [forward, i, false];
        if (backward < cost) [cost, index, reversed] = [backward, i, true];
      });
      if (cost < Infinity) {
        const block = remaining[index];
        const target = reversed ? block.last : block.first;
        travel = [graph.nodes[source], ...paths.pathTo(target)];
      }
    }
    const [block] = remaining.splice(index, 1);
    const points = reversed ? [...block.points].reverse() : block.points;

    if (cost < Infinity) {
      const path = [...travel, points[0]];
      run.push(...(travelStitch ? runAlongPath(path, travelStitch) : path));
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
