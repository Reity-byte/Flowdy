// src/engine/brushEngine.ts
import type { BrushSettings, Point, PointerBrushSample } from "./brushTypes";

export type BrushEngineTuning = {
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
  stabilization: 0.35,
  predictionMs: 22,
  predictionBlend: 0.45,
  velocityThinning: 0.4, 
  referenceSpeed: 2000,
  minWidthScale: 0.15,
  pressureCurveGamma: 0.85,
  smoothingWindow: 10,
};

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function normalizedPressure(sample: PointerBrushSample): number {
  if (sample.pointerType === "pen") {
    return sample.pressure;
  }
  return 1;
}

export function applyPressureCurve(normalized: number, gamma: number): number {
  const g = Math.max(0.2, Math.min(3, gamma));
  return Math.pow(Math.min(1, Math.max(0, normalized)), g);
}

function hypot(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

function velocityWidthScale(speedPxPerSec: number, tuning: BrushEngineTuning): number {
  if (tuning.velocityThinning <= 0) return 1;
  const u = Math.min(1, speedPxPerSec / Math.max(1, tuning.referenceSpeed));
  const thin = tuning.minWidthScale;
  const k = tuning.velocityThinning;
  return 1 - k * u * (1 - thin);
}

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

  const baseOpacity = Math.min(1, Math.max(0, settings.opacity));
  const dabOpacity = baseOpacity * settings.intensity * opacityScale;

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
      ctx.globalCompositeOperation = settings.isEraser ? 'destination-out' : (settings.brushStyle === 'marker' ? 'multiply' : 'source-over');
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

// Stamp cache keyed by size/style/color/hardness
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
  // We'll bake relative alpha (1 and 1-hardness) then rely on ctx.globalAlpha when drawing
  const innerAlpha = 1;
  const outerAlpha = Math.max(0, 1 - opts.hardness);

  const grad = c.createRadialGradient(0, 0, 0, 0, 0, radius);
  if (opts.isEraser) {
    grad.addColorStop(0, `rgba(0,0,0,${innerAlpha})`);
    grad.addColorStop(innerStop, `rgba(0,0,0,${innerAlpha})`);
    grad.addColorStop(1, `rgba(0,0,0,${outerAlpha})`);
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fill();
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

  stampCache.set(key, canvas);
  return canvas;
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

export function setImmediateMode(enabled: boolean) {
  immediateMode = !!enabled;
  if (immediateMode) {
    // If enabling immediate mode, flush any queued draws first
    flushDrawQueue();
  }
}

function stampAlongSegment(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  settings: BrushSettings,
  pressureScale: number,
  velocityScale: number,
  currentLength: number,
  updateLength: (newLen: number) => void,
  wetColor?: { r: number, g: number, b: number }
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

    paintDab(ctx, x, y, settings, sizeMul * taper, 1, wetColor);
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
  ctx: CanvasRenderingContext2D,
  p0: Point, p1: Point, p2: Point,
  settings: BrushSettings,
  pressureScale: number,
  velocityAtU: (u: number) => number,
  currentLength: number,
  updateLength: (newLen: number) => void,
  wetColor?: { r: number, g: number, b: number }
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
    
    stampAlongSegment(ctx, prev, p, settings, pressureScale, vs, cl, (nl) => cl = nl, wetColor);
    prev = p;
  }
  updateLength(cl);
}

export function brushSettingsForTool(
  base: Omit<BrushSettings, "isEraser">,
  tool: "brush" | "eraser",
): BrushSettings {
  return { ...base, isEraser: tool === "eraser" } as BrushSettings;
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

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
  
  private wetColor: { r: number, g: number, b: number } | null = null;
  private lastColorSampleAt = 0;

  constructor(tuning: Partial<BrushEngineTuning> = {}) {
    this.tuning = { ...DEFAULT_BRUSH_TUNING, ...tuning };
  }

  setTuning(tuning: Partial<BrushEngineTuning>): void {
    this.tuning = { ...this.tuning, ...tuning };
  }

  reset(): void {
    this.smooth = null;
    this.rawLast = null;
    this.vel = { x: 0, y: 0 };
    this.smoothedSpeed = 0;
    this.lastDrawn = null;
    this.strokePoints = [];
    this.quadStarted = false;
    this.strokeLength = 0;
    this.wetColor = null;
  }

  down(
    _ctx: CanvasRenderingContext2D,
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    this.reset();
    this.smooth = { x: sample.x, y: sample.y };
    this.rawLast = { ...sample };
    this.lastDrawn = { ...this.smooth };
    this.strokePoints.push({ ...this.smooth });
    this.wetColor = parseHexColor(settings.color);
    
    // PRE-WARM: Nasimulujeme počáteční rychlost, aby engine neudělal blob
    this.smoothedSpeed = 800; 
  }

  move(
    ctx: CanvasRenderingContext2D,
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    if (!this.smooth || !this.rawLast || !this.lastDrawn || !this.wetColor) {
      this.down(ctx, sample, settings);
      return;
    }

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

    const s = Math.min(0.95, Math.max(0, this.tuning.stabilization));
    const follow = 1 - Math.pow(1 - s, 0.85);
    this.smooth.x += (sample.x - this.smooth.x) * follow;
    this.smooth.y += (sample.y - this.smooth.y) * follow;

    const predT = this.tuning.predictionMs / 1000;
    const predX = this.smooth.x + this.vel.x * predT * this.tuning.predictionBlend;
    const predY = this.smooth.y + this.vel.y * predT * this.tuning.predictionBlend;
    const drawTip: Point = {
      x: this.smooth.x + (predX - this.smooth.x) * this.tuning.predictionBlend,
      y: this.smooth.y + (predY - this.smooth.y) * this.tuning.predictionBlend,
    };

    if (settings.colorMix > 0 && !settings.isEraser) {
      const now = sample.t || performance.now();
      // throttle expensive per-pixel reads to ~80ms
      if (now - this.lastColorSampleAt >= 80) {
        this.lastColorSampleAt = now;
        try {
          const cx = Math.floor(drawTip.x);
          const cy = Math.floor(drawTip.y);
          const pixel = ctx.getImageData(cx, cy, 1, 1).data;

          if (pixel[3] > 10) {
            const mixRate = settings.colorMix * 0.15;
            this.wetColor.r += (pixel[0] - this.wetColor.r) * mixRate;
            this.wetColor.g += (pixel[1] - this.wetColor.g) * mixRate;
            this.wetColor.b += (pixel[2] - this.wetColor.b) * mixRate;
          } else {
            const orig = parseHexColor(settings.color);
            const restoreRate = 0.02;
            this.wetColor.r += (orig.r - this.wetColor.r) * restoreRate;
            this.wetColor.g += (orig.g - this.wetColor.g) * restoreRate;
            this.wetColor.b += (orig.b - this.wetColor.b) * restoreRate;
          }
        } catch (e) {
          // ignore
        }
      } else {
        // gently restore towards the base color while skipping sampling
        const orig = parseHexColor(settings.color);
        const restoreRate = 0.02;
        this.wetColor.r += (orig.r - this.wetColor.r) * restoreRate;
        this.wetColor.g += (orig.g - this.wetColor.g) * restoreRate;
        this.wetColor.b += (orig.b - this.wetColor.b) * restoreRate;
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
          stampAlongSegment(ctx, ld, start, settings, pres, vScale, this.strokeLength, updateLen, this.wetColor);
        }
        stampAlongQuadratic(ctx, start, pB, end, settings, pres, () => vScale, this.strokeLength, updateLen, this.wetColor);
        this.quadStarted = true;
      } else {
        stampAlongQuadratic(ctx, ld!, pB, end, settings, pres, () => vScale, this.strokeLength, updateLen, this.wetColor);
      }
      this.lastDrawn = { ...end };
    }

    this.rawLast = { ...sample };
  }

   flush(
    ctx: CanvasRenderingContext2D,
    sample: PointerBrushSample,
    settings: BrushSettings,
  ): void {
    if (!this.smooth || !this.lastDrawn || !this.wetColor) return;

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

    if (settings.endTaper > 0 && this.smoothedSpeed > 20) {
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

       const actualTail = Math.min(settings.endTaper, this.smoothedSpeed * 0.2);
       
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
               
               paintDab(ctx, tx, ty, settings, pres * vScale * sizeTaper, 1, this.wetColor);
               currentDist += spacing;
           }
       }
    } else {
      const end = { x: safeSample.x, y: safeSample.y };
      const distToEnd = hypot(end.x - this.lastDrawn.x, end.y - this.lastDrawn.y);
      
      if (distToEnd > Math.max(0.5, settings.size * 0.1)) {
        stampAlongSegment(ctx, this.lastDrawn, end, settings, pres, vScale, this.strokeLength, (l) => this.strokeLength = l, this.wetColor);
      }
      
      if (this.strokeLength < 2) {
        paintDab(ctx, end.x, end.y, settings, pres, 1, this.wetColor);
      }
    }
  }
}
export function paintStrokeSegment(
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  settings: BrushSettings,
): void {
  stampAlongSegment(ctx, from, to, settings, 1, 1, 0, () => {});
}