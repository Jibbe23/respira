/**
 * SavePesButton Component
 *
 * Saves the loaded pattern (e.g. one converted from an image) as a PES file,
 * written by pystitch in the pattern worker
 */

import { useState } from "react";
import { ArrowDownTrayIcon } from "@heroicons/react/24/solid";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PesPatternData } from "../../formats/import/pesImporter";
import { patternConverterClient } from "../../formats/import/client";
import type { IFileService } from "../../platform/interfaces/IFileService";
import { pesFileName } from "../../utils/pesFileName";

interface SavePesButtonProps {
  pesData: PesPatternData | null;
  fileName: string;
  fileService: IFileService;
  pyodideReady: boolean;
  initializePyodide: () => Promise<void>;
}

export function SavePesButton({
  pesData,
  fileName,
  fileService,
  pyodideReady,
  initializePyodide,
}: SavePesButtonProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!pesData) return;
    setIsSaving(true);
    setError(null);
    try {
      if (!pyodideReady) await initializePyodide();
      const data = await patternConverterClient.writePes(pesData);
      await fileService.saveFileDialog(data, pesFileName(fileName));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving failed");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full mb-3"
        onClick={handleSave}
        disabled={!pesData || isSaving}
      >
        {isSaving ? (
          <Loader2 className="animate-spin" />
        ) : (
          <ArrowDownTrayIcon />
        )}
        Save as PES
      </Button>
      {error && (
        <p className="text-xs text-danger-600 dark:text-danger-400 mb-3">
          Could not save the PES file: {error}
        </p>
      )}
    </>
  );
}
