import type { IFileService } from "../interfaces/IFileService";

/**
 * Electron implementation of file service using native dialogs via IPC
 */
/** Save dialog filter for the extension of `name` (e.g. PES Files) */
export function saveFilters(name: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return extension
    ? [{ name: `${extension.toUpperCase()} Files`, extensions: [extension] }]
    : [];
}

export class ElectronFileService implements IFileService {
  async openFileDialog(): Promise<File | null> {
    if (!window.electronAPI) {
      throw new Error("Electron API not available");
    }

    try {
      const result = await window.electronAPI.invoke<{
        filePath: string;
        fileName: string;
      } | null>("dialog:openFile", {
        filters: [
          { name: "PES Files", extensions: ["pes"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (!result) {
        return null;
      }

      // Read the file content
      const buffer = await window.electronAPI.invoke<ArrayBuffer>(
        "fs:readFile",
        result.filePath,
      );
      const blob = new Blob([buffer]);
      return new File([blob], result.fileName, {
        type: "application/octet-stream",
      });
    } catch (err) {
      console.error("[ElectronFileService] Failed to open file:", err);
      return null;
    }
  }

  async saveFileDialog(data: Uint8Array, defaultName: string): Promise<void> {
    if (!window.electronAPI) {
      throw new Error("Electron API not available");
    }

    try {
      const filePath = await window.electronAPI.invoke<string | null>(
        "dialog:saveFile",
        {
          defaultPath: defaultName,
          filters: [
            ...saveFilters(defaultName),
            { name: "All Files", extensions: ["*"] },
          ],
        },
      );

      if (filePath) {
        await window.electronAPI.invoke(
          "fs:writeFile",
          filePath,
          Array.from(data),
        );
      }
    } catch (err) {
      console.error("[ElectronFileService] Failed to save file:", err);
      throw err;
    }
  }

  hasNativeDialogs(): boolean {
    return true;
  }
}
