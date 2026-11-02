import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { PesPatternData } from "../formats/import/pesImporter";
import { onPatternDeleted } from "./storeEvents";
import { calculatePatternCenter } from "../components/PatternCanvas/patternCanvasHelpers";
import { calculateRotatedBounds, normalizeAngle } from "../utils/rotationUtils";
import {
  applyPatternGeometry,
  clampPatternScale,
  offsetKeepingPivot,
  rotationAfterMirror,
  type MirrorAxis,
} from "../utils/patternGeometry";

// Conditional logging for development only
const isDev = import.meta.env.DEV;

interface PatternState {
  // Pattern as loaded from the file (before scale/mirror)
  sourcePesData: PesPatternData | null;
  patternScale: number; // uniform scale factor (1 = original size)
  patternMirrored: boolean; // mirrored horizontally in pattern coordinates

  // Original pattern (pre-upload), scale and mirroring baked in
  pesData: PesPatternData | null;
  currentFileName: string;
  patternOffset: { x: number; y: number };
  patternRotation: number; // rotation in degrees (0-360)

  // Uploaded pattern (post-upload, rotation baked in)
  uploadedPesData: PesPatternData | null; // Pattern with rotation applied
  uploadedPatternOffset: { x: number; y: number }; // Offset with center shift compensation

  patternUploaded: boolean;

  // Actions
  setPattern: (data: PesPatternData, fileName: string) => void;
  setPatternOffset: (x: number, y: number) => void;
  setPatternRotation: (rotation: number) => void;
  rotatePatternBy: (degrees: number) => void;
  setPatternScale: (scale: number) => void;
  mirrorPattern: (axis: MirrorAxis) => void;
  resetPatternTransform: () => void;
  setUploadedPattern: (
    uploadedData: PesPatternData,
    uploadedOffset: { x: number; y: number },
    fileName?: string,
  ) => void;
  clearUploadedPattern: () => void;
  resetPatternOffset: () => void;
  resetRotation: () => void;
}

// Computed value types
export interface PatternCenter {
  x: number;
  y: number;
}

export interface PatternBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface TransformedBounds {
  bounds: PatternBounds;
  center: PatternCenter;
}

/**
 * State update for new scale/mirror/rotation values: recalculates the pattern
 * from the source and keeps the source center at the same place on screen
 */
function withGeometry(
  state: PatternState,
  patternScale: number,
  patternMirrored: boolean,
  patternRotation: number,
): Partial<PatternState> {
  const { sourcePesData, pesData } = state;
  if (!sourcePesData || !pesData) return {};

  const newPesData = applyPatternGeometry(
    sourcePesData,
    patternScale,
    patternMirrored,
  );

  return {
    patternScale,
    patternMirrored,
    patternRotation,
    pesData: newPesData,
    patternOffset: offsetKeepingPivot(
      state.patternOffset,
      calculatePatternCenter(sourcePesData.bounds),
      { bounds: pesData.bounds, rotation: state.patternRotation },
      { bounds: newPesData.bounds, rotation: patternRotation },
    ),
  };
}

export const usePatternStore = create<PatternState>((set, get) => ({
  // Initial state - original pattern
  sourcePesData: null,
  patternScale: 1,
  patternMirrored: false,
  pesData: null,
  currentFileName: "",
  patternOffset: { x: 0, y: 0 },
  patternRotation: 0,

  // Uploaded pattern
  uploadedPesData: null,
  uploadedPatternOffset: { x: 0, y: 0 },

  patternUploaded: false,

  // Set pattern data and filename (replaces current pattern)
  setPattern: (data: PesPatternData, fileName: string) => {
    set({
      sourcePesData: data,
      patternScale: 1,
      patternMirrored: false,
      pesData: data,
      currentFileName: fileName,
      patternOffset: { x: 0, y: 0 },
      patternRotation: 0,
      uploadedPesData: null, // Clear uploaded pattern when loading new
      uploadedPatternOffset: { x: 0, y: 0 },
      patternUploaded: false,
    });
  },

  // Update pattern offset (for original pattern only)
  setPatternOffset: (x: number, y: number) => {
    set({ patternOffset: { x, y } });
  },

  // Set pattern rotation (for original pattern only)
  setPatternRotation: (rotation: number) => {
    set({ patternRotation: rotation % 360 });
    if (isDev) {
      console.log("[PatternStore] Pattern rotation changed:", rotation);
    }
  },

  // Rotate by a fixed step (e.g. the 90°/180° buttons)
  rotatePatternBy: (degrees: number) => {
    set({ patternRotation: normalizeAngle(get().patternRotation + degrees) });
  },

  // Scale uniformly; stitches are recalculated from the source pattern so
  // repeated scaling does not accumulate rounding errors
  setPatternScale: (scale: number) => {
    const { patternMirrored, patternRotation } = get();
    set(
      withGeometry(
        get(),
        clampPatternScale(scale),
        patternMirrored,
        patternRotation,
      ),
    );
  },

  // Mirror along the screen axis, taking the current rotation into account
  mirrorPattern: (axis: MirrorAxis) => {
    const { patternScale, patternMirrored, patternRotation } = get();
    set(
      withGeometry(
        get(),
        patternScale,
        !patternMirrored,
        rotationAfterMirror(patternRotation, axis),
      ),
    );
  },

  // Back to the pattern as loaded (size, mirroring and rotation)
  resetPatternTransform: () => {
    set(withGeometry(get(), 1, false, 0));
  },

  // Set uploaded pattern data (called after upload completes)
  setUploadedPattern: (
    uploadedData: PesPatternData,
    uploadedOffset: { x: number; y: number },
    fileName?: string,
  ) => {
    set({
      uploadedPesData: uploadedData,
      uploadedPatternOffset: uploadedOffset,
      patternUploaded: true,
      // Optionally set filename if provided (for resume/reconnect scenarios)
      ...(fileName && { currentFileName: fileName }),
    });
    if (isDev) {
      console.log("[PatternStore] Uploaded pattern set");
    }
  },

  // Clear uploaded pattern (called when deleting from machine)
  // This reverts to pre-upload state, keeping pesData so user can re-adjust and re-upload
  clearUploadedPattern: () => {
    if (isDev) {
      console.log("[PatternStore] CLEARING uploaded pattern...");
    }
    set({
      uploadedPesData: null,
      uploadedPatternOffset: { x: 0, y: 0 },
      patternUploaded: false,
      // Keep pesData, currentFileName, patternOffset, patternRotation
      // so user can adjust and re-upload
    });
    if (isDev) {
      console.log(
        "[PatternStore] Uploaded pattern cleared - back to editable mode",
      );
    }
  },

  // Reset pattern offset to default
  resetPatternOffset: () => {
    set({ patternOffset: { x: 0, y: 0 } });
  },

  // Reset pattern rotation to default
  resetRotation: () => {
    set({ patternRotation: 0 });
  },
}));

// Selector hooks for common use cases
export const usePesData = () => usePatternStore((state) => state.pesData);
export const useUploadedPesData = () =>
  usePatternStore((state) => state.uploadedPesData);
export const usePatternFileName = () =>
  usePatternStore((state) => state.currentFileName);
export const usePatternOffset = () =>
  usePatternStore((state) => state.patternOffset);
export const useUploadedPatternOffset = () =>
  usePatternStore((state) => state.uploadedPatternOffset);
export const usePatternRotation = () =>
  usePatternStore((state) => state.patternRotation);

// Computed selectors (memoized by Zustand)
// These provide single source of truth for derived state

/**
 * Select the geometric center of the pattern's bounds
 */
export const selectPatternCenter = (
  state: PatternState,
): PatternCenter | null => {
  if (!state.pesData) return null;
  return calculatePatternCenter(state.pesData.bounds);
};

/**
 * Select the center of the uploaded pattern's bounds
 */
export const selectUploadedPatternCenter = (
  state: PatternState,
): PatternCenter | null => {
  if (!state.uploadedPesData) return null;
  return calculatePatternCenter(state.uploadedPesData.bounds);
};

/**
 * Select the rotated bounds of the current pattern
 * Returns original bounds if no rotation or no pattern
 */
export const selectRotatedBounds = (
  state: PatternState,
): TransformedBounds | null => {
  if (!state.pesData) return null;

  const bounds =
    state.patternRotation && state.patternRotation !== 0
      ? calculateRotatedBounds(state.pesData.bounds, state.patternRotation)
      : state.pesData.bounds;

  const center = calculatePatternCenter(bounds);

  return { bounds, center };
};

/**
 * Select the center shift caused by rotation
 * This is used to adjust the offset when rotation is applied
 * Returns null if no pattern or no rotation
 */
export const selectRotationCenterShift = (
  state: PatternState,
  rotatedBounds: PatternBounds,
): { x: number; y: number } | null => {
  if (!state.pesData) return null;
  if (!state.patternRotation || state.patternRotation === 0)
    return { x: 0, y: 0 };

  const originalCenter = calculatePatternCenter(state.pesData.bounds);
  const rotatedCenter = calculatePatternCenter(rotatedBounds);

  return {
    x: rotatedCenter.x - originalCenter.x,
    y: rotatedCenter.y - originalCenter.y,
  };
};

/**
 * Hook to get pattern center (memoized with shallow comparison)
 */
export const usePatternCenter = () =>
  usePatternStore(useShallow(selectPatternCenter));

/**
 * Hook to get uploaded pattern center (memoized with shallow comparison)
 */
export const useUploadedPatternCenter = () =>
  usePatternStore(useShallow(selectUploadedPatternCenter));

/**
 * Hook to get rotated bounds (memoized with shallow comparison)
 */
export const useRotatedBounds = () =>
  usePatternStore(useShallow(selectRotatedBounds));

// Subscribe to pattern deleted event.
// This subscription is intended to persist for the lifetime of the application,
// so the unsubscribe function returned by `onPatternDeleted` is intentionally
// not stored or called.
onPatternDeleted(() => {
  try {
    usePatternStore.getState().clearUploadedPattern();
  } catch (error) {
    console.error(
      "[PatternStore] Failed to clear uploaded pattern on pattern deleted event:",
      error,
    );
  }
});
