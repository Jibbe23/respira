// imagetracerjs ships without type declarations; only the call used here
declare module "imagetracerjs" {
  const ImageTracer: {
    imagedataToTracedata(
      imageData: ImageData,
      options: Record<string, unknown>,
    ): unknown;
  };
  export default ImageTracer;
}
