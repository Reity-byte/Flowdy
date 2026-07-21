import { describe, expect, it } from "vitest";
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from "./color";

describe("hexToRgb", () => {
  it("parses 6-digit hex", () => {
    expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(hexToRgb("#0000ff")).toEqual({ r: 0, g: 0, b: 255 });
  });

  it("expands 3-digit shorthand", () => {
    expect(hexToRgb("#f00")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("tolerates a missing # and surrounding whitespace", () => {
    expect(hexToRgb(" 1a1a1a ")).toEqual({ r: 26, g: 26, b: 26 });
  });
});

describe("rgbToHex", () => {
  it("round-trips with hexToRgb", () => {
    const hex = rgbToHex(18, 52, 86);
    expect(hex).toBe("#123456");
    expect(hexToRgb(hex)).toEqual({ r: 18, g: 52, b: 86 });
  });

  it("zero-pads single-digit hex components", () => {
    expect(rgbToHex(0, 5, 255)).toBe("#0005ff");
  });
});

describe("rgbToHsv / hsvToRgb", () => {
  it("round-trips primary colors and black/white", () => {
    const cases = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 255, g: 255, b: 255 },
      { r: 0, g: 0, b: 0 },
    ];
    for (const rgb of cases) {
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      expect(hsvToRgb(hsv.h, hsv.s, hsv.v)).toEqual(rgb);
    }
  });

  it("reports full saturation/value for pure red at hue 0", () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 100, v: 100 });
  });

  it("reports zero saturation for grays", () => {
    expect(rgbToHsv(128, 128, 128).s).toBe(0);
  });
});
