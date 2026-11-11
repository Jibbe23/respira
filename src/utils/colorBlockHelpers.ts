/**
 * Color Block Helpers
 *
 * Utility functions for calculating color block information from pattern data.
 * Extracted from ProgressMonitor component for better testability and reusability.
 */

import type { PesPatternData } from "../formats/import/client";
import type { ColorBlock } from "../components/ProgressMonitor/types";

/**
 * Calculate color blocks from decoded PEN pattern data
 *
 * Transforms PEN color blocks into enriched ColorBlock objects with thread metadata.
 * Returns an empty array if pattern or penStitches data is unavailable.
 *
 * @param displayPattern - The PES pattern data containing penStitches and threads
 * @returns Array of ColorBlock objects with thread information and stitch counts
 */
export function calculateColorBlocks(
  displayPattern: PesPatternData | null,
): ColorBlock[] {
  if (!displayPattern || !displayPattern.penStitches) return [];

  const blocks: ColorBlock[] = [];

  // Use the pre-computed color blocks from decoded PEN data
  for (const penBlock of displayPattern.penStitches.colorBlocks) {
    const thread = displayPattern.threads[penBlock.colorIndex];
    blocks.push({
      colorIndex: penBlock.colorIndex,
      threadHex: thread?.hex || "#000000",
      threadCatalogNumber: thread?.catalogNumber ?? null,
      threadBrand: thread?.brand ?? null,
      threadDescription: thread?.description ?? null,
      threadChart: thread?.chart ?? null,
      startStitch: penBlock.startStitchIndex,
      endStitch: penBlock.endStitchIndex,
      stitchCount: penBlock.endStitchIndex - penBlock.startStitchIndex,
    });
  }

  return blocks;
}

/**
 * Find the index of the color block containing a specific stitch
 *
 * @param colorBlocks - Array of color blocks to search
 * @param currentStitch - The stitch index to find
 * @returns The index of the containing block, or -1 if not found
 */
export function findCurrentBlockIndex(
  colorBlocks: ColorBlock[],
  currentStitch: number,
): number {
  return colorBlocks.findIndex(
    (block) =>
      currentStitch >= block.startStitch && currentStitch < block.endStitch,
  );
}

export type MachineStop =
  | { kind: "trim" }
  | { kind: "color"; nextBlock: ColorBlock | null };

/**
 * What the machine waits for when it reports a color change: a real thread
 * change, or a pause after a cut (added by `stopAfterTrim`). The machine
 * reports both the same way, so take the stop nearest to its stitch.
 */
export function classifyMachineStop(
  colorBlocks: ColorBlock[],
  currentStitch: number,
  trimStops: readonly number[] = [],
): MachineStop {
  // A color block ends at its COLOR_END stitch (not the last block)
  const stops = [
    ...colorBlocks
      .slice(0, -1)
      .map((block) => ({ at: block.endStitch, kind: "color" as const })),
    ...trimStops.map((at) => ({ at, kind: "trim" as const })),
  ];
  const distance = (at: number) => Math.abs(at - currentStitch);
  const stop = stops.reduce<(typeof stops)[number] | null>(
    (best, s) => (!best || distance(s.at) < distance(best.at) ? s : best),
    null,
  );

  if (stop?.kind === "trim") return { kind: "trim" };
  const nextBlock = stop
    ? (colorBlocks.find((block) => block.startStitch > stop.at) ?? null)
    : null;
  return { kind: "color", nextBlock };
}
