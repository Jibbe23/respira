import { describe, it, expect } from "vitest";
import {
  transformStitchesScaleMirror,
  adjustStitchCount,
  applyPatternGeometry,
  clampPatternScale,
  rotationAfterMirror,
  offsetKeepingPivot,
  MIN_PATTERN_SCALE,
  MAX_PATTERN_SCALE,
} from "./patternGeometry";
import { rotatePoint } from "./rotationUtils";
import { MOVE } from "../formats/import/constants";
import { encodeStitchesToPen } from "../formats/pen/encoder";
import { decodePenData } from "../formats/pen/decoder";
import { calculateBoundsFromDecodedStitches } from "../components/PatternCanvas/patternCanvasHelpers";
import type { PesPatternData } from "../formats/import/pesImporter";

const bounds = { minX: 0, maxX: 200, minY: 0, maxY: 100 };

// Square outline 0..200 x 0..100 (0.1 mm units), one color
const createPattern = (): PesPatternData => {
  const stitches = [
    [0, 0, 0, 0],
    [200, 0, 0, 0],
    [200, 100, 0, 0],
    [0, 100, 0, 0],
    [0, 0, 0, 0],
  ];
  const penData = new Uint8Array(encodeStitchesToPen(stitches).penBytes);
  const penStitches = decodePenData(penData);
  return {
    stitches,
    threads: [],
    uniqueColors: [],
    penData,
    penStitches,
    colorCount: 1,
    stitchCount: stitches.length,
    bounds: calculateBoundsFromDecodedStitches(penStitches),
  };
};

describe("patternGeometry", () => {
  describe("transformStitchesScaleMirror", () => {
    it("returns the same array without scale or mirror", () => {
      const stitches = [[10, 20, 0, 0]];
      expect(transformStitchesScaleMirror(stitches, 1, false, bounds)).toBe(
        stitches,
      );
    });

    it("scales around the pattern center", () => {
      const result = transformStitchesScaleMirror(
        [
          [0, 0, 0, 1],
          [200, 100, 0x10, 1],
        ],
        2,
        false,
        bounds,
      );
      // Center (100, 50) stays, corners move outwards; cmd and color are kept
      expect(result).toEqual([
        [-100, -50, 0, 1],
        [300, 150, 0x10, 1],
      ]);
    });

    it("mirrors horizontally around the center", () => {
      const result = transformStitchesScaleMirror(
        [[20, 10, 0, 0]],
        1,
        true,
        bounds,
      );
      expect(result).toEqual([[180, 10, 0, 0]]);
    });
  });

  describe("adjustStitchCount", () => {
    it("keeps the stitches at scale 1", () => {
      const stitches = [
        [0, 0, 0, 0],
        [40, 0, 0, 0],
      ];
      expect(adjustStitchCount(stitches, stitches, 1)).toBe(stitches);
    });

    it("splits enlarged stitches back to their original length", () => {
      const original = [
        [0, 0, 0, 0],
        [40, 0, 0, 0], // 4 mm
      ];
      const scaled = [
        [0, 0, 0, 0],
        [120, 0, 0, 0], // 12 mm at 300%
      ];
      expect(adjustStitchCount(original, scaled, 3)).toEqual([
        [0, 0, 0, 0],
        [40, 0, 0, 0],
        [80, 0, 0, 0],
        [120, 0, 0, 0],
      ]);
    });

    it("does not split short stitches below the split length", () => {
      const original = [
        [0, 0, 0, 0],
        [10, 0, 0, 0],
      ];
      const scaled = [
        [0, 0, 0, 0],
        [25, 0, 0, 0], // 2.5 mm < SPLIT_STITCH_LENGTH
      ];
      expect(adjustStitchCount(original, scaled, 2.5)).toEqual(scaled);
    });

    it("does not split jumps or the first stitch of a new color", () => {
      const original = [
        [0, 0, 0, 0],
        [100, 0, MOVE, 0],
        [200, 0, 0, 1],
      ];
      const scaled = original.map(([x, y, c, i]) => [x * 2, y, c, i]);
      expect(adjustStitchCount(original, scaled, 2)).toEqual(scaled);
    });

    it("keeps the tie-in stitch after a jump", () => {
      const original = [
        [0, 0, 0, 0],
        [100, 0, MOVE, 0],
        [140, 0, 0, 0],
      ];
      const scaled = original.map(([x, y, c, i]) => [x * 3, y, c, i]);
      expect(adjustStitchCount(original, scaled, 3)).toEqual(scaled);
    });

    it("drops stitches that got too short, but keeps the run end points", () => {
      const scaled = [
        [0, 0, 0, 0],
        [1, 0, 0, 0], // too short, dropped
        [2, 0, 0, 0], // too short (2 from last kept), dropped
        [10, 0, 0, 0],
        [11, 0, 0, 0], // too short, but last stitch: kept
      ];
      expect(adjustStitchCount(scaled, scaled, 0.5)).toEqual([
        [0, 0, 0, 0],
        [10, 0, 0, 0],
        [11, 0, 0, 0],
      ]);
    });
  });

  describe("applyPatternGeometry", () => {
    it("updates the stitch count when stitches are split", () => {
      const source = createPattern();
      const result = applyPatternGeometry(source, 2, false);
      // Every edge doubles in length and is split in two
      expect(result.stitches.length).toBe(9);
      expect(result.stitchCount).toBe(9);
    });

    it("returns the source unchanged at scale 1 without mirror", () => {
      const source = createPattern();
      expect(applyPatternGeometry(source, 1, false)).toBe(source);
    });

    it("scales bounds and PEN data and keeps the center", () => {
      const source = createPattern();
      const result = applyPatternGeometry(source, 0.5, false);
      const width = (b: PesPatternData["bounds"]) => b.maxX - b.minX;
      const centerX = (b: PesPatternData["bounds"]) => (b.minX + b.maxX) / 2;

      // The PEN encoder adds lock stitches of a few units, so allow a small tolerance
      expect(
        Math.abs(width(result.bounds) - width(source.bounds) / 2),
      ).toBeLessThanOrEqual(3);
      expect(
        Math.abs(centerX(result.bounds) - centerX(source.bounds)),
      ).toBeLessThanOrEqual(3);
      expect(result.penData).not.toBe(source.penData);
      // Bounds and decoded stitches come from the same re-encoded data
      expect(calculateBoundsFromDecodedStitches(result.penStitches)).toEqual(
        result.bounds,
      );
    });

    it("mirrors the stitches horizontally", () => {
      const source = createPattern();
      const result = applyPatternGeometry(source, 1, true);
      const [x, y] = result.stitches[1];
      // (200, 0) lands near the left edge (source bounds include lock stitches)
      expect(Math.abs(x)).toBeLessThanOrEqual(3);
      expect(y).toBe(0);
    });
  });

  describe("clampPatternScale", () => {
    it("limits the scale to the allowed range", () => {
      expect(clampPatternScale(0.01)).toBe(MIN_PATTERN_SCALE);
      expect(clampPatternScale(10)).toBe(MAX_PATTERN_SCALE);
      expect(clampPatternScale(1.5)).toBe(1.5);
      expect(clampPatternScale(Number.NaN)).toBe(1);
    });
  });

  describe("rotationAfterMirror", () => {
    // Screen position of a local point for a pattern shown with `rotation`
    const screen = (
      x: number,
      y: number,
      rotation: number,
      mirrored: boolean,
    ) => rotatePoint(mirrored ? -x : x, y, 0, 0, rotation);

    it.each([0, 30, 90, 135, 270])(
      "mirrors along the screen axes at rotation %i°",
      (rotation) => {
        const before = screen(30, 10, rotation, false);

        const afterH = screen(
          30,
          10,
          rotationAfterMirror(rotation, "horizontal"),
          true,
        );
        expect(afterH.x).toBeCloseTo(-before.x, 6);
        expect(afterH.y).toBeCloseTo(before.y, 6);

        const afterV = screen(
          30,
          10,
          rotationAfterMirror(rotation, "vertical"),
          true,
        );
        expect(afterV.x).toBeCloseTo(before.x, 6);
        expect(afterV.y).toBeCloseTo(-before.y, 6);
      },
    );

    it("returns angles in the 0-360 range", () => {
      expect(rotationAfterMirror(90, "horizontal")).toBe(270);
      expect(rotationAfterMirror(270, "vertical")).toBe(270);
      expect(rotationAfterMirror(0, "vertical")).toBe(180);
    });
  });

  describe("offsetKeepingPivot", () => {
    // Screen position of a pattern point, as drawn by the canvas group
    const screen = (
      p: { x: number; y: number },
      offset: { x: number; y: number },
      b: typeof bounds,
      rotation: number,
    ) => {
      const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const r = rotatePoint(p.x - c.x, p.y - c.y, 0, 0, rotation);
      return { x: offset.x + r.x, y: offset.y + r.y };
    };

    it("keeps the pivot on screen when bounds and rotation change", () => {
      const pivot = { x: 100, y: 50 };
      const before = { bounds, rotation: 30 };
      const after = {
        bounds: { minX: -2, maxX: 205, minY: 1, maxY: 98 },
        rotation: 300,
      };
      const offset = { x: 40, y: -10 };

      const newOffset = offsetKeepingPivot(offset, pivot, before, after);
      const was = screen(pivot, offset, before.bounds, before.rotation);
      const is = screen(pivot, newOffset, after.bounds, after.rotation);
      // The offset is rounded to 1/1000 unit
      expect(is.x).toBeCloseTo(was.x, 2);
      expect(is.y).toBeCloseTo(was.y, 2);
    });
  });
});
