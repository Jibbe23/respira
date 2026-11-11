import { create } from "zustand";
import { patternConverterClient } from "../formats/import/client";

interface UIState {
  // Pyodide state
  pyodideReady: boolean;
  pyodideError: string | null;
  pyodideProgress: number;
  pyodideLoadingStep: string;

  // UI state
  showErrorPopover: boolean;
  // Pause the machine after every thread cut (see encoder option)
  stopAfterTrim: boolean;

  // Actions
  initializePyodide: () => Promise<void>;
  setPyodideProgress: (progress: number, step: string) => void;
  toggleErrorPopover: () => void;
  setErrorPopover: (show: boolean) => void;
  setStopAfterTrim: (stop: boolean) => void;
}

const STOP_AFTER_TRIM_KEY = "respira.stopAfterTrim";

// On by default; storage can be unavailable (private window)
function loadStopAfterTrim(): boolean {
  try {
    return localStorage.getItem(STOP_AFTER_TRIM_KEY) !== "false";
  } catch {
    return true;
  }
}

export const useUIStore = create<UIState>((set) => ({
  // Initial state
  pyodideReady: false,
  pyodideError: null,
  pyodideProgress: 0,
  pyodideLoadingStep: "",
  showErrorPopover: false,
  stopAfterTrim: loadStopAfterTrim(),

  // Initialize Pyodide with progress tracking
  initializePyodide: async () => {
    try {
      // Reset progress
      set({
        pyodideProgress: 0,
        pyodideLoadingStep: "Starting...",
        pyodideError: null,
      });

      // Initialize with progress callback
      await patternConverterClient.initialize((progress, step) => {
        set({ pyodideProgress: progress, pyodideLoadingStep: step });
      });

      set({
        pyodideReady: true,
        pyodideProgress: 100,
        pyodideLoadingStep: "Ready!",
      });
      console.log("[UIStore] Pyodide initialized successfully");
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Failed to initialize Python environment";
      set({
        pyodideError: errorMessage,
        pyodideProgress: 0,
        pyodideLoadingStep: "",
      });
      console.error("[UIStore] Failed to initialize Pyodide:", err);
    }
  },

  // Set progress manually (for external updates)
  setPyodideProgress: (progress: number, step: string) => {
    set({ pyodideProgress: progress, pyodideLoadingStep: step });
  },

  // Toggle error popover visibility
  toggleErrorPopover: () => {
    set((state) => ({ showErrorPopover: !state.showErrorPopover }));
  },

  // Set error popover visibility
  setErrorPopover: (show: boolean) => {
    set({ showErrorPopover: show });
  },

  setStopAfterTrim: (stop: boolean) => {
    try {
      localStorage.setItem(STOP_AFTER_TRIM_KEY, String(stop));
    } catch {
      // Keep the choice for this session only
    }
    set({ stopAfterTrim: stop });
  },
}));

// Selector hooks for common use cases
export const usePyodideReady = () => useUIStore((state) => state.pyodideReady);
export const usePyodideError = () => useUIStore((state) => state.pyodideError);
export const usePyodideProgress = () =>
  useUIStore((state) => state.pyodideProgress);
export const usePyodideLoadingStep = () =>
  useUIStore((state) => state.pyodideLoadingStep);
export const useErrorPopover = () =>
  useUIStore((state) => state.showErrorPopover);
