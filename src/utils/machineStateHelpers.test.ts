import { describe, it, expect } from "vitest";
import { canSetStitchPosition } from "./machineStateHelpers";
import { MachineStatus } from "../types/machine";

describe("canSetStitchPosition", () => {
  it.each([
    MachineStatus.PAUSE,
    MachineStatus.STOP,
    MachineStatus.SEWING_INTERRUPTION,
    MachineStatus.SEWING_WAIT,
  ])("allows a new stitch position in status %s", (status) => {
    expect(canSetStitchPosition(status)).toBe(true);
  });

  it.each([
    MachineStatus.SEWING,
    MachineStatus.IDLE,
    MachineStatus.SEWING_COMPLETE,
    MachineStatus.COLOR_CHANGE_WAIT,
  ])("does not allow it in status %s", (status) => {
    expect(canSetStitchPosition(status)).toBe(false);
  });
});
