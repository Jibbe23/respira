/**
 * PatternTransformControls Component
 *
 * Toolbar for quick pattern transforms before upload:
 * rotate in 90°/180° steps, mirror, scale in steps and reset
 */

import {
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ArrowsRightLeftIcon,
  ArrowsUpDownIcon,
  MinusIcon,
  PlusIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/solid";
import { Button } from "@/components/ui/button";
import {
  MIN_PATTERN_SCALE,
  MAX_PATTERN_SCALE,
  SAFE_SCALE_RANGE,
  type MirrorAxis,
} from "../../utils/patternGeometry";

const SCALE_STEP = 0.05;

interface PatternTransformControlsProps {
  scale: number;
  rotation: number;
  mirrored: boolean;
  onRotateBy: (degrees: number) => void;
  onMirror: (axis: MirrorAxis) => void;
  onScale: (scale: number) => void;
  onReset: () => void;
}

export function PatternTransformControls({
  scale,
  rotation,
  mirrored,
  onRotateBy,
  onMirror,
  onScale,
  onReset,
}: PatternTransformControlsProps) {
  const percent = Math.round(scale * 100);
  const isTransformed = scale !== 1 || rotation !== 0 || mirrored;
  const outsideSafeRange =
    scale < SAFE_SCALE_RANGE.min || scale > SAFE_SCALE_RANGE.max;

  // Step to the next multiple of 5% in the given direction
  // (a dragged scale like 102% goes to 105% or 100%)
  const stepScale = (direction: 1 | -1) => {
    const steps = scale / SCALE_STEP;
    const next =
      direction > 0
        ? Math.floor(steps + 1e-6) + 1
        : Math.ceil(steps - 1e-6) - 1;
    onScale(next * SCALE_STEP);
  };

  return (
    <div className="flex flex-col gap-1 mb-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onRotateBy(-90)}
          title="Rotate 90° counter-clockwise"
        >
          <ArrowUturnLeftIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onRotateBy(90)}
          title="Rotate 90° clockwise"
        >
          <ArrowUturnRightIcon />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => onRotateBy(180)}
          title="Rotate 180°"
        >
          180°
        </Button>

        <span className="w-px h-6 bg-gray-300 dark:bg-gray-600 mx-0.5" />

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onMirror("horizontal")}
          title="Mirror horizontally"
        >
          <ArrowsRightLeftIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => onMirror("vertical")}
          title="Mirror vertically"
        >
          <ArrowsUpDownIcon />
        </Button>

        <span className="w-px h-6 bg-gray-300 dark:bg-gray-600 mx-0.5" />

        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => stepScale(-1)}
          disabled={scale <= MIN_PATTERN_SCALE}
          title="Smaller"
        >
          <MinusIcon />
        </Button>
        <span
          className="min-w-[44px] text-center text-sm font-semibold text-gray-900 dark:text-gray-100 select-none"
          title="Pattern size (drag the corner handles to scale)"
        >
          {percent}%
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => stepScale(1)}
          disabled={scale >= MAX_PATTERN_SCALE}
          title="Larger"
        >
          <PlusIcon />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onReset}
          disabled={!isTransformed}
          title="Reset size, rotation and mirroring"
        >
          <ArrowPathIcon />
        </Button>
      </div>

      {outsideSafeRange && (
        <p className="flex items-center gap-1 text-xs text-warning-700 dark:text-warning-400 m-0">
          <ExclamationTriangleIcon className="w-3.5 h-3.5 flex-shrink-0" />
          Large size changes keep the stitch count, so stitches become denser or
          longer. Check the result before sewing.
        </p>
      )}
    </div>
  );
}
