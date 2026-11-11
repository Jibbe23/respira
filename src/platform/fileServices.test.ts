import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserFileService } from "./browser/BrowserFileService";
import { saveFilters } from "./electron/ElectronFileService";

describe("BrowserFileService.saveFileDialog", () => {
  const { createObjectURL, revokeObjectURL } = URL;
  afterEach(() => {
    vi.restoreAllMocks();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("downloads the data under the given name", async () => {
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return "blob:pes";
    });
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("logo.pes");
        expect(this.href).toBe("blob:pes");
      });

    await new BrowserFileService().saveFileDialog(
      new Uint8Array([1, 2, 3]),
      "logo.pes",
    );

    expect(click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.size).toBe(3);
  });
});

describe("saveFilters", () => {
  it("offers the extension of the file name", () => {
    expect(saveFilters("logo.pes")).toEqual([
      { name: "PES Files", extensions: ["pes"] },
    ]);
    expect(saveFilters("pattern.PEN")).toEqual([
      { name: "PEN Files", extensions: ["pen"] },
    ]);
    expect(saveFilters("noext")).toEqual([]);
  });
});
