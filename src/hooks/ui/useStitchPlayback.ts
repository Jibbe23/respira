/**
 * useStitchPlayback Hook
 *
 * State for the stitch preview: a position in the stitch sequence that can be
 * scrubbed with a slider or played back like a time-lapse.
 */

import { useState, useEffect, useRef, useCallback } from "react";

/** Playback speeds in stitches per second */
export const PLAYBACK_SPEEDS = [
  { label: "1×", stitchesPerSecond: 25 },
  { label: "5×", stitchesPerSecond: 125 },
  { label: "20×", stitchesPerSecond: 500 },
  { label: "100×", stitchesPerSecond: 2500 },
] as const;

/**
 * Advance the (fractional) playback position by elapsed time, capped at the end
 */
export function advancePlayback(
  position: number,
  stitchesPerSecond: number,
  elapsedMs: number,
  totalStitches: number,
): number {
  return Math.min(
    totalStitches,
    position + (stitchesPerSecond * elapsedMs) / 1000,
  );
}

/**
 * @param totalStitches - Stitch count of the pattern shown
 * @param allowed - false pauses playback (e.g. while the machine is sewing)
 * @param resetKey - the preview closes when this value changes (other pattern)
 */
export function useStitchPlayback(
  totalStitches: number,
  allowed: boolean,
  resetKey: unknown,
) {
  const [enabled, setEnabled] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(1);

  // Adjust state during render instead of in an effect (React docs pattern)
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    setEnabled(false);
    setIsPlaying(false);
  }
  if (!allowed && isPlaying) {
    setIsPlaying(false);
  }

  // Fractional position kept outside React state so slow speeds still advance
  const positionRef = useRef(0);

  const seek = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(totalStitches, Math.round(index)));
      positionRef.current = clamped;
      setPosition(clamped);
    },
    [totalStitches],
  );

  useEffect(() => {
    if (!enabled || !isPlaying) return;

    let frame = 0;
    let last = performance.now();
    const stitchesPerSecond = PLAYBACK_SPEEDS[speedIndex].stitchesPerSecond;

    const tick = (now: number) => {
      positionRef.current = advancePlayback(
        positionRef.current,
        stitchesPerSecond,
        now - last,
        totalStitches,
      );
      last = now;
      setPosition(Math.floor(positionRef.current));

      if (positionRef.current >= totalStitches) {
        setIsPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [enabled, isPlaying, speedIndex, totalStitches]);

  const start = useCallback(() => {
    setEnabled(true);
    seek(0);
    setIsPlaying(true);
  }, [seek]);

  const stop = useCallback(() => {
    setEnabled(false);
    setIsPlaying(false);
  }, []);

  const pause = useCallback(() => setIsPlaying(false), []);

  const togglePlay = useCallback(() => {
    // Restart from the beginning when the end was reached
    if (!isPlaying && positionRef.current >= totalStitches) {
      seek(0);
    }
    setIsPlaying((playing) => !playing);
  }, [isPlaying, totalStitches, seek]);

  return {
    enabled,
    isPlaying,
    // Clamped here because the pattern (and its stitch count) can change
    position: Math.min(position, totalStitches),
    speedIndex,
    start,
    stop,
    togglePlay,
    seek,
    setSpeedIndex,
    pause,
  };
}
