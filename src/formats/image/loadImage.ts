/**
 * Read an image file (PNG, JPG, SVG, ...) into pixels for tracing
 */

/**
 * Longest side the image is reduced to before tracing (speed vs. detail):
 * a bit finer than the 0.1 mm stitch resolution over a 100 mm hoop
 * (1000 px), so thin lines and dots survive scaling (at 400 px contour lines
 * blurred away)
 */
const TRACE_SIZE = 1200;
/** Size used for SVGs without width/height */
const DEFAULT_SVG_SIZE = 400;

export async function loadImageData(file: File): Promise<ImageData> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const naturalWidth = image.naturalWidth || DEFAULT_SVG_SIZE;
    const naturalHeight = image.naturalHeight || DEFAULT_SVG_SIZE;
    const scale = Math.min(
      1,
      TRACE_SIZE / Math.max(naturalWidth, naturalHeight),
    );
    // SVGs are drawn at the trace size even if they are smaller
    const fit =
      file.type === "image/svg+xml"
        ? TRACE_SIZE / Math.max(naturalWidth, naturalHeight)
        : scale;
    const width = Math.max(1, Math.round(naturalWidth * fit));
    const height = Math.max(1, Math.round(naturalHeight * fit));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}
