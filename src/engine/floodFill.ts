// src/engine/floodFill.ts
// Stack-based scanline flood fill (paint bucket), operating directly on a
// layer's 2D context pixel data. Iterative (a stack of spans, not per-pixel
// recursion) so it can't stack-overflow on a large canvas — same constraint
// the todo's Magic Wand section calls out for the same underlying algorithm.

export type FillColor = { r: number; g: number; b: number; a: number };

/**
 * Fills the contiguous region of pixels connected to (startX, startY) whose
 * color is within `tolerance` (0-100) of the seed pixel's color. When
 * `respectAlphaLock` is true, only already-opaque pixels are eligible —
 * matching how Alpha Lock constrains brush painting elsewhere in the engine.
 * Returns whether anything was actually filled.
 *
 * `sampleImageData`, when given, is used INSTEAD of `ctx`'s own pixels for
 * every boundary decision (the seed color and every neighbor's "does this
 * match" check) — ibis Paint's "reference: all layers" fill mode, for
 * exactly the annoyance it exists to fix: line art often lives on a
 * different layer than the flat color you're filling onto, so filling
 * against the active layer alone sees no boundary at all and floods the
 * whole layer. The actual paint deposit and the Alpha Lock check both still
 * always target `ctx` itself — only which layer's content COUNTS AS a
 * boundary changes, never which layer gets painted.
 */
export function floodFillCanvas(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  color: FillColor,
  tolerance: number,
  respectAlphaLock: boolean,
  sampleImageData?: ImageData
): boolean {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return false;

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  // Every "does this pixel match" check compares against the pixel's
  // ORIGINAL color, not the mutated output — otherwise a fill color close to
  // the seed color would let the fill leak past its own already-painted
  // pixels as it goes, corrupting the region boundary. `active` is always
  // this layer's own pre-fill pixels — used for the Alpha Lock gate (a
  // property of the layer actually being painted) regardless of where
  // boundary matching itself reads from.
  const active = new Uint8ClampedArray(data);
  const sample = sampleImageData ? sampleImageData.data : active;

  const idx = (x: number, y: number) => (y * width + x) * 4;
  const seedI = idx(startX, startY);
  const seedR = sample[seedI];
  const seedG = sample[seedI + 1];
  const seedB = sample[seedI + 2];
  const seedA = sample[seedI + 3];

  if (respectAlphaLock && active[seedI + 3] === 0) return false;

  // tolerance 0-100 -> sum-of-channel-abs-diff threshold (0-1020 max range).
  const tol = (Math.max(0, Math.min(100, tolerance)) / 100) * 1020;

  const matches = (x: number, y: number): boolean => {
    const i = idx(x, y);
    if (respectAlphaLock && active[i + 3] === 0) return false;
    const d =
      Math.abs(sample[i] - seedR) +
      Math.abs(sample[i + 1] - seedG) +
      Math.abs(sample[i + 2] - seedB) +
      Math.abs(sample[i + 3] - seedA);
    return d <= tol;
  };

  const visited = new Uint8Array(width * height);
  const setPixel = (x: number, y: number) => {
    const i = idx(x, y);
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
    data[i + 3] = color.a;
    visited[y * width + x] = 1;
  };

  if (!matches(startX, startY)) return false;

  const stack: [number, number][] = [[startX, startY]];
  let filledAny = false;

  while (stack.length) {
    const next = stack.pop()!;
    const sx = next[0];
    const sy = next[1];
    if (visited[sy * width + sx]) continue;
    if (!matches(sx, sy)) continue;

    let lx = sx;
    while (lx > 0 && !visited[sy * width + (lx - 1)] && matches(lx - 1, sy)) lx--;
    let rx = sx;
    while (rx < width - 1 && !visited[sy * width + (rx + 1)] && matches(rx + 1, sy)) rx++;

    for (let x = lx; x <= rx; x++) setPixel(x, sy);
    filledAny = true;

    const scanRow = (y: number) => {
      if (y < 0 || y >= height) return;
      let inSpan = false;
      for (let x = lx; x <= rx; x++) {
        const already = visited[y * width + x];
        const isMatch = !already && matches(x, y);
        if (isMatch && !inSpan) {
          stack.push([x, y]);
          inSpan = true;
        } else if (!isMatch) {
          inSpan = false;
        }
      }
    };
    scanRow(sy - 1);
    scanRow(sy + 1);
  }

  if (filledAny) ctx.putImageData(imgData, 0, 0);
  return filledAny;
}
