import { describe, expect, it } from "vitest";
import { snapMixedPixels } from "./traceImage";

/** A 3 px high image whose rows all have the gray values of `row` */
function grayRows(row: number[]): ImageData {
  const width = row.length;
  const data = new Uint8ClampedArray(width * 3 * 4);
  for (let y = 0; y < 3; y++) {
    row.forEach((v, x) => data.set([v, v, v, 255], (y * width + x) * 4));
  }
  return { width, height: 3, data, colorSpace: "srgb" } as ImageData;
}

/** Gray values of the middle row */
const middleRow = (image: ImageData) =>
  Array.from(
    { length: image.width },
    (_, x) => image.data[(image.width + x) * 4],
  );

describe("snapMixedPixels", () => {
  it("gives a 1 px seam the color of the closer side", () => {
    expect(middleRow(snapMixedPixels(grayRows([0, 0, 106, 255, 255])))).toEqual(
      [0, 0, 0, 255, 255],
    );
    expect(middleRow(snapMixedPixels(grayRows([0, 0, 191, 255, 255])))).toEqual(
      [0, 0, 255, 255, 255],
    );
  });

  it("splits a blurred edge between its solid sides", () => {
    expect(
      middleRow(snapMixedPixels(grayRows([0, 0, 51, 102, 153, 204, 255, 255]))),
    ).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
  });

  it("gives a pixel right in the middle to the darker side", () => {
    expect(middleRow(snapMixedPixels(grayRows([0, 0, 127, 254, 254])))).toEqual(
      [0, 0, 0, 254, 254],
    );
  });

  it("keeps a gradient wider than an edge", () => {
    const ramp = [
      0,
      0,
      ...Array.from({ length: 16 }, (_, i) => 15 * (i + 1)),
      255,
    ];
    const snapped = middleRow(snapMixedPixels(grayRows(ramp)));
    // The middle of the gradient keeps its grays
    expect(snapped[9]).toBe(ramp[9]);
    expect(snapped[10]).toBe(ramp[10]);
  });
});
