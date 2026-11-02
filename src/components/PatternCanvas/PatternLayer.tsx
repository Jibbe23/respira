/**
 * PatternLayer Component
 *
 * Unified component for rendering pattern layers (both original and uploaded)
 * Handles both interactive (draggable/rotatable/scalable) and locked states
 * and the stitch-by-stitch preview
 */

import { useEffect, useMemo, memo, type RefObject } from "react";
import { Group, Transformer } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { PesPatternData } from "../../formats/import/pesImporter";
import {
  calculatePatternCenter,
  convertPenStitchesToPesFormat,
} from "./patternCanvasHelpers";
import { Stitches, PatternBounds, CurrentPosition } from "./KonvaComponents";

interface PatternLayerProps {
  pesData: PesPatternData;
  offset: { x: number; y: number };
  rotation?: number;
  isInteractive: boolean;
  showProgress?: boolean;
  currentStitchIndex?: number;
  previewStitchIndex?: number | null; // stitch preview position, null = off
  patternGroupRef?: RefObject<Konva.Group | null>;
  transformerRef?: RefObject<Konva.Transformer | null>;
  onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd?: (e: KonvaEventObject<Event>) => void;
  attachTransformer?: () => void;
}

export const PatternLayer = memo(function PatternLayer({
  pesData,
  offset,
  rotation = 0,
  isInteractive,
  showProgress = false,
  currentStitchIndex = 0,
  previewStitchIndex = null,
  patternGroupRef,
  transformerRef,
  onDragEnd,
  onTransformEnd,
  attachTransformer,
}: PatternLayerProps) {
  // Memoize center calculation - this is the pattern center calculation
  // Note: We keep this local calculation here since the component receives
  // pesData as a prop which could be either original or uploaded pattern
  const center = useMemo(
    () => calculatePatternCenter(pesData.bounds),
    [pesData.bounds],
  );

  const stitches = useMemo(
    () => convertPenStitchesToPesFormat(pesData.penStitches),
    [pesData.penStitches],
  );

  // The stitch preview overrides the sewing progress display
  const isPreview = previewStitchIndex !== null;
  const displayStitchIndex = isPreview
    ? previewStitchIndex
    : currentStitchIndex;

  // The group's size changes when frames are hidden for the preview
  useEffect(() => {
    transformerRef?.current?.forceUpdate();
  }, [isPreview, transformerRef]);

  const groupName = isInteractive ? "pattern-group" : "uploaded-pattern-group";

  return (
    <>
      <Group
        name={groupName}
        ref={
          isInteractive
            ? (node) => {
                if (patternGroupRef) {
                  patternGroupRef.current = node;
                }
                // Set initial rotation from state
                if (node && isInteractive) {
                  node.rotation(rotation);
                  // Try to attach transformer when group is mounted
                  if (attachTransformer) {
                    attachTransformer();
                  }
                }
              }
            : undefined
        }
        draggable={isInteractive && !isPreview}
        x={offset.x}
        y={offset.y}
        offsetX={center.x}
        offsetY={center.y}
        onDragEnd={isInteractive ? onDragEnd : undefined}
        onTransformEnd={isInteractive ? onTransformEnd : undefined}
        onMouseEnter={
          isInteractive
            ? (e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "move";
              }
            : undefined
        }
        onMouseLeave={
          isInteractive
            ? (e) => {
                const stage = e.target.getStage();
                if (stage) stage.container().style.cursor = "grab";
              }
            : undefined
        }
      >
        <Stitches
          stitches={stitches}
          pesData={pesData}
          currentStitchIndex={displayStitchIndex}
          showProgress={showProgress || isPreview}
          incompleteOpacity={isPreview ? 0.08 : undefined}
        />
        {/* Frames would hide stitches on the pattern edge during the preview */}
        {!isPreview && <PatternBounds bounds={pesData.bounds} />}
        {/* Inside the group so the marker follows rotation */}
        {isPreview && (
          <CurrentPosition
            currentStitchIndex={displayStitchIndex}
            stitches={stitches}
          />
        )}
      </Group>

      {/* Transformer only for interactive layer */}
      {isInteractive && transformerRef && (
        <Transformer
          ref={(node) => {
            if (transformerRef) {
              transformerRef.current = node;
            }
            // Try to attach transformer when transformer is mounted
            if (node && attachTransformer) {
              attachTransformer();
            }
          }}
          enabledAnchors={[
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
          ]}
          visible={!isPreview}
          keepRatio={true}
          centeredScaling={true}
          flipEnabled={false}
          rotateEnabled={true}
          borderEnabled={true}
          borderStroke="#FF6B6B"
          borderStrokeWidth={2}
          rotationSnaps={[0, 45, 90, 135, 180, 225, 270, 315]}
          ignoreStroke={true}
          rotateAnchorOffset={20}
        />
      )}

      {/* Current position indicator (only for uploaded pattern with progress) */}
      {!isPreview &&
        !isInteractive &&
        showProgress &&
        currentStitchIndex > 0 && (
          <Group
            x={offset.x}
            y={offset.y}
            offsetX={center.x}
            offsetY={center.y}
          >
            <CurrentPosition
              currentStitchIndex={currentStitchIndex}
              stitches={stitches}
            />
          </Group>
        )}
    </>
  );
});
