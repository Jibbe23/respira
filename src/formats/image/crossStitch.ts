/**
 * Cross stitch fill (image to embroidery): the image is split into square
 * cells, each cell gets the color most of its pixels have and is sewn as an
 * X. Coordinates in 0.1 mm units.
 */

import type { Point } from "./fillStitches";
import { nearestPaletteIndex, type RGBA } from "./traceImage";

export interface CrossCell {
  col: number;
  row: number;
  colorIndex: number; // palette index
  x: number; // top left corner (0.1 mm, pattern centered on the origin)
  y: number;
}

/** Palette index per pixel; -1 for transparent pixels */
function mapPixels(image: ImageData, palette: RGBA[]): Int16Array {
  const { data } = image;
  const indices = new Int16Array(image.width * image.height);
  for (let p = 0; p < indices.length; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) {
      indices[p] = -1;
      continue;
    }
    indices[p] = nearestPaletteIndex(
      palette,
      data[i],
      data[i + 1],
      data[i + 2],
    );
  }
  return indices;
}

/**
 * Cells to sew: the part of the image that is not background, scaled to
 * `width` and split into cells of `cellSize` (both 0.1 mm). Cells where
 * background or transparency is the most common color stay empty.
 */
export function crossStitchGrid(
  image: ImageData,
  palette: RGBA[],
  backgroundIndex: number | null,
  width: number,
  cellSize: number,
): CrossCell[] {
  const { width: w, height: h } = image;
  const indices = mapPixels(image, palette);
  const isEmpty = (index: number) => index < 0 || index === backgroundIndex;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isEmpty(indices[y * w + x])) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (minX > maxX) return [];

  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  // Whole cells that fit into the width; square cells in the image
  const cols = Math.max(1, Math.floor(width / cellSize));
  const cellPx = contentWidth / cols;
  const rows = Math.max(1, Math.round(contentHeight / cellPx));
  const originX = (-cols * cellSize) / 2;
  const originY = (-rows * cellSize) / 2;

  const cells: CrossCell[] = [];
  const counts = new Map<number, number>();
  for (let row = 0; row < rows; row++) {
    const y0 = minY + Math.floor(row * cellPx);
    const y1 = Math.min(maxY + 1, minY + Math.floor((row + 1) * cellPx));
    for (let col = 0; col < cols; col++) {
      const x0 = minX + Math.floor(col * cellPx);
      const x1 = Math.min(maxX + 1, minX + Math.floor((col + 1) * cellPx));
      counts.clear();
      for (let y = y0; y < Math.max(y1, y0 + 1); y++) {
        for (let x = x0; x < Math.max(x1, x0 + 1); x++) {
          const index = indices[y * w + x];
          counts.set(index, (counts.get(index) ?? 0) + 1);
        }
      }
      let colorIndex = -1;
      let most = 0;
      for (const [index, count] of counts) {
        if (count > most) {
          most = count;
          colorIndex = index;
        }
      }
      if (isEmpty(colorIndex)) continue;
      cells.push({
        col,
        row,
        colorIndex,
        x: originX + col * cellSize,
        y: originY + row * cellSize,
      });
    }
  }
  return cells;
}

/**
 * Stitch runs for the cells of one thread: every row of neighbouring cells
 * is sewn as "/" from left to right and "\" back from right to left, with the
 * vertical cell edges as connections. Double sews both passes twice, triple
 * sews every diagonal forward, back and forward again.
 */
export function crossStitchRuns(
  cells: CrossCell[],
  cellSize: number,
  repeats: 1 | 2 | 3,
): Point[][] {
  const sorted = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);
  const runs: CrossCell[][] = [];
  for (const cell of sorted) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (last && last.row === cell.row && last.col === cell.col - 1) {
      run.push(cell);
    } else {
      runs.push([cell]);
    }
  }

  const diagonal = (points: Point[], from: Point, to: Point) => {
    if (repeats === 3) points.push(to, from, to);
    else points.push(to);
  };

  return runs.map((run) => {
    const s = cellSize;
    const first = run[0];
    const points: Point[] = [{ x: first.x, y: first.y + s }];
    const passes = repeats === 2 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      // "/" left to right: bottom left to top right, then down the right edge
      for (const c of run) {
        diagonal(points, { x: c.x, y: c.y + s }, { x: c.x + s, y: c.y });
        points.push({ x: c.x + s, y: c.y + s });
      }
      // "\" right to left: bottom right to top left, then down the left edge
      for (let i = run.length - 1; i >= 0; i--) {
        const c = run[i];
        diagonal(points, { x: c.x + s, y: c.y + s }, { x: c.x, y: c.y });
        points.push({ x: c.x, y: c.y + s });
      }
    }
    return points;
  });
}
