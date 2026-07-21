import { describe, expect, it } from "vitest";
import { applyPressureCurve, velocityWidthScale, DEFAULT_BRUSH_TUNING, brushSettingsForTool } from "./brushEngine";
import type { BrushSettings } from "./brushTypes";

describe("applyPressureCurve", () => {
  it("passes gamma=1 through unchanged", () => {
    expect(applyPressureCurve(0.5, 1)).toBeCloseTo(0.5);
    expect(applyPressureCurve(0, 1)).toBe(0);
    expect(applyPressureCurve(1, 1)).toBe(1);
  });

  it("clamps the input to [0, 1]", () => {
    expect(applyPressureCurve(-0.5, 1)).toBe(0);
    expect(applyPressureCurve(1.5, 1)).toBe(1);
  });

  it("clamps gamma to [0.2, 3]", () => {
    expect(applyPressureCurve(0.5, 0.01)).toBeCloseTo(Math.pow(0.5, 0.2));
    expect(applyPressureCurve(0.5, 100)).toBeCloseTo(Math.pow(0.5, 3));
  });

  it("a higher gamma darkens (shrinks) mid-range pressure more", () => {
    const low = applyPressureCurve(0.5, 0.5);
    const high = applyPressureCurve(0.5, 2);
    expect(high).toBeLessThan(low);
  });
});

describe("velocityWidthScale", () => {
  it("returns 1 (no thinning) when velocityThinning is disabled", () => {
    const tuning = { ...DEFAULT_BRUSH_TUNING, velocityThinning: 0 };
    expect(velocityWidthScale(5000, tuning)).toBe(1);
  });

  it("returns 1 at zero speed", () => {
    expect(velocityWidthScale(0, DEFAULT_BRUSH_TUNING)).toBeCloseTo(1);
  });

  it("thins monotonically as speed approaches referenceSpeed", () => {
    const half = velocityWidthScale(DEFAULT_BRUSH_TUNING.referenceSpeed / 2, DEFAULT_BRUSH_TUNING);
    const full = velocityWidthScale(DEFAULT_BRUSH_TUNING.referenceSpeed, DEFAULT_BRUSH_TUNING);
    expect(full).toBeLessThan(half);
    expect(half).toBeLessThan(1);
  });

  it("caps thinning at referenceSpeed — going faster doesn't thin further", () => {
    const atReference = velocityWidthScale(DEFAULT_BRUSH_TUNING.referenceSpeed, DEFAULT_BRUSH_TUNING);
    const wayPastReference = velocityWidthScale(DEFAULT_BRUSH_TUNING.referenceSpeed * 10, DEFAULT_BRUSH_TUNING);
    expect(wayPastReference).toBeCloseTo(atReference);
  });

  it("with full-strength thinning, bottoms out at minWidthScale at referenceSpeed", () => {
    const tuning = { ...DEFAULT_BRUSH_TUNING, velocityThinning: 1 };
    const scale = velocityWidthScale(tuning.referenceSpeed, tuning);
    expect(scale).toBeCloseTo(tuning.minWidthScale);
  });
});

describe("brushSettingsForTool", () => {
  const base: Omit<BrushSettings, "isEraser"> = {
    size: 10,
    hardness: 1,
    opacity: 1,
    color: "#000000",
    intensity: 1,
    startTaper: 0,
    endTaper: 0,
    colorMix: 0,
    brushStyle: "round",
    alphaLocked: false,
    smudgeStrength: 0,
  };

  it("sets isEraser true for the eraser tool", () => {
    expect(brushSettingsForTool(base, "eraser").isEraser).toBe(true);
  });

  it("sets isEraser false for the brush tool", () => {
    expect(brushSettingsForTool(base, "brush").isEraser).toBe(false);
  });
});
