// src/components/ColorPicker.tsx
import { useState, useEffect } from "react";
import Wheel from "@uiw/react-color-wheel";
import { useEditorStore } from "../stores/editorStore";
import { useAppStore } from "../stores/appStore";
import { documentEngineRef } from "../engine/documentEngineRef";
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from "../lib/color";
import { Button } from "./Button";

const SWATCHES = [
  "#1a1a1a", "#ffffff", "#ff4136", "#2ecc40",
  "#0074d9", "#ffdc00", "#ff851b", "#b10dc9",
  "#f012be", "#aaaaaa", "#e0e0e0", "#8e44ad"
];

const getHex = (rgbObj: {r: number, g: number, b: number}) => rgbToHex(rgbObj.r, rgbObj.g, rgbObj.b);

export function ColorPicker() {
  const currentColor = useEditorStore((s) => s.color);
  const setColor = useEditorStore((s) => s.setColor);
  
  const [hexInput, setHexInput] = useState(currentColor);
  const [rgb, setRgb] = useState(hexToRgb(currentColor));
  const [hsv, setHsv] = useState(rgbToHsv(rgb.r, rgb.g, rgb.b));

  useEffect(() => {
    const hexFromRgb = rgbToHex(rgb.r, rgb.g, rgb.b);
    if (currentColor.toLowerCase() !== hexFromRgb.toLowerCase()) {
      const newRgb = hexToRgb(currentColor);
      setHexInput(currentColor);
      setRgb(newRgb);
      setHsv(rgbToHsv(newRgb.r, newRgb.g, newRgb.b));
    }
  }, [currentColor]);

  const handleEyedropper = async () => {
    const dc = documentEngineRef.current;
    if (!dc) return;
    const pickedColor = await dc.activateEyedropper();
    if (pickedColor === "unsupported") {
      useAppStore.getState().showNotification("Eyedropper not supported here");
    } else if (pickedColor) {
      setColor(pickedColor);
    }
  };

  const updateColorFromRgb = (r: number, g: number, b: number) => {
    setRgb({ r, g, b });
    const newHsv = rgbToHsv(r, g, b);
    setHsv(newHsv);
    const newHex = rgbToHex(r, g, b);
    setHexInput(newHex);
    setColor(newHex);
  };

  const updateColorFromHsv = (h: number, s: number, v: number) => {
    setHsv({ h, s, v });
    const newRgb = hsvToRgb(h, s, v);
    setRgb(newRgb);
    const newHex = rgbToHex(newRgb.r, newRgb.g, newRgb.b);
    setHexInput(newHex);
    setColor(newHex);
  };

  // Moderní styl pro všechny posuvníky (Thumb)
  const sliderClass = "flex-1 h-2 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-slate-300";

  return (
    <div className="rounded-lg border border-shell-border bg-shell-panel p-4 flex flex-col gap-4">
      
      {/* Horní panel s náhledem a kapátkem */}
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => void handleEyedropper()}
          className="p-2 text-slate-400 hover:text-white"
          title="Pick color from screen"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2 22 7-7"/><path d="M11 6 6 11"/><path d="m14 2 6 6a3 3 0 0 1 0 4l-9 9a3 3 0 0 1-4 0l-1.6-1.6a3 3 0 0 1 0-4Z"/>
          </svg>
        </Button>
        <div
          className="h-10 flex-1 rounded-lg border border-slate-700 shadow-inner"
          style={{ backgroundColor: currentColor }}
        />
      </div>

      {/* Hex vstup */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400 font-mono w-8">HEX</span>
        <input
          type="text"
          value={hexInput}
          maxLength={7}
          onChange={(e) => {
            const val = e.target.value;
            setHexInput(val);
            if (/^#[0-9A-F]{6}$/i.test(val)) setColor(val);
          }}
          className="min-w-0 flex-1 rounded border border-shell-border bg-shell-bg px-2 py-1 text-sm text-white font-mono focus:border-shell-accent outline-none"
        />
      </div>

      {/* Barevné kolo (Hue + Saturation) — nahrazuje lineární H/S posuvníky */}
      <div className="flex flex-col items-center gap-3 pb-3 border-b border-slate-800">
        <Wheel
          color={{ h: hsv.h, s: hsv.s, v: hsv.v, a: 1 }}
          width={168}
          height={168}
          onChange={(c) => updateColorFromHsv(Math.round(c.hsv.h), Math.round(c.hsv.s), hsv.v)}
        />
        <div className="flex w-full items-center gap-2">
          <span className="text-[10px] text-slate-400 font-mono w-3">B</span>
          <input type="range" min="0" max="100" value={hsv.v} onChange={(e) => updateColorFromHsv(hsv.h, hsv.s, Number(e.target.value))} className={sliderClass} style={{ background: `linear-gradient(to right, #000000, ${getHex(hsvToRgb(hsv.h, hsv.s, 100))})` }} />
          <span className="text-[10px] text-white font-mono w-6 text-right">{hsv.v}%</span>
        </div>
      </div>

      {/* RGB Sekce */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-mono w-3">R</span>
          <input type="range" min="0" max="255" value={rgb.r} onChange={(e) => updateColorFromRgb(Number(e.target.value), rgb.g, rgb.b)} className={sliderClass} style={{ background: `linear-gradient(to right, rgb(0, ${rgb.g}, ${rgb.b}), rgb(255, ${rgb.g}, ${rgb.b}))` }} />
          <span className="text-[10px] text-white font-mono w-6 text-right">{rgb.r}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-mono w-3">G</span>
          <input type="range" min="0" max="255" value={rgb.g} onChange={(e) => updateColorFromRgb(rgb.r, Number(e.target.value), rgb.b)} className={sliderClass} style={{ background: `linear-gradient(to right, rgb(${rgb.r}, 0, ${rgb.b}), rgb(${rgb.r}, 255, ${rgb.b}))` }} />
          <span className="text-[10px] text-white font-mono w-6 text-right">{rgb.g}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-mono w-3">B</span>
          <input type="range" min="0" max="255" value={rgb.b} onChange={(e) => updateColorFromRgb(rgb.r, rgb.g, Number(e.target.value))} className={sliderClass} style={{ background: `linear-gradient(to right, rgb(${rgb.r}, ${rgb.g}, 0), rgb(${rgb.r}, ${rgb.g}, 255))` }} />
          <span className="text-[10px] text-white font-mono w-6 text-right">{rgb.b}</span>
        </div>
      </div>

      {/* Rychlé předvolby (Swatches) — 4 columns, not 6: at this panel's width,
          6 columns gave ~27px squares, well under the ~44px touch-target
          guideline (Section 14's audit). 4 columns trades one extra row for
          meaningfully bigger, easier-to-hit swatches. */}
      <div className="grid grid-cols-4 gap-2 mt-2">
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            onClick={() => setColor(swatch)}
            className={`w-full aspect-square rounded border transition hover:scale-110 ${
              currentColor.toLowerCase() === swatch.toLowerCase() ? "border-white" : "border-slate-800"
            }`}
            style={{ backgroundColor: swatch }}
          />
        ))}
      </div>

    </div>
  );
}