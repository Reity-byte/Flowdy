// src/engine/brushEngine.ts
import type { BrushSettings, Point, PointerBrushSample } from "./brushTypes";
import { hexToRgb as parseHexColor } from "../lib/color";
import mixbox from "mixbox";

export type BrushEngineTuning = {
  /** Stroke correction strength, 0 (no correction) to 10 (maximum) — see HighPerformanceBrushStroke's class doc comment for how this is applied (a post-stroke recalculation on release, not a live per-move filter). */
  stabilization: number;
  predictionMs: number;
  predictionBlend: number;
  velocityThinning: number;
  referenceSpeed: number;
  minWidthScale: number;
  pressureCurveGamma: number;
  smoothingWindow: number;
};

export const DEFAULT_BRUSH_TUNING: BrushEngineTuning = {
  stabilization: 4,
  predictionMs: 22,
  predictionBlend: 0.45,
  velocityThinning: 0.4,
  referenceSpeed: 2000,
  minWidthScale: 0.15,
  pressureCurveGamma: 0.85,
  smoothingWindow: 10,
};

function normalizedPressure(sample: PointerBrushSample): number {
  if (sample.pointerType === "pen") {
    return sample.pressure;
  }
  return 1;
}

/** Applies a gamma curve to a normalized [0,1] pressure value; gamma is clamped to [0.2, 3]. */
export function applyPressureCurve(normalized: number, gamma: number): number {
  const g = Math.max(0.2, Math.min(3, gamma));
  return Math.pow(Math.min(1, Math.max(0, normalized)), g);
}

function hypot(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

/**
 * Alpha-weighted average color of a small square neighborhood of `ctx`
 * centered at (cx, cy) — used by Color Mix to sample "what's underneath and
 * to the sides" of the brush tip, like ibis Paint's color mixing, instead of
 * a single noisy pixel. Fully-transparent pixels don't contribute to the
 * average; returns null if the whole neighborhood is transparent (nothing to
 * mix with).
 */
function sampleAreaColor(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number
): { r: number, g: number, b: number } | null {
  const size = Math.max(1, Math.round(radius * 2));
  const x0 = Math.round(cx - size / 2);
  const y0 = Math.round(cy - size / 2);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, size, size).data;
  } catch (e) {
    return null;
  }

  let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a <= 10) continue;
    rSum += data[i] * a;
    gSum += data[i + 1] * a;
    bSum += data[i + 2] * a;
    aSum += a;
  }
  if (aSum <= 0) return null;
  return { r: rSum / aSum, g: gSum / aSum, b: bSum / aSum };
}

/** Thins the stroke width as pointer speed approaches `tuning.referenceSpeed`, down to `tuning.minWidthScale`. */
export function velocityWidthScale(speedPxPerSec: number, tuning: BrushEngineTuning): number {
  if (tuning.velocityThinning <= 0) return 1;
  const u = Math.min(1, speedPxPerSec / Math.max(1, tuning.referenceSpeed));
  const thin = tuning.minWidthScale;
  const k = tuning.velocityThinning;
  return 1 - k * u * (1 - thin);
}

/** Queues a single brush dab at (x, y) using a cached radial-gradient stamp. Drawing is batched via enqueueDraw unless immediate mode is on. */
/**
 * Draws a single dab into `ctx` — always the per-stroke wet buffer, never the
 * real layer directly (see `HighPerformanceBrushStroke`'s recomposite step,
 * which is what actually applies the `opacity` ceiling). `dabOpacity` here is
 * purely Flow (`settings.intensity`): how strongly one dab lays down paint
 * into the buffer, independent of how strong the whole stroke may ever look.
 * Both eraser and paint dabs use plain `source-over` (an eraser's dabs are
 * building an alpha *mask* in the buffer, not erasing anything themselves —
 * the mask is applied via `destination-out` at recomposite time).
 */
export function paintDab(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  settings: BrushSettings,
  sizeScale = 1,
  opacityScale = 1,
  activeColor?: { r: number, g: number, b: number }
): void {
  const effSize = settings.size * sizeScale;
  if (effSize < 0.1) return;
  // Use cached stamp canvases to avoid creating radial gradients every dab.
  const hardness = settings.brushStyle === "pen" ? 1 : Math.min(1, Math.max(0, settings.hardness));

  const dabOpacity = Math.min(1, Math.max(0, settings.intensity)) * opacityScale;

  const color = activeColor || parseHexColor(settings.color);

  const stamp = getStamp({
    size: Math.max(1, Math.round(effSize)),
    hardness,
    brushStyle: settings.brushStyle,
    isEraser: settings.isEraser,
    color,
  });

  // Enqueue actual draw operations to batch them into RAF frames.
  enqueueDraw(() => {
    try {
      ctx.save();
      ctx.globalCompositeOperation = (!settings.isEraser && settings.brushStyle === 'marker') ? 'multiply' : 'source-over';
      ctx.globalAlpha = dabOpacity;

      const sw = stamp.width;
      const sh = stamp.height;
      ctx.drawImage(stamp, x - sw / 2, y - sh / 2, sw, sh);
      ctx.restore();
    } catch (e) {
      // swallow drawing errors
    }
  });
}

// Stamp cache keyed by size/style/color/hardness. Capped with FIFO eviction:
// colorMix drifts the wet color continuously during a stroke, so long
// mixing strokes would otherwise mint a new stamp canvas every ~80ms forever.
const STAMP_CACHE_LIMIT = 512;
const stampCache = new Map<string, HTMLCanvasElement>();

function stampKey(opts: { size: number; hardness: number; brushStyle: string; isEraser: boolean; color: { r: number; g: number; b: number } }) {
  return `${opts.brushStyle}|${opts.isEraser ? 'e' : 'n'}|${opts.size}|${Math.round(opts.hardness * 100)}|${Math.round(opts.color.r)}-${Math.round(opts.color.g)}-${Math.round(opts.color.b)}`;
}

function getStamp(opts: { size: number; hardness: number; brushStyle: string; isEraser: boolean; color: { r: number; g: number; b: number } }): HTMLCanvasElement {
  const key = stampKey(opts);
  const existing = stampCache.get(key);
  if (existing) return existing;

  const diameter = Math.max(1, Math.ceil(opts.size));
  const radius = diameter / 2;
  const canvas = document.createElement('canvas');
  // add 2px padding for antialiasing
  const pad = 4;
  canvas.width = diameter + pad * 2;
  canvas.height = diameter + pad * 2;
  const c = canvas.getContext('2d');
  if (!c) return canvas;

  // center
  c.translate(canvas.width / 2, canvas.height / 2);

  if (opts.brushStyle === 'marker') {
    c.rotate(Math.PI / 4);
    c.scale(1, 0.3);
  }

  const innerStop = opts.hardness;
  // Gradient always fades to fully transparent at the rim; `hardness` only
  // controls where the fade begins (innerStop), not how far it goes.
  const innerAlpha = 1;
  const outerAlpha = 0;

  const grad = c.createRadialGradient(0, 0, 0, 0, 0, radius);
  if (opts.isEraser) {
    grad.addColorStop(0, `rgba(0,0,0,${innerAlpha})`);
    grad.addColorStop(innerStop, `rgba(0,0,0,${innerAlpha})`);
    grad.addColorStop(1, `rgba(0,0,0,${outerAlpha})`);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fill();
  } else if (opts.brushStyle === 'textured') {
    // A genuinely different stroke algorithm, not just a hardness/color
    // preset on the same smooth radial-gradient stamp every other paint
    // style shares (Section 12.2's ask — the existing round/pen/marker
    // styles were pixel-identical modulo parameters). Same soft falloff as
    // the base, then irregular bristle-shaped gaps are cut out of it so the
    // edge reads as grainy/textured instead of a perfectly smooth fade.
    const { r, g, b } = opts.color;
    grad.addColorStop(0, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${innerAlpha})`);
    grad.addColorStop(innerStop, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${innerAlpha})`);
    grad.addColorStop(1, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${outerAlpha})`);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fill();

    // Seeded PRNG (mulberry32-style) keyed off the stamp's own params, so a
    // given size/hardness/color always regenerates the same bristle
    // pattern — a brush's texture shouldn't visibly change just because its
    // cache entry got evicted and rebuilt.
    let seed = (Math.round(radius * 97) ^ Math.round(opts.hardness * 1009) ^ (Math.round(r) << 16) ^ (Math.round(g) << 8) ^ Math.round(b)) >>> 0;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    c.globalCompositeOperation = 'destination-out';
    c.lineCap = 'round';
    const bristleCount = Math.max(14, Math.round(radius * 1.4));
    for (let i = 0; i < bristleCount; i++) {
      const angle = rand() * Math.PI * 2;
      const len = radius * (0.35 + rand() * 0.65);
      c.lineWidth = 0.5 + rand() * 1.6;
      c.strokeStyle = `rgba(0,0,0,${0.25 + rand() * 0.5})`;
      c.beginPath();
      c.moveTo(Math.cos(angle) * radius * 0.15, Math.sin(angle) * radius * 0.15);
      c.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
  } else {
    const { r, g, b } = opts.color;
    grad.addColorStop(0, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${innerAlpha})`);
    grad.addColorStop(innerStop, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${innerAlpha})`);
    grad.addColorStop(1, `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${outerAlpha})`);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fill();
  }

  if (stampCache.size >= STAMP_CACHE_LIMIT) {
    // Map iteration order is insertion order, so this evicts the oldest entry (FIFO).
    const oldestKey = stampCache.keys().next().value;
    if (oldestKey !== undefined) stampCache.delete(oldestKey);
  }
  stampCache.set(key, canvas);
  return canvas;
}

/**
 * Smudge tool only: a soft round falloff weight (0-1) per pixel, extracted
 * from a `getStamp()` mask canvas's own alpha channel — reuses the same
 * radial falloff every other style already renders, instead of computing a
 * second copy of the same gradient math by hand. Memoized per stamp canvas
 * (which is itself already cached by size/hardness in `stampCache`), so the
 * one-time `getImageData` cost is paid once per unique dab size, not once
 * per dab.
 */
const maskWeightCache = new WeakMap<HTMLCanvasElement, Float32Array>();
function getMaskWeights(maskStamp: HTMLCanvasElement): Float32Array {
  const cached = maskWeightCache.get(maskStamp);
  if (cached) return cached;
  const mctx = maskStamp.getContext('2d');
  const weights = new Float32Array(maskStamp.width * maskStamp.height);
  if (mctx) {
    const img = mctx.getImageData(0, 0, maskStamp.width, maskStamp.height);
    for (let i = 0; i < weights.length; i++) weights[i] = img.data[i * 4 + 3] / 255;
  }
  maskWeightCache.set(maskStamp, weights);
  return weights;
}

// Drawing queue to batch draw calls into requestAnimationFrame
const drawQueue: Array<() => void> = [];
let drawRaf: number | null = null;
let immediateMode = false;

function enqueueDraw(fn: () => void) {
  if (immediateMode) {
    try { fn(); } catch (e) {}
    return;
  }
  drawQueue.push(fn);
  if (drawRaf === null) {
    drawRaf = requestAnimationFrame(() => {
      const q = drawQueue.splice(0, drawQueue.length);
      drawRaf = null;
      for (const f of q) {
        try { f(); } catch (e) {}
      }
    });
  }
}

// Flush any queued draw operations synchronously (useful before starting a new stroke)
export function flushDrawQueue(): void {
  if (drawRaf !== null) {
    try { cancelAnimationFrame(drawRaf); } catch(e) {}
    drawRaf = null;
  }
  const q = drawQueue.splice(0, drawQueue.length);
  for (const f of q) {
    try { f(); } catch (e) {}
  }
}

/** Toggles whether paintDab draws synchronously instead of batching into requestAnimationFrame. DocumentCanvas enables this for the duration of a stroke to avoid a frame of lag between pointer events and pixels. */
export function setImmediateMode(enabled: boolean) {
  immediateMode = !!enabled;
  if (immediateMode) {
    // If enabling immediate mode, flush any queued draws first
    flushDrawQueue();
  }
}

/** Paints one dab at (x, y); `sizeMul` and `taper` are separate factors whose product is the total size scale (matches paintDab's `sizeScale`) — kept apart so callers like the blur painter can use `taper` alone for effects that don't multiply cleanly through paintDab. */
type DabPainter = (x: number, y: number, sizeMul: number, taper: number) => void;

/**
 * Renders a small thumbnail of what this preset's brush actually looks like
 * along a fixed wavy stroke — reuses `paintDab`/`getStamp`, the exact same
 * rendering path the real canvas uses, so the preview can never be
 * misleading (Section 12.3's "buildable approach"). Only meaningful for
 * paint styles that stamp a fixed color (`round`/`pen`/`marker`/`textured`)
 * — `blur`/`smudge` are content-dependent (they rework whatever's already
 * on the canvas) and have no presets in the picker this feeds, so they're
 * not handled here.
 */
export function renderBrushPreview(
  settings: Pick<BrushSettings, "size" | "hardness" | "color" | "brushStyle" | "opacity" | "intensity">,
  width = 140,
  height = 40,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  // Preview brush size is capped to the thumbnail's own height so a large
  // brush setting doesn't just fill the whole strip solid.
  const previewSize = Math.max(3, Math.min(settings.size, height * 0.7));
  const color = parseHexColor(settings.color);
  const dabSettings: BrushSettings = {
    size: previewSize,
    hardness: settings.hardness,
    opacity: 1,
    color: settings.color,
    isEraser: false,
    intensity: Math.max(0.5, settings.intensity),
    startTaper: 0,
    endTaper: 0,
    colorMix: 0,
    brushStyle: settings.brushStyle,
    alphaLocked: false,
    smudgeStrength: 0,
  };

  const wasImmediate = immediateMode;
  setImmediateMode(true);
  const margin = previewSize * 0.6;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = margin + t * (width - margin * 2);
    const y = height / 2 + Math.sin(t * Math.PI * 2.2) * (height * 0.22);
    paintDab(ctx, x, y, dabSettings, 1, 1, color);
  }
  setImmediateMode(wasImmediate);

  return canvas;
}

function stampAlongSegment(
  from: Point,
  to: Point,
  settings: BrushSettings,
  pressureScale: number,
  velocityScale: number,
  currentLength: number,
  updateLength: (newLen: number) => void,
  drawDab: DabPainter
): void {
  const dist = hypot(to.x - from.x, to.y - from.y);
  const effSize = settings.size * pressureScale * velocityScale;

  // OPRAVA KORÁLKŮ: Změněno z 0.1 na 0.05 a minimum na 0.2
  // Tím je čára mnohem hustší a konce se "nerozpadnou" na tečky
  const spacing = Math.max(0.2, effSize * 0.05);
  const steps = Math.max(1, Math.ceil(dist / spacing));
  const sizeMul = pressureScale * velocityScale;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const dabLength = currentLength + dist * t;

    let taper = 1;
    if (settings.startTaper > 0 && dabLength < settings.startTaper) {
      const ratio = dabLength / settings.startTaper;
      taper = Math.pow(ratio, 1.5);
    } else {
      const introDist = Math.max(2, settings.size * 0.25);
      if (dabLength < introDist) {
        taper = 0.2 + 0.8 * (dabLength / introDist);
      }
    }

    drawDab(x, y, sizeMul, taper);
  }
  updateLength(currentLength + dist);
}

function quadPoint(p0: Point, p1: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function quadLength(p0: Point, p1: Point, p2: Point, segments = 12): number {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= segments; i++) {
    const p = quadPoint(p0, p1, p2, i / segments);
    len += hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

function stampAlongQuadratic(
  p0: Point, p1: Point, p2: Point,
  settings: BrushSettings,
  pressureScale: number,
  velocityAtU: (u: number) => number,
  currentLength: number,
  updateLength: (newLen: number) => void,
  drawDab: DabPainter
): void {
  const arc = Math.max(1, quadLength(p0, p1, p2, 16));
  const effBase = settings.size * pressureScale;
  const spacing = Math.max(0.5, effBase * 0.1);
  const steps = Math.max(2, Math.ceil(arc / spacing));

  let prev = p0;
  let cl = currentLength;

  for (let i = 1; i <= steps; i++) {
    const u = i / steps;
    const p = quadPoint(p0, p1, p2, u);
    const vs = velocityAtU(u);

    stampAlongSegment(prev, p, settings, pressureScale, vs, cl, (nl) => cl = nl, drawDab);
    prev = p;
  }
  updateLength(cl);
}

/** Fills in the `isEraser` flag from the active tool so callers don't have to. */
export function brushSettingsForTool(
  base: Omit<BrushSettings, "isEraser">,
  tool: "brush" | "eraser",
): BrushSettings {
  return { ...base, isEraser: tool === "eraser" } as BrushSettings;
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * One box-blur pass over a flat `w*h` channel array, via a sliding-window
 * sum (O(w*h) total, independent of `radius`) rather than re-summing the
 * whole window at every pixel. Clamp-to-edge boundary handling (out-of-
 * range samples reuse the nearest in-range one) — used by Blur's
 * `blurPatchInPlace`, see that method's doc comment for why this replaced
 * Canvas 2D's `filter: blur()`. `horizontal` selects whether each pass blurs
 * along rows (stride 1) or columns (stride `w`); `src` and `dst` must be
 * different arrays.
 */
function boxBlurPass(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, horizontal: boolean): void {
  const windowSize = radius * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const idx = Math.min(w - 1, Math.max(0, i));
        sum += src[rowOff + idx];
      }
      for (let x = 0; x < w; x++) {
        dst[rowOff + x] = sum / windowSize;
        const addIdx = Math.min(w - 1, Math.max(0, x + radius + 1));
        const subIdx = Math.min(w - 1, Math.max(0, x - radius));
        sum += src[rowOff + addIdx] - src[rowOff + subIdx];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        const idx = Math.min(h - 1, Math.max(0, i));
        sum += src[idx * w + x];
      }
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = sum / windowSize;
        const addIdx = Math.min(h - 1, Math.max(0, y + radius + 1));
        const subIdx = Math.min(h - 1, Math.max(0, y - radius));
        sum += src[addIdx * w + x] - src[subIdx * w + x];
      }
    }
  }
}

/**
 * Stateful single-stroke smoother/renderer. Callers drive it through the
 * pointer lifecycle: down() on pointerdown, move() on each pointermove, and
 * flush() on pointerup to finish the tail. It owns the running smoothing/
 * prediction/wet-color state for one stroke; call reset() (or down() again)
 * to start a new one.
 *
 * Stroke correction (`tuning.stabilization`, 0-10) is a POST-stroke
 * recalculation, not a live per-move filter: move() stamps dabs from the
 * raw pointer position directly (no artificial lag), so the live preview
 * always tracks the actual input immediately. Every raw sample is also
 * recorded (`rawSamples`); once flush() finishes the raw pass, if
 * stabilization > 0 it averages that recorded path with a window sized by
 * the stabilization level and REPLAYS the entire stroke against that
 * smoothed path — clearing `wetBuffer` and re-stamping from `preStroke`
 * (untouched by the raw pass) — before a final recomposite() bakes the
 * corrected result in, replacing the raw preview. This trades a moment of
 * post-release recalculation for zero smoothing cost while the hand is
 * actually moving, which is the more expensive, continuous part of drawing.
 */
export class HighPerformanceBrushStroke {
  private tuning: BrushEngineTuning;
  private smooth: Point | null = null;
  private rawLast: PointerBrushSample | null = null;
  private vel = { x: 0, y: 0 };
  private smoothedSpeed = 0;
  private lastDrawn: Point | null = null;
  private strokePoints: Point[] = [];
  private quadStarted = false;
  private strokeLength = 0;
  /** Unit velocity direction from the previous move(), used to damp prediction through sharp turns (see move()). */
  private prevDir: { x: number, y: number } | null = null;

  private wetColor: { r: number, g: number, b: number } | null = null;
  private lastColorSamplePos: Point | null = null;

  // Stabilization (post-stroke correction) support. `rawSamples` records
  // every real pointer sample for the CURRENT stroke (down()'s + each
  // move()'s), consumed once by flush() to build a smoothed replay path —
  // see the class doc comment. `replaying` guards the replay pass itself:
  // it drives move()'s own logic (via advance()) and finishes via a second
  // call to flush(), so it must not record samples or re-trigger another
  // round of stabilization on top of itself.
  private rawSamples: PointerBrushSample[] = [];
  private replaying = false;

  // Per-stroke scratch buffers (pooled across strokes, resized in place when
  // the active layer's dimensions change). `preStroke` is a snapshot of the
  // layer taken on down() — the ground truth for "what's actually underneath"
  // that color-mix sampling reads from and that every recomposite starts
  // fresh from, so a stroke's total visual contribution can never exceed
  // `opacity` no matter how saturated the wet buffer's own alpha gets from
  // overlapping dabs. `wetBuffer` accumulates this stroke's dabs at Flow
  // (`intensity`) strength, uncapped — that compounding is expected and is
  // what makes Flow feel like a rate rather than a ceiling.
  private preStroke: HTMLCanvasElement | null = null;
  private preCtx: CanvasRenderingContext2D | null = null;
  private wetBuffer: HTMLCanvasElement | null = null;
  private wetCtx: CanvasRenderingContext2D | null = null;

  // Blur tool only: reusable scratch for stampBlurDab's actual-pixel blur,
  // masked to a soft round falloff before being stamped. The blur itself is
  // a hand-rolled separable box blur over raw pixel data (see
  // blurPatchInPlace/boxBlurPass below), not Canvas 2D's `filter: blur()` —
  // see todo.md Section 15: that CSS-filter API is well known to fall back
  // to a slow, non-GPU-accelerated per-pixel path on Android WebView, and it
  // ran once per dab (dozens per stroke), which was the leading suspect for
  // a reported freeze while drawing a Blur stroke on Android.
  private blurScratch: HTMLCanvasElement | null = null;
  private blurScratchCtx: CanvasRenderingContext2D | null = null;
  // Pooled scratch buffers for blurPatchInPlace, resized (grown only) as
  // needed instead of allocated fresh every dab, to keep this hot path free
  // of per-dab GC churn.
  private blurBufR: Float32Array | null = null;
  private blurBufG: Float32Array | null = null;
  private blurBufB: Float32Array | null = null;
  private blurBufA: Float32Array | null = null;
  private blurBufR2: Float32Array | null = null;
  private blurBufG2: Float32Array | null = null;
  private blurBufB2: Float32Array | null = null;
  private blurBufA2: Float32Array | null = null;
  /** The last position `stampBlurDab` actually ran a blur computation at — a throttle gate (unlike Smudge's identically-named field, which is a pure motion-vector reference with no gate). Safe to throttle here because Blur always reads from the static `preStroke` snapshot, never from its own prior output, so skipping sub-steps only coarsens dab spacing along the path, not an accumulation/feedback effect. Reset at both down() and beginReplayPass(). */
  private blurLastPos: Point | null = null;

  // Smudge tool only. Two structural properties, both deliberate and both
  // load-bearing for what a real smudge/drag has to look like:
  //
  // (1) No canvas-composite stacking (destination-out/source-over layering)
  //     — every earlier attempt at this tool in this codebase's history was
  //     built that way and repeatedly produced hard-to-predict artifacts (a
  //     light centerline, an infinite "soliton" trail, 8-bit rounding
  //     stalls) that took whole sessions each to even understand. This
  //     version is a single explicit numeric lerp per pixel per step,
  //     computed directly in JS against raw `ImageData` arrays.
  //
  // (2) No independently-carried "stamp." There is deliberately no
  //     `smudgeAccum`-style buffer holding its own patch of color that gets
  //     composited as a fixed shape at intervals along the path. That
  //     design (present in this file's own previous version of this tool)
  //     is a stamp loop wearing different clothes: reapplying the same soft
  //     round falloff at discrete points produces the same overlapping-
  //     stamp banding a visible brush stroke would, even done as an
  //     explicit per-pixel lerp instead of a canvas composite call — a
  //     brighter seam where consecutive applications overlap most, a
  //     periodic ridge where they overlap least. Real smudge output is
  //     continuous pixel relocation, not a sequence of soft-edged patches.
  //     So `stampSmudgeDab` (kept as a name only because it's still called
  //     once per sub-step by the shared stamping loop) has no carried
  //     memory of its own: each call reads the LIVE `smudgeSurface` at an
  //     offset backward along the actual distance moved since the previous
  //     call, and blends it forward into the current position. The surface
  //     itself is the only memory; there is nothing else around to leave a
  //     stamp-shaped mark. `smudgeMaskWeights` (the dab's own soft round
  //     falloff, reused from `getStamp`'s cached mask) still exists, but
  //     only as the brush's edge shape — the same role a normal paint
  //     brush's mask plays — never as a second, independently-persisting
  //     patch.
  private smudgeSurface: HTMLCanvasElement | null = null;
  private smudgeSurfaceCtx: CanvasRenderingContext2D | null = null;
  private smudgeMaskWeights: Float32Array | null = null;
  private smudgeDabSize = 0;
  /** The last pointer position `stampSmudgeDab` actually processed — purely to compute the real motion vector each call drags along (`x - smudgeLastPos.x`, etc.), NOT a throttle gate (there isn't one; see the class field doc above for why a throttled stamp loop is exactly the bug this replaced). Reset at both down() and beginReplayPass() so the stabilization replay's jump back to the stroke's start is never read as one giant drag. */
  private smudgeLastPos: Point | null = null;
  // Performance: `stampSmudgeDab` runs once per ~5%-of-brush-size sub-step
  // with no throttle (by design — see above), which on a real stroke is
  // dozens to hundreds of calls. The first version of this (this session)
  // had every one of those calls do a `getImageData` + `putImageData`
  // round trip through the actual canvas — each individually reasonable,
  // but measured live at ~4-5 THOUSAND such calls for one ordinary stroke,
  // totaling multiple seconds of blocked main-thread time (profiled via
  // documentEngineRef + instrumented getImageData/putImageData, see the
  // performance-pass Alpha Log entry). `smudgeData` fixes this by being the
  // ONLY thing `stampSmudgeDab` actually reads/writes during a stroke: a
  // plain `Uint8ClampedArray` the same size as the canvas, read/written via
  // ordinary JS array indexing (fast, no browser/GPU round trip at all).
  // `smudgeSurface`'s actual canvas is left untouched by every individual
  // dab and only synced from `smudgeData` — via `syncSmudgeSurface()`,
  // using a dirty-rectangle `putImageData` so only the region that actually
  // changed gets uploaded — right before `recomposite()` needs to read it,
  // which is already coalesced to at most once per animation frame by the
  // caller. This is a pure representation change: every index formula
  // below is unchanged from the getImageData-based version (including its
  // exact write footprint, bug-for-bug), so a stroke's resulting pixels are
  // identical either way — only how often the canvas itself gets touched
  // changes.
  private smudgeData: Uint8ClampedArray | null = null;
  private smudgeImageData: ImageData | null = null;
  private smudgeDirty: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  constructor(tuning: Partial<BrushEngineTuning> = {}) {
    this.tuning = { ...DEFAULT_BRUSH_TUNING, ...tuning };
  }

  private ensureBuffers(w: number, h: number): void {
    if (!this.preStroke) {
      this.preStroke = document.createElement('canvas');
      // Written once per stroke (the down() snapshot) but read many times per
      // stroke via getImageData (sampleAreaColor, for Color Mix) — hinting
      // willReadFrequently keeps this canvas software-backed from the start,
      // avoiding a GPU→CPU sync stall on every one of those reads.
      this.preCtx = this.preStroke.getContext('2d', { willReadFrequently: true });
    }
    if (!this.wetBuffer) {
      this.wetBuffer = document.createElement('canvas');
      // Write-heavy (every dab) and only ever read via drawImage (never
      // getImageData), so it should stay GPU-accelerated — no
      // willReadFrequently here.
      this.wetCtx = this.wetBuffer.getContext('2d');
    }
    // Resizing a canvas clears it, which is fine — down() overwrites both
    // buffers' contents immediately after this call.
    if (this.preStroke.width !== w || this.preStroke.height !== h) {
      this.preStroke.width = w;
      this.preStroke.height = h;
    }
    if (this.wetBuffer.width !== w || this.wetBuffer.height !== h) {
      this.wetBuffer.width = w;
      this.wetBuffer.height = h;
    }
  }

  /** Redraws `ctx` (the real layer) as `preStroke, then wetBuffer at globalAlpha = opacity` — the step that makes Opacity an actual ceiling on Flow's buildup. Public so the caller can coalesce it to animation-frame rate during move() (see DocumentCanvas.scheduleRecomposite) instead of once per pointer event. */
  recomposite(ctx: CanvasRenderingContext2D, settings: BrushSettings): void {
    if (!this.preStroke || !this.wetBuffer) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const opacity = Math.min(1, Math.max(0, settings.opacity));
    // Smudge doesn't accumulate dabs in wetBuffer — its result IS the live
    // smudgeSurface (see stampSmudgeDab). Present it as preStroke with the
    // surface layered on top at `opacity`, so the Opacity slider still
    // reads as "how much of the smudge shows", and Alpha Lock still
    // confines any alpha the smudge dragged around to already-painted
    // areas.
    if (settings.brushStyle === 'smudge') {
      if (!this.smudgeSurface) return;
      this.syncSmudgeSurface();
      try {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        if (opacity >= 1 && !settings.alphaLocked) {
          ctx.drawImage(this.smudgeSurface, 0, 0);
        } else {
          ctx.drawImage(this.preStroke, 0, 0);
          ctx.globalCompositeOperation = settings.alphaLocked ? 'source-atop' : 'source-over';
          ctx.globalAlpha = opacity;
          ctx.drawImage(this.smudgeSurface, 0, 0);
        }
        ctx.restore();
      } catch (e) {
        // swallow drawing errors
      }
      return;
    }
    try {
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(this.preStroke, 0, 0);
      // Alpha Lock (ibis Paint/Photoshop "Lock Transparent Pixels"): clip new
      // paint to pixels that already have content via 'source-atop' instead
      // of 'source-over', so painting never extends into transparent areas.
      // Doesn't apply to erasing — removing existing alpha is still allowed,
      // only *adding* alpha to blank areas is locked.
      ctx.globalCompositeOperation = settings.isEraser
        ? 'destination-out'
        : (settings.alphaLocked ? 'source-atop' : 'source-over');
      ctx.globalAlpha = opacity;
      ctx.drawImage(this.wetBuffer, 0, 0);
      ctx.restore();
    } catch (e) {
      // swallow drawing errors
    }
  }

  /**
   * Fills `this.blurBufR/G/B/A` (pooled scratch, grown via ensureBlurBuffers)
   * with `img`'s pixels premultiplied by alpha, so blurring near a
   * transparent edge doesn't pull in whatever arbitrary RGB a fully-
   * transparent pixel happens to hold.
   */
  private ensureBlurBuffers(n: number): void {
    if (!this.blurBufR || this.blurBufR.length < n) {
      this.blurBufR = new Float32Array(n);
      this.blurBufG = new Float32Array(n);
      this.blurBufB = new Float32Array(n);
      this.blurBufA = new Float32Array(n);
      this.blurBufR2 = new Float32Array(n);
      this.blurBufG2 = new Float32Array(n);
      this.blurBufB2 = new Float32Array(n);
      this.blurBufA2 = new Float32Array(n);
    }
  }

  /**
   * Blurs `img` in place using a 3-pass separable box blur (a standard,
   * cheap approximation of a Gaussian blur — each box pass has variance
   * `((2r+1)^2-1)/12`, and three of them summed approximates a true
   * Gaussian's bell curve closely enough to read as "soft blur," not
   * "boxy") over raw `Uint8ClampedArray` pixel data — replaces the previous
   * Canvas 2D `filter: blur()` implementation (see stampBlurDab's own doc
   * comment for why). Each box pass is O(width*height) via a sliding-window
   * sum (add the new edge pixel, subtract the one that fell out of the
   * window), not O(width*height*radius), so it stays cheap even at a large
   * blur radius.
   */
  private blurPatchInPlace(img: ImageData, radius: number): void {
    const w = img.width;
    const h = img.height;
    const n = w * h;
    const data = img.data;
    this.ensureBlurBuffers(n);
    const pr = this.blurBufR!, pg = this.blurBufG!, pb = this.blurBufB!, pa = this.blurBufA!;
    const tr = this.blurBufR2!, tg = this.blurBufG2!, tb = this.blurBufB2!, ta = this.blurBufA2!;

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = data[o + 3];
      const af = a / 255;
      pr[i] = data[o] * af;
      pg[i] = data[o + 1] * af;
      pb[i] = data[o + 2] * af;
      pa[i] = a;
    }

    // 2 iterations of (horizontal pass, then vertical pass), each iteration
    // reading the previous one's output — a standard box-blur-approximates-
    // Gaussian technique. (3 iterations is the textbook choice for the
    // closest Gaussian match, but profiling on real dispatched strokes
    // showed 2 iterations already reads as a soft, non-boxy blur while
    // meaningfully cutting per-dab cost — see todo.md Section 15, this is a
    // performance-motivated fix, so the cheaper choice wins given both look
    // like a real blur.)
    for (let iter = 0; iter < 2; iter++) {
      boxBlurPass(pr, tr, w, h, radius, true);
      boxBlurPass(pg, tg, w, h, radius, true);
      boxBlurPass(pb, tb, w, h, radius, true);
      boxBlurPass(pa, ta, w, h, radius, true);

      boxBlurPass(tr, pr, w, h, radius, false);
      boxBlurPass(tg, pg, w, h, radius, false);
      boxBlurPass(tb, pb, w, h, radius, false);
      boxBlurPass(ta, pa, w, h, radius, false);
    }

    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = pa[i];
      if (a <= 0.5) {
        data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
        continue;
      }
      const inv = 255 / a;
      data[o] = Math.min(255, Math.max(0, pr[i] * inv));
      data[o + 1] = Math.min(255, Math.max(0, pg[i] * inv));
      data[o + 2] = Math.min(255, Math.max(0, pb[i] * inv));
      data[o + 3] = Math.min(255, Math.max(0, a));
    }
  }

  /**
   * Blur dab: takes the pixels *already at* (x, y) — from `preStroke`, read
   * once at stroke start so a stroke never feeds back on its own already-
   * blurred pixels — and stamps back an actually-blurred (a real per-pixel
   * box/gaussian blur, not a flat fill) copy of that same patch, masked to a
   * soft round falloff.
   *
   * This replaced an earlier version that sampled one alpha-weighted
   * *average* color for the whole dab (`sampleAreaColor`, the same helper
   * Color Mix uses) and flat-filled a gradient stamp with it. That behaved
   * like painting with "the nearest average color" — a flat colored blob —
   * rather than blurring: it destroyed detail inside the dab instead of
   * softening it, and looked like coloring, not blurring, exactly as
   * reported. A real blur has to vary per pixel (edges get softer, not
   * replaced by one solid tone), which needs an actual blur over the patch,
   * not a single sampled value.
   *
   * **Perf (todo.md Section 15 — reported Blur freezes the app while
   * drawing on Android):** this used to set `bctx.filter = blur(px)` (Canvas
   * 2D's CSS-filter API) and `drawImage` through it once per dab. That API
   * is well known to fall back to a slow, non-GPU-accelerated per-pixel
   * path on Android WebView (unlike desktop Chrome/Safari, where it's
   * usually GPU-accelerated and cheap) — and `DocumentCanvas` runs every
   * dab of an active stroke synchronously (`setImmediateMode(true)` for the
   * stroke's duration), so dozens of slow filter calls in a row, with zero
   * yielding back to the browser between them, reads exactly as "frozen."
   * Fixed two ways, per the todo's own "both together is most robust"
   * conclusion:
   * 1. The blur itself is now a hand-rolled box blur over raw pixel data
   *    (`blurPatchInPlace`, pure typed-array math, no CSS filter, no GPU
   *    fallback path to hit).
   * 2. A distance-gated throttle (`blurLastPos`) skips sub-steps that
   *    haven't moved far enough since the last one actually processed,
   *    cutting the number of blur computations per stroke — safe here
   *    specifically because Blur always reads from the static `preStroke`
   *    snapshot rather than its own prior output, so coarser spacing only
   *    means coarser dab spacing along the path, not a feedback bug (unlike
   *    Smudge, where an analogous throttle was tried and removed — see
   *    Session 10/11's Alpha Log entries — because Smudge's *output*
   *    is what the next dab reads, so skipping steps there compounds).
   */
  private stampBlurDab(x: number, y: number, sizeMul: number, taper: number, settings: BrushSettings): void {
    if (!this.wetCtx || !this.preStroke) return;
    const effSize = Math.max(1, Math.round(settings.size * sizeMul * taper));

    if (!this.blurLastPos) {
      this.blurLastPos = { x, y };
    } else {
      const dx = x - this.blurLastPos.x;
      const dy = y - this.blurLastPos.y;
      const minStep = Math.max(1, effSize * 0.15);
      if (dx * dx + dy * dy < minStep * minStep) return;
      this.blurLastPos = { x, y };
    }

    const maskStamp = getStamp({ size: effSize, hardness: settings.hardness, brushStyle: 'round', isEraser: false, color: { r: 0, g: 0, b: 0 } });
    const w = maskStamp.width;
    const h = maskStamp.height;

    const strength = Math.min(1, Math.max(0, settings.intensity)) * taper;
    if (strength <= 0) return;

    // Blur radius scales with the dab's own size — a bigger brush blurs a
    // proportionally bigger neighborhood per pass, matching how real blur
    // tools feel at different sizes.
    const blurPx = Math.max(0.5, Math.min(24, effSize * 0.18));

    try {
      if (!this.blurScratch) {
        this.blurScratch = document.createElement('canvas');
        this.blurScratchCtx = this.blurScratch.getContext('2d', { willReadFrequently: true });
      }
      if (this.blurScratch.width !== w || this.blurScratch.height !== h) {
        this.blurScratch.width = w;
        this.blurScratch.height = h;
      }
      const bctx = this.blurScratchCtx!;
      bctx.clearRect(0, 0, w, h);
      bctx.drawImage(this.preStroke, x - w / 2, y - h / 2, w, h, 0, 0, w, h);

      const img = bctx.getImageData(0, 0, w, h);
      this.blurPatchInPlace(img, Math.max(1, Math.round(blurPx)));
      bctx.putImageData(img, 0, 0);

      bctx.globalCompositeOperation = 'destination-in';
      bctx.drawImage(maskStamp, 0, 0);
      bctx.globalCompositeOperation = 'source-over';

      this.wetCtx.save();
      this.wetCtx.globalAlpha = strength;
      this.wetCtx.drawImage(this.blurScratch, x - w / 2, y - h / 2);
      this.wetCtx.restore();
    } catch (e) {
      // swallow drawing errors
    }
  }

  /**
   * Smudge dab: drags existing pixel content — it doesn't paint a patch.
   * For every pixel under the dab's soft round mask, blends the live
   * `smudgeSurface` at that pixel toward whatever was already on the
   * surface one step *behind* it — offset backward by the real distance
   * moved since the previous call (`smudgeLastPos` to `(x, y)`), bilinear-
   * sampled directly from the surface. There is no separate carried patch:
   * color only ever moves by being pulled forward from adjacent, already-
   * real canvas content, never copied from a fixed-shape buffer that gets
   * reapplied at intervals — that was the previous version of this tool,
   * and the source of the periodic ridge/seam artifact (see the class
   * field doc above for the full reasoning).
   *
   * Called once per sub-step of the shared stamping loop (`stampAlongSegment`
   * / `stampAlongQuadratic`, both ~5% of brush size apart) with NO throttle
   * — deliberately: skipping sub-steps to space applications further apart
   * is exactly the "stamp loop" shape this version exists to avoid. Because
   * every sub-step is processed and each one's own motion is genuinely
   * small (a few pixels, not a whole dab), consecutive applications overlap
   * almost completely instead of leaving gaps a ridge could form in — the
   * brightness profile along a stroke over flat content stays flat, not
   * periodic.
   *
   * Reads from an immutable snapshot of the region (`before`, copied once
   * per call) rather than the in-place buffer being written, so a pixel's
   * result never depends on which order this same call happens to visit
   * pixels in.
   *
   * Geometry (mask size) is still fixed for the whole stroke, set up once
   * in down() — taper/pressure modulate blend `strength` only, not the
   * footprint — for the same resampling-artifact reasons as the previous
   * version.
   */
  private stampSmudgeDab(x: number, y: number, taper: number, settings: BrushSettings): void {
    if (!this.smudgeSurface || !this.smudgeMaskWeights || !this.smudgeData) return;
    const size = this.smudgeDabSize;
    if (size <= 0) return;

    if (!this.smudgeLastPos) {
      this.smudgeLastPos = { x, y };
      return;
    }
    const dx = x - this.smudgeLastPos.x;
    const dy = y - this.smudgeLastPos.y;
    this.smudgeLastPos = { x, y };
    if (dx * dx + dy * dy < 0.0004) return; // sub-0.02px motion: nothing to drag

    const strength = Math.min(1, Math.max(0, settings.smudgeStrength))
      * Math.min(1, Math.max(0, settings.intensity))
      * taper;
    if (strength <= 0) return;

    const radius = size / 2;
    const px0 = Math.round(x - radius);
    const py0 = Math.round(y - radius);
    const surfW = this.smudgeSurface.width;
    const surfH = this.smudgeSurface.height;

    // Padded region: the dab footprint plus enough margin that backward-
    // sampling by (dx, dy) from any pixel in the footprint still lands
    // inside the region actually fetched. Unchanged from the previous
    // version — same rx0/ry0/rw/rh/offX/offY formulas, same bounds checks,
    // same resulting write footprint (see the class field doc for why that
    // matters: this is a pure performance change, not a geometry change).
    const pad = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) + 2;
    const rx0 = Math.max(0, px0 - pad);
    const ry0 = Math.max(0, py0 - pad);
    const rx1 = Math.min(surfW, px0 + size + pad);
    const ry1 = Math.min(surfH, py0 + size + pad);
    if (rx1 <= rx0 || ry1 <= ry0) return;
    const rw = rx1 - rx0;
    const rh = ry1 - ry0;

    // Snapshot just this call's padded region directly out of the
    // persistent full-surface buffer — a plain row-by-row in-memory copy,
    // not a canvas/GPU round trip (the previous version's `getImageData`
    // call here was the actual bottleneck: profiled at ~4-5k calls per
    // ordinary stroke). Copying into an immutable-for-this-call `before`
    // keeps the same "read from state prior to this call's own writes"
    // semantics the getImageData version had — necessary so a call's own
    // writes below can never feed back into its own backward-samples.
    const full = this.smudgeData;
    const before = new Uint8ClampedArray(rw * rh * 4);
    for (let ly = 0; ly < rh; ly++) {
      const srcStart = ((ry0 + ly) * surfW + rx0) * 4;
      before.set(full.subarray(srcStart, srcStart + rw * 4), ly * rw * 4);
    }

    const weights = this.smudgeMaskWeights;
    const offX = rx0 - px0;
    const offY = ry0 - py0;
    const sampled = new Float32Array(4);

    const sampleInto = (lx: number, ly: number, out: Float32Array): void => {
      const cx = Math.min(rw - 1.001, Math.max(0, lx));
      const cy = Math.min(rh - 1.001, Math.max(0, ly));
      const ix0 = Math.floor(cx), iy0 = Math.floor(cy);
      const ix1 = ix0 + 1, iy1 = iy0 + 1;
      const fx = cx - ix0, fy = cy - iy0;
      const i00 = (iy0 * rw + ix0) * 4, i10 = (iy0 * rw + ix1) * 4;
      const i01 = (iy1 * rw + ix0) * 4, i11 = (iy1 * rw + ix1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = before[i00 + c] * (1 - fx) + before[i10 + c] * fx;
        const bot = before[i01 + c] * (1 - fx) + before[i11 + c] * fx;
        out[c] = top * (1 - fy) + bot * fy;
      }
    };

    // Write directly into the persistent full-surface buffer at its global
    // index — the exact same global pixel `data[(py*rw+px)*4]` (from
    // `getImageData(rx0,ry0,rw,rh)`) used to refer to, just addressed
    // directly instead of through a region-sized copy.
    for (let ly = 0; ly < size; ly++) {
      const py = offY + ly;
      if (py < 0 || py >= rh) continue;
      for (let lx = 0; lx < size; lx++) {
        const px = offX + lx;
        if (px < 0 || px >= rw) continue;
        const w = weights[ly * size + lx] * strength;
        if (w <= 0.001) continue;
        sampleInto(px - dx, py - dy, sampled);
        const fullIdx = ((ry0 + py) * surfW + (rx0 + px)) * 4;
        const inv = 1 - w;
        full[fullIdx] = full[fullIdx] * inv + sampled[0] * w;
        full[fullIdx + 1] = full[fullIdx + 1] * inv + sampled[1] * w;
        full[fullIdx + 2] = full[fullIdx + 2] * inv + sampled[2] * w;
        full[fullIdx + 3] = full[fullIdx + 3] * inv + sampled[3] * w;
      }
    }

    // Record the touched region (a conservative superset — the whole
    // fetched rectangle, not just the pixels the weight cutoff actually
    // wrote — cheap to accumulate and still far smaller than the full
    // canvas) so syncSmudgeSurface() knows what to upload next time
    // anything actually needs to read the real canvas.
    if (!this.smudgeDirty) {
      this.smudgeDirty = { minX: rx0, minY: ry0, maxX: rx1, maxY: ry1 };
    } else {
      const d = this.smudgeDirty;
      if (rx0 < d.minX) d.minX = rx0;
      if (ry0 < d.minY) d.minY = ry0;
      if (rx1 > d.maxX) d.maxX = rx1;
      if (ry1 > d.maxY) d.maxY = ry1;
    }
  }

  /**
   * Uploads any pending smudge changes from the persistent `smudgeData`
   * buffer into `smudgeSurface`'s actual canvas, via a dirty-rectangle
   * `putImageData` covering only the region touched since the last sync —
   * not the whole canvas. `stampSmudgeDab` never touches the canvas itself
   * (see its own doc comment), so this is the one place that has to, and
   * it only needs to run right before `recomposite()` reads `smudgeSurface`
   * — which is already coalesced to at most once per animation frame by
   * the caller (`DocumentCanvas.scheduleRecomposite`), plus once
   * synchronously at the end of `flush()`.
   */
  private syncSmudgeSurface(): void {
    if (!this.smudgeDirty || !this.smudgeSurfaceCtx || !this.smudgeImageData) {
      this.smudgeDirty = null;
      return;
    }
    const d = this.smudgeDirty;
    const dw = d.maxX - d.minX;
    const dh = d.maxY - d.minY;
    if (dw > 0 && dh > 0) {
      try {
        this.smudgeSurfaceCtx.putImageData(this.smudgeImageData, 0, 0, d.minX, d.minY, dw, dh);
      } catch (e) {
        // swallow drawing errors
      }
    }
    this.smudgeDirty = null;
  }

  /** Builds the per-dab paint function for the current brush style: normal styles paint the stroke's wet color; Blur stamps an actually-blurred copy of the patch already there (see stampBlurDab) into `wetCtx`, so Flow/Opacity/Alpha-Lock (applied once at recomposite()) cover it uniformly with every other style. Smudge is the one exception — it reads/writes its own live `smudgeSurface` directly (see stampSmudgeDab), and recomposite() has a dedicated branch for presenting that surface instead of `wetCtx`. */
  private makeDabPainter(settings: BrushSettings): DabPainter {
    if (settings.brushStyle === 'blur') {
      return (x, y, sizeMul, taper) => this.stampBlurDab(x, y, sizeMul, taper, settings);
    }
    if (settings.brushStyle === 'smudge') {
      return (x, y, _sizeMul, taper) => this.stampSmudgeDab(x, y, taper, settings);
    }
    return (x, y, sizeMul, taper) => paintDab(this.wetCtx!, x, y, settings, sizeMul * taper, 1, this.wetColor!);
  }

  /** Merges into the current tuning without discarding in-progress stroke state. */
  setTuning(tuning: Partial<BrushEngineTuning>): void {
    this.tuning = { ...this.tuning, ...tuning };
  }

  /** Clears all per-stroke state (smoothing, velocity, wet color). Called automatically by down(). */
  reset(): void {
    this.smooth = null;
    this.rawLast = null;
    this.vel = { x: 0, y: 0 };
    this.smoothedSpeed = 0;
    this.lastDrawn = null;
    this.strokePoints = [];
    this.quadStarted = false;
    this.strokeLength = 0;
    this.prevDir = null;
    this.lastColorSamplePos = null;
    this.wetColor = null;
    this.rawSamples = [];
    this.replaying = false;
    this.smudgeLastPos = null;
    this.blurLastPos = null;
  }

  /** Starts a new stroke at `sample`: snapshots `ctx`'s current pixels as the pre-stroke ground truth and clears the wet (Flow) buffer. */
  down(
    ctx: CanvasRenderingContext2D,
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    this.reset();
    this.smooth = { x: sample.x, y: sample.y };
    this.rawLast = { ...sample };
    this.lastDrawn = { ...this.smooth };
    this.strokePoints.push({ ...this.smooth });
    this.wetColor = parseHexColor(settings.color);
    this.rawSamples.push({ ...sample });

    // PRE-WARM: Nasimulujeme počáteční rychlost, aby engine neudělal blob
    this.smoothedSpeed = 800;

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    this.ensureBuffers(w, h);
    this.preCtx!.clearRect(0, 0, w, h);
    this.preCtx!.drawImage(ctx.canvas, 0, 0);
    this.wetCtx!.clearRect(0, 0, w, h);

    if (settings.brushStyle === 'smudge') {
      // The live working surface starts as an exact copy of the layer;
      // every dab both reads and writes it from here on — see
      // stampSmudgeDab.
      if (!this.smudgeSurface) {
        this.smudgeSurface = document.createElement('canvas');
        this.smudgeSurfaceCtx = this.smudgeSurface.getContext('2d', { willReadFrequently: true });
      }
      if (this.smudgeSurface.width !== w || this.smudgeSurface.height !== h) {
        this.smudgeSurface.width = w;
        this.smudgeSurface.height = h;
      }
      this.smudgeSurfaceCtx!.clearRect(0, 0, w, h);
      this.smudgeSurfaceCtx!.drawImage(ctx.canvas, 0, 0);

      // Seed the persistent working buffer stampSmudgeDab actually reads/
      // writes during the stroke (see the class field doc above) from this
      // same fresh snapshot — one getImageData call per stroke, not per
      // dab.
      const seedImg = this.smudgeSurfaceCtx!.getImageData(0, 0, w, h);
      this.smudgeData = seedImg.data;
      this.smudgeImageData = seedImg;
      this.smudgeDirty = null;

      // Dab geometry is fixed for the whole stroke (see stampSmudgeDab's
      // doc comment for why) — set it up once here.
      const dabSize = Math.max(1, Math.round(settings.size));
      const maskStamp = getStamp({ size: dabSize, hardness: settings.hardness, brushStyle: 'round', isEraser: false, color: { r: 0, g: 0, b: 0 } });
      this.smudgeDabSize = maskStamp.width;
      this.smudgeMaskWeights = getMaskWeights(maskStamp);

      // Seed the drag-vector tracker at the stroke's actual start position,
      // so the very first processed sub-step (in the first move()) computes
      // a real motion delta relative to where the gesture began, instead of
      // having no reference point yet. There's no patch to seed anymore —
      // see the class field doc above for why.
      this.smudgeLastPos = { x: sample.x, y: sample.y };
    }
  }

  /** Advances the stroke to `sample`, smoothing/predicting the tip and stamping dabs into `ctx` along the way. Calls down() first if no stroke is in progress. Records the raw sample for the post-stroke stabilization pass — see the class doc comment — then delegates to advance(). */
  move(
    ctx: CanvasRenderingContext2D,
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    if (!this.smooth || !this.rawLast || !this.lastDrawn || !this.wetColor) {
      this.down(ctx, sample, settings);
      return;
    }
    this.rawSamples.push({ ...sample });
    this.advance(sample, settings);
  }

  /**
   * The actual per-sample stamping work move() does. Split out from move()
   * so the post-stroke stabilization replay in flush() can drive the exact
   * same stamping logic against a smoothed sample sequence without also
   * re-recording those synthetic samples into `rawSamples` (only move()'s
   * own wrapper does that) or re-triggering down()'s "no stroke in
   * progress" guard (the replay's own beginReplayPass sets up equivalent
   * state directly, without move()'s guard getting in the way). Takes no
   * `ctx` — every dab it stamps draws into the pooled `wetCtx`, never the
   * real layer directly (see recomposite()).
   *
   * No real-time stabilization here — `this.smooth` tracks the raw sample
   * directly, with zero added lag. Correction happens once, after release
   * (see flush()), not continuously while the hand is moving.
   */
  private advance(
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    // Unreachable in practice (every caller — move(), beginReplayPass() —
    // guarantees these are set first) but needed for TS to narrow the
    // `Point | null` fields for the rest of this method.
    if (!this.smooth || !this.rawLast || !this.lastDrawn || !this.wetColor) return;

    const dt = Math.max(1e-3, (sample.t - this.rawLast.t) / 1000);
    const rdx = sample.x - this.rawLast.x;
    const rdy = sample.y - this.rawLast.y;
    this.vel.x = rdx / dt;
    this.vel.y = rdy / dt;

    const instantSpeed = hypot(this.vel.x, this.vel.y);

    // Zrychlená reakce rychlosti pera
    if (instantSpeed > this.smoothedSpeed) {
      this.smoothedSpeed = this.smoothedSpeed * 0.4 + instantSpeed * 0.6;
    } else {
      this.smoothedSpeed = this.smoothedSpeed * 0.8 + instantSpeed * 0.2;
    }

    const pres = applyPressureCurve(normalizedPressure(sample), this.tuning.pressureCurveGamma);

    this.smooth.x = sample.x;
    this.smooth.y = sample.y;

    // Linear velocity extrapolation is a tangent-line guess at where the pen
    // is headed — accurate on straight runs, but on a tight curve (e.g. a
    // spiral) the real path curves away from that tangent, so the prediction
    // "shoots" straight and a stray line juts out of the curve. Detect how
    // sharply direction has changed since the last sample and damp the
    // prediction blend accordingly: full prediction on straight stretches,
    // ~none through a sharp turn.
    let predictionScale = 1;
    if (instantSpeed > 1) {
      const dirX = this.vel.x / instantSpeed;
      const dirY = this.vel.y / instantSpeed;
      if (this.prevDir) {
        const dot = dirX * this.prevDir.x + dirY * this.prevDir.y;
        predictionScale = Math.max(0, dot); // 1 = straight, 0 at a 90°+ turn
      }
      this.prevDir = { x: dirX, y: dirY };
    }

    const predT = this.tuning.predictionMs / 1000;
    const predX = this.smooth.x + this.vel.x * predT;
    const predY = this.smooth.y + this.vel.y * predT;
    const effectiveBlend = this.tuning.predictionBlend * predictionScale;
    const drawTip: Point = {
      x: this.smooth.x + (predX - this.smooth.x) * effectiveBlend,
      y: this.smooth.y + (predY - this.smooth.y) * effectiveBlend,
    };

    if (settings.colorMix > 0 && !settings.isEraser) {
      // Sample by *distance traveled*, not elapsed time — a time-based
      // throttle (the old ~80ms gate) samples far fewer times per pixel on a
      // fast stroke than a slow one, so fast strokes went a long way on a
      // stale color before the next sample landed, looking patchy/late
      // compared to a slow stroke covering the same ground. Distance-based
      // sampling keeps the same sampling density per pixel of travel
      // regardless of speed.
      const distSinceSample = this.lastColorSamplePos
        ? hypot(drawTip.x - this.lastColorSamplePos.x, drawTip.y - this.lastColorSamplePos.y)
        : Infinity;
      const sampleEvery = Math.max(3, settings.size * 0.25);

      if (distSinceSample >= sampleEvery) {
        this.lastColorSamplePos = { x: drawTip.x, y: drawTip.y };
        try {
          // Average a small neighborhood under and around the dab (ibis
          // Paint's "picks up color from its sides and underneath") rather
          // than a single pixel — much less noisy, and correctly picks up a
          // blend of colors when straddling an edge between two shapes.
          // Sampled from the pre-stroke snapshot so this stroke's own
          // (opacity-capped) paint never gets mixed back into itself.
          const radius = Math.max(2, Math.min(16, settings.size * 0.3));
          const sampled = sampleAreaColor(this.preCtx!, drawTip.x, drawTip.y, radius);

          if (sampled) {
            // Pigment-space mixing (Mixbox/Kubelka-Munk) instead of naive RGB
            // lerp — complementary colors mix toward a vibrant secondary
            // (blue+yellow -> green) instead of muddy gray.
            const mixRate = settings.colorMix * 0.35;
            const mixed = mixbox.lerp(this.wetColor, sampled, mixRate);
            this.wetColor.r = mixed[0];
            this.wetColor.g = mixed[1];
            this.wetColor.b = mixed[2];
          } else {
            const orig = parseHexColor(settings.color);
            const restoreRate = 0.12;
            this.wetColor.r += (orig.r - this.wetColor.r) * restoreRate;
            this.wetColor.g += (orig.g - this.wetColor.g) * restoreRate;
            this.wetColor.b += (orig.b - this.wetColor.b) * restoreRate;
          }
        } catch (e) {
          // ignore
        }
      }
    } else {
      this.wetColor = parseHexColor(settings.color);
    }

    this.strokePoints.push(drawTip);
    const maxPts = Math.max(6, Math.floor(this.tuning.smoothingWindow));
    if (this.strokePoints.length > maxPts) {
      this.strokePoints.splice(0, this.strokePoints.length - maxPts);
    }

    const vScale = velocityWidthScale(this.smoothedSpeed, this.tuning);
    const pts = this.strokePoints;
    const n = pts.length;

    const updateLen = (l: number) => { this.strokeLength = l; };
    const drawDab = this.makeDabPainter(settings);

    // Čekáme na 3 body (Buffering), čímž se úplně vyhneme nespolehlivé počáteční rychlosti
    if (n >= 3) {
      const pA = pts[n - 3]!;
      const pB = pts[n - 2]!;
      const pC = pts[n - 1]!;
      const start = midpoint(pA, pB);
      const end = midpoint(pB, pC);
      const ld = this.lastDrawn;

      if (!this.quadStarted) {
        if (ld && hypot(ld.x - start.x, ld.y - start.y) > 0.1) {
          stampAlongSegment(ld, start, settings, pres, vScale, this.strokeLength, updateLen, drawDab);
        }
        stampAlongQuadratic(start, pB, end, settings, pres, () => vScale, this.strokeLength, updateLen, drawDab);
        this.quadStarted = true;
      } else {
        stampAlongQuadratic(ld!, pB, end, settings, pres, () => vScale, this.strokeLength, updateLen, drawDab);
      }
      this.lastDrawn = { ...end };
      // Recompositing (full-canvas clear+drawImage, then a GPU texture
      // re-upload in the caller) is deferred to the caller, which coalesces
      // it to at most once per animation frame — pointer events can fire far
      // faster than the display refreshes, and none of the extra
      // recomposites in between would ever actually be shown.
    }

    this.rawLast = { ...sample };
  }

  /** Finishes the stroke on pointerup: paints the end taper (or a final dab for a short tap) and settles the tail into `ctx`. Call move() for every point before this. Also runs the post-stroke stabilization replay (see the class doc comment) once the raw tail is done, unless this call IS the replay's own tail (see `replaying`). */
  flush(
    ctx: CanvasRenderingContext2D,
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    if (!this.smooth || !this.lastDrawn || !this.wetColor) return;
    if (!this.replaying) this.rawSamples.push({ ...sample });

    // 1. ZÁCHRANA PRO RYCHLÉ TEČKY:
    // Pokud uživatel jen ťuknul perem (strokeLength < 2) a pero 
    // teď na konci posílá tlak 0, "půjčíme" si tlak ze začátku ťuknutí.
    let p = sample.pressure;
    if (sample.pointerType === "pen" && p === 0 && this.strokeLength < 2) {
      p = this.rawLast ? Math.max(this.rawLast.pressure, 0.1) : 0.5;
    }

    const safeSample = { ...sample, pressure: p };
    const pres = applyPressureCurve(normalizedPressure(safeSample), this.tuning.pressureCurveGamma);
    const vScale = velocityWidthScale(this.smoothedSpeed, this.tuning);

    // 2. ZABITÍ PILULKY A MEZERY:
    // Pokud máme rozjetý normální tah a pero se zvedlo (tlak 0),
    // koncová souřadnice obvykle odskočí. Úplně ji ignorujeme!
    if (sample.pointerType === "pen" && sample.pressure === 0 && this.strokeLength >= 2) {
      return;
    }

    // The end-taper's length used to be driven by `smoothedSpeed`, an
    // exponentially-smoothed, *lagging* metric — on an abrupt full stop it
    // hasn't decayed yet even though the pen's true speed at lift is ~0, so
    // the tail overshot past where the hand actually stopped. Use the true
    // instantaneous speed between the last drawn sample and this final one
    // instead, so a deliberate abrupt stop gets a short/no tail while a
    // gradual lift-and-slow still gets its intended taper.
    let finalSpeed = this.smoothedSpeed;
    if (this.rawLast) {
      const fdt = Math.max(1e-3, (sample.t - this.rawLast.t) / 1000);
      finalSpeed = hypot(sample.x - this.rawLast.x, sample.y - this.rawLast.y) / fdt;
    }

    const drawDab = this.makeDabPainter(settings);

    if (settings.endTaper > 0 && finalSpeed > 20) {
       let dirX = this.vel.x;
       let dirY = this.vel.y;

       if (hypot(dirX, dirY) < 10 && this.strokePoints.length >= 3) {
           const pOld = this.strokePoints[this.strokePoints.length - 3];
           const pNew = this.strokePoints[this.strokePoints.length - 1];
           dirX = (pNew.x - pOld.x) / 0.016;
           dirY = (pNew.y - pOld.y) / 0.016;
       }

       const dirLen = hypot(dirX, dirY) || 1;
       const normX = dirX / dirLen;
       const normY = dirY / dirLen;

       const actualTail = Math.min(settings.endTaper, finalSpeed * 0.2);

       if (actualTail > 2) {
           let currentDist = 0;
           while (currentDist < actualTail) {
               const t = currentDist / actualTail;
               const sizeTaper = Math.pow(1 - t, 1.5);
               const currentSize = settings.size * pres * vScale * sizeTaper;

               if (currentSize < 0.1) break;

               const spacing = Math.max(0.5, currentSize * 0.1);
               const tx = this.lastDrawn.x + normX * currentDist;
               const ty = this.lastDrawn.y + normY * currentDist;

               drawDab(tx, ty, pres * vScale, sizeTaper);
               currentDist += spacing;
           }
       }
    } else {
      const end = { x: safeSample.x, y: safeSample.y };
      const distToEnd = hypot(end.x - this.lastDrawn.x, end.y - this.lastDrawn.y);

      if (distToEnd > Math.max(0.5, settings.size * 0.1)) {
        stampAlongSegment(this.lastDrawn, end, settings, pres, vScale, this.strokeLength, (l) => this.strokeLength = l, drawDab);
      }

      if (this.strokeLength < 2) {
        drawDab(end.x, end.y, pres, 1);
      }
    }

    this.recomposite(ctx, settings);

    // Post-stroke stabilization: recalculate the whole stroke from a
    // smoothed version of the recorded raw path and redraw it, replacing
    // the raw preview above — see the class doc comment. Guarded by
    // `replaying` so the recursive flush() call below (which finishes the
    // replay's own tail) doesn't try to stabilize itself.
    if (!this.replaying && this.tuning.stabilization > 0 && this.rawSamples.length >= 3) {
      const smoothed = this.buildSmoothedSamples();
      if (smoothed.length >= 2) {
        this.replaying = true;
        this.beginReplayPass(smoothed[0], settings);
        for (let i = 1; i < smoothed.length - 1; i++) {
          this.advance(smoothed[i], settings);
        }
        this.flush(ctx, smoothed[smoothed.length - 1], settings);
        this.replaying = false;
      }
    }
  }

  /**
   * Averages the recorded raw path (`rawSamples`) — "recalculates its input
   * after you finish the stroke to make an average," per the feature's own
   * ask — using a window defined in ARC-LENGTH (pixels along the path), not
   * sample count, and both endpoints are always left completely untouched.
   *
   * The first version of this windowed by sample COUNT (`radius` = round of
   * the 0-10 stabilization value, clamped only to `(n-1)/2`), which had two
   * measured, real bugs reported after shipping, both structural to that
   * design, not tuning mistakes:
   *
   * 1. **Shortened/truncated the stroke.** Near the ends of the path, the
   *    window can't extend past index 0 or n-1, so it was clamped to
   *    `[0, i+radius]` / `[i-radius, n-1]` — a LOPSIDED window that still
   *    includes just as many neighbors as the interior, all pulled from one
   *    side only. Averaging point 0 with 10 points ahead of it (and
   *    nothing behind) drags the drawn start inward, and the same happens
   *    in reverse at the end — the visible stroke starts later and ends
   *    earlier than the actual gesture, reading as "the line got shorter."
   * 2. **Collapsed short strokes toward a point.** Sample count has no
   *    relationship to physical distance: a quick short stroke might only
   *    generate 6-10 raw samples, and at Stabilization 10 the (radius,
   *    n-1)/2)-clamp still permits a window covering the ENTIRE stroke for
   *    every single sample — every smoothed point becomes the same global
   *    average of the whole path, i.e. the stroke collapses toward its own
   *    centroid. That's the "sometimes it just deletes half the line" and
   *    "completely messes up the line" reports: not corruption, but the
   *    averaging window legitimately swallowing the whole path on short
   *    strokes, which are the common case for a lot of real drawing.
   *
   * Fix: window by arc length, and shrink that window automatically as a
   * sample nears either end — `effectiveRadius(i) = min(desiredRadius,
   * distanceFromStart(i), distanceToEnd(i))`. This has both endpoints at
   * distance 0 from themselves, so their own effective radius is always 0
   * (untouched, by construction — the stroke's true start/end pixel is
   * always exactly preserved, which is what actually stops it from ever
   * reading as "shorter"), ramping up smoothly to the full desired radius
   * only once a sample is that far into the interior — which also means a
   * short stroke (whose total length is less than `2 * desiredRadius`) can
   * never have any sample's window reach more than half the stroke, so it
   * can't collapse toward a single point regardless of how many raw
   * samples happen to fall inside that length. `desiredRadius` scales
   * directly with the stabilization level (`stabilization * 8px`, so 0-10
   * maps to an 0-80px smoothing radius) — deliberately in real screen
   * pixels, not brush size or sample count, so the correction feels
   * consistent across brush sizes and drawing speeds.
   *
   * Only x/y are smoothed; pressure/timestamp/pointerType are kept from the
   * original sample at that index, so width response (which follows
   * pressure and instantaneous speed derived from timestamps) isn't dulled
   * along with the path's wobble.
   *
   * **Second bug, found after the arc-length fix above shipped: at high
   * Stabilization, smoothly-drawn curves came out with a visible new
   * squiggle/ripple along their length that wasn't in the original stroke
   * — the opposite of what smoothing should do.** Root cause was two
   * compounding issues in the arc-length version, both inherent to
   * averaging raw SAMPLES with equal weight per sample, ignoring how far
   * apart they actually are:
   * 1. **Sample-density bias.** Pointer events fire per browser tick, not
   *    per fixed distance — a slow-moving stretch of a real hand-drawn
   *    curve packs many samples into a short arc length, while a fast
   *    stretch covering the same length gets few. Counting every sample
   *    equally means a slow, densely-sampled stretch dominates the average
   *    far more than its actual physical extent along the curve warrants,
   *    visibly pulling the smoothed curve toward wherever the hand
   *    happened to slow down — exactly the kind of speed-correlated
   *    distortion a natural, varying-speed stroke (a curve, not a ruler-
   *    straight line) would trigger.
   * 2. **Box-filter ringing.** A flat (unweighted) average within a hard
   *    cutoff has sidelobes in its frequency response — it doesn't just
   *    attenuate wobble smoothly, it can *invert* certain frequency
   *    components, which reads as new small oscillations riding on top of
   *    the smoothed path rather than pure blurring.
   * Fix, both addressed together: (a) weight each contributing sample by
   * its own local arc-length "share" (half the gap to each neighbor), so
   * the average approximates a true continuous integral along the path
   * instead of a sample-count average — a dense cluster of samples over a
   * short distance now contributes proportionally to that short distance,
   * not to its sample count; (b) replace the flat box weighting with a
   * Gaussian falloff (`sigma = effectiveRadius / 2`, still cut off at
   * `effectiveRadius` for performance) — smooth, no sidelobes, no ringing.
   * The endpoint-anchoring/radius-tapering from the first fix (see above)
   * is unchanged and still what prevents shortening/collapse.
   */
  private buildSmoothedSamples(): PointerBrushSample[] {
    const raw = this.rawSamples;
    const n = raw.length;
    const desiredRadius = Math.max(0, this.tuning.stabilization) * 8;
    if (desiredRadius <= 0) return raw;

    // Cumulative arc length up to each raw sample.
    const cum = new Array<number>(n);
    cum[0] = 0;
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1] + hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
    }
    const totalLen = cum[n - 1];
    if (totalLen <= 0) return raw;

    // Each sample's own share of arc length (half the gap to each
    // neighbor) — see doc comment for why this de-biases uneven sampling
    // density instead of counting every sample equally.
    const segShare = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const prevGap = i > 0 ? cum[i] - cum[i - 1] : 0;
      const nextGap = i < n - 1 ? cum[i + 1] - cum[i] : 0;
      segShare[i] = (prevGap + nextGap) / 2 || 1;
    }

    const out: PointerBrushSample[] = new Array(n);
    // Endpoints are never touched — see doc comment.
    out[0] = raw[0];
    out[n - 1] = raw[n - 1];
    for (let i = 1; i < n - 1; i++) {
      const distFromStart = cum[i];
      const distToEnd = totalLen - cum[i];
      const effectiveRadius = Math.min(desiredRadius, distFromStart, distToEnd);
      if (effectiveRadius <= 0) {
        out[i] = raw[i];
        continue;
      }
      const sigma = effectiveRadius / 2;
      const twoSigmaSq = 2 * sigma * sigma;
      let sx = 0, sy = 0, wsum = 0;
      // Walk outward from i in both directions, Gaussian-weighted by
      // distance and by each sample's own arc-length share, cut off at
      // effectiveRadius. cum[] is monotonic, so this is a simple
      // two-pointer expansion, not a search.
      let j = i;
      while (j >= 0 && cum[i] - cum[j] <= effectiveRadius) {
        const d = cum[i] - cum[j];
        const g = Math.exp(-(d * d) / twoSigmaSq) * segShare[j];
        sx += raw[j].x * g; sy += raw[j].y * g; wsum += g;
        j--;
      }
      j = i + 1;
      while (j < n && cum[j] - cum[i] <= effectiveRadius) {
        const d = cum[j] - cum[i];
        const g = Math.exp(-(d * d) / twoSigmaSq) * segShare[j];
        sx += raw[j].x * g; sy += raw[j].y * g; wsum += g;
        j++;
      }
      out[i] = wsum > 0 ? { ...raw[i], x: sx / wsum, y: sy / wsum } : raw[i];
    }
    return out;
  }

  /**
   * Sets up per-stroke rendering state for the stabilization replay, as if
   * `sample` were a fresh down() — EXCEPT it deliberately does NOT
   * re-snapshot `preStroke` from `ctx` (which right now holds the just-
   * finished RAW stroke, not the true pre-stroke layer content) and does
   * NOT touch `rawSamples` (the replay must not record its own synthetic
   * samples). `preStroke` was already correctly captured once, by the
   * original down() at the very start of this gesture, and reused as-is;
   * only `wetBuffer` is cleared, so the replay's dabs land on a clean slate
   * that recomposite() will layer back onto that same original base.
   */
  private beginReplayPass(
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    this.smooth = { x: sample.x, y: sample.y };
    this.rawLast = { ...sample };
    this.lastDrawn = { ...this.smooth };
    this.vel = { x: 0, y: 0 };
    this.smoothedSpeed = 800;
    this.strokePoints = [{ ...this.smooth }];
    this.quadStarted = false;
    this.strokeLength = 0;
    this.prevDir = null;
    this.lastColorSamplePos = null;
    this.wetColor = parseHexColor(settings.color);
    if (this.wetCtx && this.wetBuffer) {
      this.wetCtx.clearRect(0, 0, this.wetBuffer.width, this.wetBuffer.height);
    }
    // Smudge's result lives in smudgeSurface, not wetBuffer (see
    // recomposite()'s dedicated branch), so clearing wetBuffer alone
    // doesn't discard the raw pass's smudge result the way it discards
    // every other style's raw dabs. Reseed from preStroke (the true
    // pre-stroke snapshot, unchanged since the real down()) so the
    // stabilization replay redraws smudge from scratch along the smoothed
    // path instead of smudging on top of the raw pass's already-smudged
    // surface. smudgeLastPos must reset too, or the first replay sub-step
    // would compute its drag vector from the raw pass's last position
    // (near the stroke's end) instead of the replay's actual start — a
    // huge, wrong jump.
    if (this.smudgeSurface && this.smudgeSurfaceCtx && this.preStroke) {
      this.smudgeSurfaceCtx.clearRect(0, 0, this.smudgeSurface.width, this.smudgeSurface.height);
      this.smudgeSurfaceCtx.drawImage(this.preStroke, 0, 0);
      // Reseed the persistent working buffer the same way down() does —
      // see its own comment — so the replay's dabs read/write a fresh copy
      // instead of the raw pass's already-modified one, and any dirty
      // region left over from the raw pass (already synced by its own
      // recomposite() calls, but harmless either way) doesn't carry over.
      const seedImg = this.smudgeSurfaceCtx.getImageData(0, 0, this.smudgeSurface.width, this.smudgeSurface.height);
      this.smudgeData = seedImg.data;
      this.smudgeImageData = seedImg;
      this.smudgeDirty = null;
      this.smudgeLastPos = { x: sample.x, y: sample.y };
    }
    this.blurLastPos = { x: sample.x, y: sample.y };
  }
}
