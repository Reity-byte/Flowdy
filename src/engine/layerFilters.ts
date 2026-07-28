// src/engine/layerFilters.ts
// One-shot, destructive per-layer pixel operations for the layer panel's
// "White → Transparent" and "Select Opacity" (recolor-by-alpha) actions.
// Each function reads/writes a single layer's own ImageData directly —
// same one-time-getImageData-per-click shape as floodFill.ts, not a
// per-frame/per-dab hot path, so no special perf handling is needed here.

export type RGB = { r: number; g: number; b: number };

/**
 * ibis Paint-style "White to Transparency" (grayscale variant): treats the
 * layer as if it were black ink drawn on white paper and extracts that ink
 * as a pure-black, alpha-masked result — luminance directly becomes the new
 * alpha (white = fully transparent, black = unchanged), scaled by whatever
 * alpha the pixel already had so already-transparent areas stay
 * proportionally transparent. RGB is flattened to pure black, since the
 * whole point of this mode is discarding color/hue and keeping only "how
 * dark was it" as line art — matches the common real-world use case of
 * cleaning up a scanned black-and-white sketch.
 */
export function whiteToTransparentGrayscale(ctx: CanvasRenderingContext2D): void {
  const { width, height } = ctx.canvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
    data[i + 3] = Math.round(a * (255 - luminance) / 255);
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * ibis Paint-style "White to Transparency" (color variant): the same
 * lightness-becomes-alpha idea as the grayscale variant (luminance directly
 * drives the new alpha — brighter reads as more transparent, pure black is
 * never touched), just WITHOUT discarding hue — original RGB is kept as-is,
 * only alpha changes.
 *
 * This is deliberately luminance-based, not "distance from literal white":
 * an earlier version measured how close each pixel was to (255,255,255) and
 * left anything sufficiently saturated (e.g. a pure red or blue) completely
 * untouched, because a saturated color is "far from white" by that metric
 * even though it reads as bright. That's the opposite of what this feature
 * is for — a bright saturated color should still become semi-transparent,
 * same as a light pastel or literal white would; only true blacks (and
 * colors that are actually dark, not just non-white) should stay opaque.
 *
 * `strength` (0-100) blends between the original alpha (0 — no change) and
 * the fully luminance-derived alpha (100 — `newAlpha = a * (255-luminance) /
 * 255`, identical formula to the grayscale variant). Pure black's luminance
 * is 0 regardless of `strength`, so it's always left at its original alpha —
 * "except for black" falls out of the formula rather than needing a
 * separate special case.
 */
export function whiteToTransparentColor(ctx: CanvasRenderingContext2D, strength: number): void {
  const { width, height } = ctx.canvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const s = Math.max(0, Math.min(100, strength)) / 100;
  if (s <= 0) return;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const luminance = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const factor = 1 - s * (luminance / 255);
    data[i + 3] = Math.round(a * factor);
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * ibis Paint's "Select Opacity" recolor: reads each pixel's EXISTING alpha
 * as its selection strength and repaints only the hue/RGB to `color`,
 * leaving that alpha completely untouched — so line weight, antialiased
 * edge softness, and any partial-opacity strokes look exactly as soft as
 * before, just in a new color. Fully-transparent pixels are skipped (there's
 * nothing there to recolor).
 */
export function recolorByAlpha(ctx: CanvasRenderingContext2D, color: RGB): void {
  const { width, height } = ctx.canvas;
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
  }
  ctx.putImageData(imgData, 0, 0);
}
