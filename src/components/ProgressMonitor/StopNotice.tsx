/**
 * StopNotice Component
 *
 * Says why the machine waits for a "color change": a real thread change
 * (prominent, with the next thread) or a pause after a thread cut
 */

import {
  ExclamationTriangleIcon,
  ScissorsIcon,
} from "@heroicons/react/24/solid";
import { formatThreadMetadata } from "../../utils/threadMetadata";
import type { MachineStop } from "../../utils/colorBlockHelpers";

interface StopNoticeProps {
  stop: MachineStop;
}

export function StopNotice({ stop }: StopNoticeProps) {
  if (stop.kind === "trim") {
    return (
      <div
        role="status"
        className="mb-3 flex items-start gap-2 rounded-lg border border-info-300 dark:border-info-700 bg-info-50 dark:bg-info-900/20 p-2.5 text-xs text-info-900 dark:text-info-100"
      >
        <ScissorsIcon className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold">Thread cut: same color continues</div>
          <div className="mt-0.5">
            Hold the end of the upper thread, then press the start button on the
            machine.
          </div>
        </div>
      </div>
    );
  }

  const next = stop.nextBlock;
  return (
    <div
      role="alert"
      className="mb-3 rounded-lg border-2 border-warning-500 bg-warning-50 dark:bg-warning-900/30 p-3 text-warning-900 dark:text-warning-100"
    >
      <div className="flex items-center gap-2 font-bold text-sm">
        <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
        Change thread color
      </div>
      {next && (
        <div className="mt-2 flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-lg border-2 border-gray-300 dark:border-gray-600 shadow-md flex-shrink-0"
            style={{ backgroundColor: next.threadHex }}
            aria-label={`Thread color ${next.threadHex}`}
          />
          <div className="text-xs">
            <div className="font-semibold text-sm">
              Thread {next.colorIndex + 1}
            </div>
            <div>{formatThreadMetadata(next) || next.threadHex}</div>
          </div>
        </div>
      )}
      <div className="mt-2 text-xs">
        Thread the new color, hold its end, then press the start button on the
        machine.
      </div>
    </div>
  );
}
