import { describe, it, expect } from "vitest";
import { advancePlayback } from "./useStitchPlayback";

describe("advancePlayback", () => {
  it("advances by speed and elapsed time", () => {
    expect(advancePlayback(10, 100, 500, 1000)).toBe(60);
  });

  it("keeps fractional progress for slow speeds", () => {
    expect(advancePlayback(0, 25, 16, 1000)).toBeCloseTo(0.4, 6);
  });

  it("stops at the last stitch", () => {
    expect(advancePlayback(990, 2500, 1000, 1000)).toBe(1000);
  });
});
