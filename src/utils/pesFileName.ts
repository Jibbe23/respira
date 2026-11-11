/**
 * File name for saving a pattern as PES: the loaded file's name (an image
 * or a PES file) with the extension replaced by .pes
 */
export function pesFileName(name: string): string {
  const base = name.trim().replace(/\.[^./\\]*$/, "");
  return `${base || "pattern"}.pes`;
}
