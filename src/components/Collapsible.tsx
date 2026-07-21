import type { ReactNode } from "react";

/**
 * Animates height from 0 to its content's natural height and back. Plain
 * `transition-all` can't animate to/from `height: auto`, and measuring
 * pixel heights in JS would mean a layout-thrashing effect on every
 * open/close — the `grid-template-rows: 0fr → 1fr` trick sidesteps both:
 * the grid track sizes itself to the content's natural height, and CSS
 * animates the fr value directly.
 */
export function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      aria-hidden={!open}
    >
      <div className="overflow-hidden min-h-0">
        {children}
      </div>
    </div>
  );
}
