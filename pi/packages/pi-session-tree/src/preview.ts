export const PREVIEW_LINES = 20;

export function cleanPreview(raw: string, maxLines: number = PREVIEW_LINES, cropBottom = 0): string[] {
  const lines = raw.split("\n").map((l) => l.replace(/\r/g, ""));
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const cropped = cropBottom > 0 ? lines.slice(0, Math.max(0, lines.length - cropBottom)) : lines;
  return cropped.slice(-maxLines);
}
