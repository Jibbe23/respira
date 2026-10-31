/**
 * StitchPreviewControls Component
 *
 * Shows how the pattern is sewn stitch by stitch, similar to the layer
 * preview of a 3D printer slicer: scrub with the slider or play it back
 * as a time-lapse.
 */

import {
  PlayIcon,
  PauseIcon,
  FilmIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";
import { Button } from "@/components/ui/button";
import { PLAYBACK_SPEEDS } from "@/hooks";

interface StitchPreviewControlsProps {
  totalStitches: number;
  enabled: boolean;
  isPlaying: boolean;
  position: number;
  speedIndex: number;
  colorLabel: string | null; // thread at the current position
  onStart: () => void;
  onStop: () => void;
  onTogglePlay: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (index: number) => void;
}

export function StitchPreviewControls({
  totalStitches,
  enabled,
  isPlaying,
  position,
  speedIndex,
  colorLabel,
  onStart,
  onStop,
  onTogglePlay,
  onSeek,
  onSpeedChange,
}: StitchPreviewControlsProps) {
  if (!enabled) {
    return (
      <div className="mt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onStart}
          disabled={totalStitches === 0}
          title="Play back the stitch sequence"
        >
          <FilmIcon />
          Stitch preview
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={onTogglePlay}
          title={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <input
          type="range"
          min={0}
          max={totalStitches}
          step={1}
          value={position}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="flex-1 min-w-0 accent-primary-600 cursor-pointer"
          aria-label="Stitch position"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onStop}
          title="Close stitch preview"
        >
          <XMarkIcon />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-300">
        <span className="tabular-nums">
          Stitch {position.toLocaleString()} / {totalStitches.toLocaleString()}
          {colorLabel && <span className="ml-2">· {colorLabel}</span>}
        </span>
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Speed"
        >
          {PLAYBACK_SPEEDS.map((speed, i) => (
            <Button
              key={speed.label}
              variant={i === speedIndex ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onSpeedChange(i)}
              title={`${speed.stitchesPerSecond} stitches per second`}
            >
              {speed.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
