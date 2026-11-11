import type { IFileService } from "../interfaces/IFileService";

/**
 * Browser implementation of file service using HTML input elements
 */
export class BrowserFileService implements IFileService {
  async openFileDialog(options: { accept: string }): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = options.accept;

      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        resolve(file || null);
      };

      input.oncancel = () => {
        resolve(null);
      };

      input.click();
    });
  }

  async saveFileDialog(data: Uint8Array, defaultName: string): Promise<void> {
    // Download through a temporary link (the browser asks where to save,
    // or puts it in the downloads folder)
    const url = URL.createObjectURL(
      new Blob([data as BlobPart], { type: "application/octet-stream" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = defaultName;
    link.click();
    // Give the browser time to start the download before revoking
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  hasNativeDialogs(): boolean {
    return false;
  }
}
