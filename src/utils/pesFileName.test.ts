import { describe, expect, it } from "vitest";
import { pesFileName } from "./pesFileName";

describe("pesFileName", () => {
  it("replaces the extension of an image", () => {
    expect(pesFileName("Farbvorschau.png")).toBe("Farbvorschau.pes");
  });

  it("keeps a PES name and dots inside the name", () => {
    expect(pesFileName("Mamas.Maeusespeck.PES")).toBe("Mamas.Maeusespeck.pes");
  });

  it("adds .pes to a name without extension", () => {
    expect(pesFileName("logo")).toBe("logo.pes");
  });

  it("falls back to pattern.pes without a name", () => {
    expect(pesFileName("")).toBe("pattern.pes");
    expect(pesFileName(".png")).toBe("pattern.pes");
  });
});
