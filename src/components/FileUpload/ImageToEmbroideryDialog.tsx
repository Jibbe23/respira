/**
 * ImageToEmbroideryDialog Component
 *
 * Turns an image (logo, clipart, drawing, photo) into a stitch pattern:
 * choose the number of thread colors, the size, the fill (tatami or cross
 * stitch) and how often lines are sewn,
 * check the preview and use the result like a loaded PES file.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { PhotoIcon } from "@heroicons/react/24/solid";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PesPatternData } from "../../formats/import/pesImporter";
import { loadImageData } from "../../formats/image/loadImage";
import {
  imageToPattern,
  patternSizeMm,
  type FillDensity,
  type FillType,
  type ImageToPatternOptions,
  type Repeats,
} from "../../formats/image/imageToPattern";

const MAX_COLORS = 12;
const MIN_WIDTH_MM = 10;
/** Wait for the settings to settle before converting again */
const CONVERT_DELAY_MS = 250;

interface ImageToEmbroideryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hoopWidthMm: number;
  hoopHeightMm: number;
  onApply: (data: PesPatternData, fileName: string) => void;
}

/** Result of one conversion, tagged with the image and settings it used */
interface Conversion {
  source: { imageData: ImageData; name: string };
  options: ImageToPatternOptions;
  result: { pattern: PesPatternData | null } | { error: string };
}

const CROSS_SIZES_MM = [2, 2.5, 3, 4];
const SELECT_CLASS =
  "h-8 px-2 bg-transparent border border-gray-300 dark:border-gray-600 rounded-md";

/** Single / double / triple choice for outlines and crosses */
function RepeatsSelect({
  value,
  onChange,
  label,
}: {
  value: Repeats;
  onChange: (value: Repeats) => void;
  label: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as Repeats)}
      aria-label={label}
      className={SELECT_CLASS}
    >
      <option value={1}>Single</option>
      <option value={2}>Double</option>
      <option value={3}>Triple</option>
    </select>
  );
}

/** Draw the stitches (no jumps) in their thread colors */
function drawPattern(canvas: HTMLCanvasElement, pattern: PesPatternData) {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { minX, maxX, minY, maxY } = pattern.bounds;
  const size = canvas.width;
  const scale = (size - 16) / Math.max(1, maxX - minX, maxY - minY);
  const ox = (size - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (size - (maxY - minY) * scale) / 2 - minY * scale;

  context.clearRect(0, 0, size, size);
  context.lineWidth = 1;
  const { stitches, threads } = pattern;
  for (let i = 1; i < stitches.length; i++) {
    const [x, y, cmd, color] = stitches[i];
    const [px, py, , prevColor] = stitches[i - 1];
    if (cmd !== 0 || color !== prevColor) continue;
    context.strokeStyle = threads[color]?.hex ?? "#000";
    context.beginPath();
    context.moveTo(ox + px * scale, oy + py * scale);
    context.lineTo(ox + x * scale, oy + y * scale);
    context.stroke();
  }
}

export function ImageToEmbroideryDialog({
  open,
  onOpenChange,
  hoopWidthMm,
  hoopHeightMm,
  onApply,
}: ImageToEmbroideryDialogProps) {
  const [source, setSource] = useState<{
    imageData: ImageData;
    name: string;
  } | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [colors, setColors] = useState(4);
  const [widthMm, setWidthMm] = useState(() =>
    Math.round(Math.min(hoopWidthMm, hoopHeightMm) * 0.8),
  );
  const [removeBackground, setRemoveBackground] = useState(true);
  const [fill, setFill] = useState<FillType>("tatami");
  const [density, setDensity] = useState<FillDensity>("normal");
  const [outlineRepeats, setOutlineRepeats] = useState<Repeats>(1);
  const [crossSizeMm, setCrossSizeMm] = useState(2.5);
  const [crossRepeats, setCrossRepeats] = useState<Repeats>(1);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadIdRef = useRef(0);

  // The typed width is only advisory: keep it inside the hoop
  const width = Math.min(
    hoopWidthMm,
    Math.max(MIN_WIDTH_MM, Number.isFinite(widthMm) ? widthMm : 0),
  );
  const options = useMemo<ImageToPatternOptions>(
    () => ({
      colors,
      widthMm: width,
      // Too tall for the hoop: scaled down instead of refused
      maxHeightMm: hoopHeightMm,
      removeBackground,
      fill,
      density,
      outlineRepeats,
      crossSizeMm,
      crossRepeats,
    }),
    [
      colors,
      width,
      hoopHeightMm,
      removeBackground,
      fill,
      density,
      outlineRepeats,
      crossSizeMm,
      crossRepeats,
    ],
  );

  const handleFile = async (selected: File | undefined) => {
    if (!selected) return;
    const loadId = ++loadIdRef.current;
    // The previous URL is revoked by the effect cleanup below
    setImageUrl(URL.createObjectURL(selected));
    setLoadError(false);
    try {
      const imageData = await loadImageData(selected);
      // A file picked later wins, even if it loaded faster
      if (loadId === loadIdRef.current) {
        setSource({ imageData, name: selected.name });
      }
    } catch {
      if (loadId === loadIdRef.current) {
        setSource(null);
        setLoadError(true);
      }
    }
  };

  // Convert again whenever the image or a setting changes
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    let inner: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      // Let the spinner render before the (blocking) conversion runs
      inner = setTimeout(() => {
        if (cancelled) return;
        let result: Conversion["result"];
        try {
          result = {
            pattern: imageToPattern(source.imageData, options),
          };
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : "Conversion failed",
          };
        }
        if (!cancelled) setConversion({ source, options, result });
      }, 0);
    }, CONVERT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(inner);
    };
  }, [source, options]);

  // Only a result for the current image and settings counts
  const current =
    conversion && conversion.source === source && conversion.options === options
      ? conversion.result
      : null;
  const isWorking = !!source && !current;
  const pattern = current && "pattern" in current ? current.pattern : null;
  const conversionError = current && "error" in current ? current.error : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (pattern) {
      drawPattern(canvas, pattern);
    } else {
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [pattern]);

  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  const size = pattern ? patternSizeMm(pattern) : null;
  const heightMm = size?.height ?? null;
  const tooLarge = heightMm !== null && heightMm > hoopHeightMm;
  // Narrower than asked when the height had to fit the hoop
  const scaledDown = size !== null && size.width < width - 0.5;

  const handleApply = () => {
    if (!pattern || !source) return;
    const baseName = source.name.replace(/\.[^.]+$/, "");
    onApply(pattern, `${baseName}.pes`);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Image to embroidery</DialogTitle>
          <DialogDescription>
            Works best with logos, clipart and drawings with clear areas. Photos
            become a poster-like image of a few colors.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml"
              onChange={(e) => void handleFile(e.target.files?.[0])}
              aria-label="Image file"
              className="text-sm file:mr-2 file:rounded-md file:border file:border-gray-300 file:bg-transparent file:px-3 file:py-1 dark:file:border-gray-600 dark:file:text-gray-200"
            />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm text-gray-900 dark:text-gray-100">
            <label className="flex flex-col gap-1">
              <span>
                Thread colors: <strong>{colors}</strong>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {" "}
                  (fewer colors, fewer thread changes)
                </span>
              </span>
              <input
                type="range"
                min={1}
                max={MAX_COLORS}
                value={colors}
                onChange={(e) => setColors(Number(e.target.value))}
                aria-label="Thread colors"
                className="accent-primary-600"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span>Width (mm)</span>
              <input
                type="number"
                min={MIN_WIDTH_MM}
                max={hoopWidthMm}
                value={widthMm}
                onChange={(e) => setWidthMm(Number(e.target.value))}
                aria-label="Width in millimetres"
                className={`${SELECT_CLASS} w-24`}
              />
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={removeBackground}
                onChange={(e) => setRemoveBackground(e.target.checked)}
              />
              Leave out background
            </label>

            <label className="flex items-center gap-2">
              <span>Fill</span>
              <select
                value={fill}
                onChange={(e) => setFill(e.target.value as FillType)}
                aria-label="Fill type"
                className={SELECT_CLASS}
              >
                <option value="tatami">Fill (smooth areas)</option>
                <option value="cross">Cross stitch</option>
              </select>
            </label>

            {fill === "tatami" ? (
              <>
                <label className="flex items-center gap-2">
                  <span>Fill density</span>
                  <select
                    value={density}
                    onChange={(e) => setDensity(e.target.value as FillDensity)}
                    aria-label="Fill density"
                    className={SELECT_CLASS}
                  >
                    <option value="normal">Normal</option>
                    <option value="dense">Dense</option>
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span>Outline</span>
                  <RepeatsSelect
                    value={outlineRepeats}
                    onChange={setOutlineRepeats}
                    label="Outline"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <span>Cross size</span>
                  <select
                    value={crossSizeMm}
                    onChange={(e) => setCrossSizeMm(Number(e.target.value))}
                    aria-label="Cross size"
                    className={SELECT_CLASS}
                  >
                    {CROSS_SIZES_MM.map((size) => (
                      <option key={size} value={size}>
                        {size} mm
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <span>Cross</span>
                  <RepeatsSelect
                    value={crossRepeats}
                    onChange={setCrossRepeats}
                    label="Cross"
                  />
                </label>
              </>
            )}
          </div>

          {imageUrl && (
            <div className="grid grid-cols-2 gap-3">
              <div className="aspect-square flex items-center justify-center rounded-md border border-gray-300 dark:border-gray-600 bg-white p-2">
                <img
                  src={imageUrl}
                  alt="Selected image"
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              <div className="relative aspect-square rounded-md border border-gray-300 dark:border-gray-600 bg-white">
                <canvas
                  ref={canvasRef}
                  width={400}
                  height={400}
                  className="w-full h-full"
                  aria-label="Embroidery preview"
                />
                {isWorking && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/60">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-700" />
                  </div>
                )}
              </div>
            </div>
          )}

          {(loadError || conversionError) && (
            <p className="text-sm text-danger-600 m-0">
              {loadError ? "This image could not be read." : conversionError}
            </p>
          )}
          {current && "pattern" in current && !pattern && (
            <p className="text-sm text-warning-700 dark:text-warning-400 m-0">
              Nothing left to sew. Try more colors or keep the background.
            </p>
          )}
          {pattern && (
            <div className="flex flex-col gap-1 text-xs text-gray-700 dark:text-gray-300">
              <span>
                {size?.width.toFixed(1)} × {heightMm?.toFixed(1)} mm ·{" "}
                {pattern.penStitches.stitches.length.toLocaleString()} stitches
                · {pattern.threads.length} thread colors
              </span>
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {pattern.threads.map((thread, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span
                      className="inline-block w-3 h-3 rounded-full border border-gray-400"
                      style={{ backgroundColor: thread.hex }}
                    />
                    {thread.catalogNumber} {thread.description}
                  </span>
                ))}
              </span>
              {scaledDown && !tooLarge && (
                <span className="text-info-700 dark:text-info-300">
                  Scaled down from {width} mm wide so the height fits the hoop (
                  {hoopWidthMm} × {hoopHeightMm} mm).
                </span>
              )}
              {tooLarge && (
                <span className="text-warning-700 dark:text-warning-400">
                  Taller than the hoop ({hoopWidthMm} × {hoopHeightMm} mm).
                  Reduce the width.
                </span>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!pattern || tooLarge}>
            <PhotoIcon />
            Use pattern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
