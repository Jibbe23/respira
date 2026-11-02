import type { PesPatternData } from "../formats/import/pesImporter";
import { encodeStitchesToPen } from "../formats/pen/encoder";
import { decodePenData } from "../formats/pen/decoder";
import {
  calculatePatternCenter,
  calculateBoundsFromDecodedStitches,
} from "../components/PatternCanvas/patternCanvasHelpers";
import { normalizeAngle, rotatePoint } from "./rotationUtils";

/** Allowed range for uniform pattern scaling (1 = original size) */
export const MIN_PATTERN_SCALE = 0.25;
export const MAX_PATTERN_SCALE = 3;

/**
 * Scaling outside this range changes stitch density noticeably
 * (stitches get too dense or too long), so the UI shows a hint.
 */
export const SAFE_SCALE_RANGE = { min: 0.8, max: 1.2 };

/**
 * Round an offset to 1/1000 of a 0.1 mm unit, so float noise does not show up
 * as "-0.0mm" ("|| 0" turns -0 into 0)
 */
export const roundOffset = (value: number) =>
  Math.round(value * 1000) / 1000 || 0;

export type MirrorAxis = "horizontal" | "vertical";

/**
 * Stitch length limits for the stitch count adjustment (0.1 mm units).
 * Enlarged stitches are split once they are longer than their original
 * length and longer than SPLIT_STITCH_LENGTH; shrunk stitches shorter than
 * MIN_STITCH_LENGTH are merged into the next one.
 */
export const SPLIT_STITCH_LENGTH = 30;
export const MIN_STITCH_LENGTH = 3;

export function clampPatternScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_PATTERN_SCALE, Math.max(MIN_PATTERN_SCALE, scale));
}

/**
 * Scale stitches uniformly around the pattern center and optionally mirror
 * them horizontally (in the pattern's own coordinate system).
 */
export function transformStitchesScaleMirror(
  stitches: number[][],
  scale: number,
  mirrored: boolean,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): number[][] {
  if (scale === 1 && !mirrored) return stitches;

  const center = calculatePatternCenter(bounds);
  const scaleX = mirrored ? -scale : scale;

  return stitches.map(([x, y, cmd, colorIndex]) => [
    Math.round(center.x + (x - center.x) * scaleX),
    Math.round(center.y + (y - center.y) * scale),
    cmd,
    colorIndex,
  ]);
}

/**
 * Adapt the stitch count to a scaled pattern so stitch lengths stay close to
 * the original: enlarged stitches are split into several shorter ones,
 * stitches that became too short when shrinking are dropped.
 *
 * Only plain stitches inside one color are touched; jumps, trims, color
 * changes and the end points of a stitch run stay as they are. Fill row
 * spacing and satin density cannot be recalculated without the original
 * design objects, so they still scale with the pattern.
 *
 * @param original - stitches before scaling (for the original lengths)
 * @param scaled - the same stitches after scaling (same order and length)
 */
export function adjustStitchCount(
  original: number[][],
  scaled: number[][],
  scale: number,
): number[][] {
  if (scale === 1 || scaled.length < 2) return scaled;

  // A plain stitch that continues a run of the same color (the first stitch
  // after a jump is the tie-in and stays as it is)
  const isRunStitch = (i: number) =>
    i > 0 &&
    scaled[i][2] === 0 &&
    scaled[i - 1][2] === 0 &&
    scaled[i][3] === scaled[i - 1][3];

  const result: number[][] = [scaled[0]];

  for (let i = 1; i < scaled.length; i++) {
    const [x, y, cmd, color] = scaled[i];
    const [prevX, prevY] = result[result.length - 1];
    const length = Math.hypot(x - prevX, y - prevY);

    if (scale > 1 && isRunStitch(i)) {
      const originalLength = Math.hypot(
        original[i][0] - original[i - 1][0],
        original[i][1] - original[i - 1][1],
      );
      const maxLength = Math.max(originalLength, SPLIT_STITCH_LENGTH);
      const parts = Math.ceil(length / maxLength);
      for (let part = 1; part < parts; part++) {
        result.push([
          Math.round(prevX + ((x - prevX) * part) / parts),
          Math.round(prevY + ((y - prevY) * part) / parts),
          0,
          color,
        ]);
      }
    } else if (
      scale < 1 &&
      length < MIN_STITCH_LENGTH &&
      isRunStitch(i) &&
      i + 1 < scaled.length &&
      isRunStitch(i + 1)
    ) {
      // Merged into the next stitch, which then starts from the last kept point
      continue;
    }

    result.push([x, y, cmd, color]);
  }

  return result;
}

/**
 * Build the editable pattern from the original file data with scale and
 * mirroring baked into the stitches. Rotation stays a separate parameter
 * (applied at upload time), so the rest of the app keeps working unchanged.
 */
export function applyPatternGeometry(
  source: PesPatternData,
  scale: number,
  mirrored: boolean,
): PesPatternData {
  if (scale === 1 && !mirrored) return source;

  const stitches = adjustStitchCount(
    source.stitches,
    transformStitchesScaleMirror(
      source.stitches,
      scale,
      mirrored,
      source.bounds,
    ),
    scale,
  );

  // Encode to PEN (rounds coordinates) and decode again, like the rotation upload
  const penData = new Uint8Array(encodeStitchesToPen(stitches).penBytes);
  const penStitches = decodePenData(penData);

  return {
    ...source,
    stitches,
    // Same meaning as the importer's count, plus the stitches added/removed
    stitchCount: source.stitchCount + stitches.length - source.stitches.length,
    penData,
    penStitches,
    bounds: calculateBoundsFromDecodedStitches(penStitches),
  };
}

/**
 * Rotation to use after mirroring a pattern that is displayed with `rotation`,
 * so the result looks mirrored along the screen axis.
 *
 * The pattern is shown as R(rotation)·P. Mirroring on screen gives
 * H·R(r)·P = R(-r)·H·P for the horizontal axis and
 * V·R(r)·P = R(180 - r)·H·P for the vertical axis (V = R(180)·H).
 * H is baked into the stitches, so only the rotation has to change.
 */
export function rotationAfterMirror(
  rotation: number,
  axis: MirrorAxis,
): number {
  return normalizeAngle(axis === "horizontal" ? -rotation : 180 - rotation);
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

/**
 * Pattern offset that keeps `pivot` (in pattern coordinates) at the same
 * screen position when bounds and rotation change.
 *
 * The canvas draws a pattern point p at offset + R(rotation)·(p - center),
 * with center = center of the bounds. Scale/mirror pivot around the source
 * center, but the PEN lock stitches shift the bounds center a little, so
 * without this the pattern would jump by a few tenths of a millimetre.
 */
export function offsetKeepingPivot(
  offset: { x: number; y: number },
  pivot: { x: number; y: number },
  before: { bounds: Bounds; rotation: number },
  after: { bounds: Bounds; rotation: number },
): { x: number; y: number } {
  const screenDelta = (bounds: Bounds, rotation: number) => {
    const center = calculatePatternCenter(bounds);
    return rotatePoint(pivot.x - center.x, pivot.y - center.y, 0, 0, rotation);
  };
  const b = screenDelta(before.bounds, before.rotation);
  const a = screenDelta(after.bounds, after.rotation);
  return {
    x: roundOffset(offset.x + b.x - a.x),
    y: roundOffset(offset.y + b.y - a.y),
  };
}
