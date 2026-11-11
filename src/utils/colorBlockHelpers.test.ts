import { describe, it, expect } from "vitest";
import {
  calculateColorBlocks,
  classifyMachineStop,
  findCurrentBlockIndex,
} from "./colorBlockHelpers";
import type { ColorBlock } from "../components/ProgressMonitor/types";
import type { PesPatternData } from "../formats/import/client";

describe("colorBlockHelpers", () => {
  describe("calculateColorBlocks", () => {
    it("should return empty array when displayPattern is null", () => {
      const result = calculateColorBlocks(null);
      expect(result).toEqual([]);
    });

    it("should return empty array when penStitches is undefined", () => {
      const pattern = {
        penStitches: undefined,
      } as unknown as PesPatternData;

      const result = calculateColorBlocks(pattern);
      expect(result).toEqual([]);
    });

    it("should calculate color blocks from PEN data", () => {
      const pattern: Partial<PesPatternData> = {
        threads: [
          {
            color: 1,
            hex: "#FF0000",
            brand: "Brother",
            catalogNumber: "001",
            description: "Red",
            chart: "A",
          },
          {
            color: 2,
            hex: "#00FF00",
            brand: "Brother",
            catalogNumber: "002",
            description: "Green",
            chart: "B",
          },
        ],
        penStitches: {
          colorBlocks: [
            {
              startStitchIndex: 0,
              endStitchIndex: 100,
              colorIndex: 0,
              startStitch: 0,
              endStitch: 100,
            },
            {
              startStitchIndex: 100,
              endStitchIndex: 250,
              colorIndex: 1,
              startStitch: 100,
              endStitch: 250,
            },
          ],
          stitches: [],
          bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
        },
      };

      const result = calculateColorBlocks(pattern as PesPatternData);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        colorIndex: 0,
        threadHex: "#FF0000",
        threadCatalogNumber: "001",
        threadBrand: "Brother",
        threadDescription: "Red",
        threadChart: "A",
        startStitch: 0,
        endStitch: 100,
        stitchCount: 100,
      });
      expect(result[1]).toEqual({
        colorIndex: 1,
        threadHex: "#00FF00",
        threadCatalogNumber: "002",
        threadBrand: "Brother",
        threadDescription: "Green",
        threadChart: "B",
        startStitch: 100,
        endStitch: 250,
        stitchCount: 150,
      });
    });

    it("should use fallback values when thread data is missing", () => {
      const pattern: Partial<PesPatternData> = {
        threads: [],
        penStitches: {
          colorBlocks: [
            {
              startStitchIndex: 0,
              endStitchIndex: 50,
              colorIndex: 0,
              startStitch: 0,
              endStitch: 50,
            },
          ],
          stitches: [],
          bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
        },
      };

      const result = calculateColorBlocks(pattern as PesPatternData);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        colorIndex: 0,
        threadHex: "#000000", // Fallback for missing thread
        threadCatalogNumber: null,
        threadBrand: null,
        threadDescription: null,
        threadChart: null,
        startStitch: 0,
        endStitch: 50,
        stitchCount: 50,
      });
    });

    it("should handle null thread metadata fields", () => {
      const pattern: Partial<PesPatternData> = {
        threads: [
          {
            color: 1,
            hex: "#0000FF",
            brand: null,
            catalogNumber: null,
            description: null,
            chart: null,
          },
        ],
        penStitches: {
          colorBlocks: [
            {
              startStitchIndex: 0,
              endStitchIndex: 30,
              colorIndex: 0,
              startStitch: 0,
              endStitch: 30,
            },
          ],
          stitches: [],
          bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
        },
      };

      const result = calculateColorBlocks(pattern as PesPatternData);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        colorIndex: 0,
        threadHex: "#0000FF",
        threadCatalogNumber: null,
        threadBrand: null,
        threadDescription: null,
        threadChart: null,
        startStitch: 0,
        endStitch: 30,
        stitchCount: 30,
      });
    });
  });

  describe("findCurrentBlockIndex", () => {
    const colorBlocks = [
      {
        colorIndex: 0,
        threadHex: "#FF0000",
        threadCatalogNumber: "001",
        threadBrand: "Brother",
        threadDescription: "Red",
        threadChart: "A",
        startStitch: 0,
        endStitch: 100,
        stitchCount: 100,
      },
      {
        colorIndex: 1,
        threadHex: "#00FF00",
        threadCatalogNumber: "002",
        threadBrand: "Brother",
        threadDescription: "Green",
        threadChart: "B",
        startStitch: 100,
        endStitch: 250,
        stitchCount: 150,
      },
      {
        colorIndex: 2,
        threadHex: "#0000FF",
        threadCatalogNumber: "003",
        threadBrand: "Brother",
        threadDescription: "Blue",
        threadChart: "C",
        startStitch: 250,
        endStitch: 400,
        stitchCount: 150,
      },
    ];

    it("should find block containing stitch at start boundary", () => {
      expect(findCurrentBlockIndex(colorBlocks, 0)).toBe(0);
      expect(findCurrentBlockIndex(colorBlocks, 100)).toBe(1);
      expect(findCurrentBlockIndex(colorBlocks, 250)).toBe(2);
    });

    it("should find block containing stitch in middle", () => {
      expect(findCurrentBlockIndex(colorBlocks, 50)).toBe(0);
      expect(findCurrentBlockIndex(colorBlocks, 150)).toBe(1);
      expect(findCurrentBlockIndex(colorBlocks, 300)).toBe(2);
    });

    it("should return -1 for stitch before first block", () => {
      expect(findCurrentBlockIndex(colorBlocks, -1)).toBe(-1);
    });

    it("should return -1 for stitch at or after last block end", () => {
      expect(findCurrentBlockIndex(colorBlocks, 400)).toBe(-1);
      expect(findCurrentBlockIndex(colorBlocks, 500)).toBe(-1);
    });

    it("should return -1 for empty color blocks array", () => {
      expect(findCurrentBlockIndex([], 50)).toBe(-1);
    });

    it("should find block with single color block", () => {
      const singleBlock = [colorBlocks[0]];
      expect(findCurrentBlockIndex(singleBlock, 0)).toBe(0);
      expect(findCurrentBlockIndex(singleBlock, 50)).toBe(0);
      expect(findCurrentBlockIndex(singleBlock, 99)).toBe(0);
      expect(findCurrentBlockIndex(singleBlock, 100)).toBe(-1);
    });
  });

  describe("classifyMachineStop", () => {
    const block = (colorIndex: number, start: number, end: number) =>
      ({
        colorIndex,
        threadHex: "#000000",
        startStitch: start,
        endStitch: end,
        stitchCount: end - start,
        threadCatalogNumber: null,
        threadBrand: null,
        threadDescription: null,
        threadChart: null,
      }) satisfies ColorBlock;
    const blocks = [block(0, 0, 100), block(1, 101, 200), block(2, 201, 300)];

    it("names the next thread at a color change", () => {
      expect(classifyMachineStop(blocks, 100, [50])).toEqual({
        kind: "color",
        nextBlock: blocks[1],
      });
      expect(classifyMachineStop(blocks, 202, [50])).toEqual({
        kind: "color",
        nextBlock: blocks[2],
      });
    });

    it("takes the stop reached, not the nearest one ahead", () => {
      // Paused at the cut at 100, a color change follows at 110
      const close = [block(0, 0, 110), block(1, 111, 200)];
      expect(classifyMachineStop(close, 106, [100])).toEqual({ kind: "trim" });
      expect(classifyMachineStop(close, 110, [100])).toEqual({
        kind: "color",
        nextBlock: close[1],
      });
    });

    it("recognises a pause after a cut", () => {
      expect(classifyMachineStop(blocks, 51, [50, 150])).toEqual({
        kind: "trim",
      });
      expect(classifyMachineStop(blocks, 150, [50, 150])).toEqual({
        kind: "trim",
      });
    });

    it("treats a stop as a color change without known cuts", () => {
      expect(classifyMachineStop(blocks, 102)).toEqual({
        kind: "color",
        nextBlock: blocks[1],
      });
    });
  });
});
