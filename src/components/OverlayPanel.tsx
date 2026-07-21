import type { ComponentType, ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";

/**
 * A solidly-opaque floating sheet anchored to one edge of the canvas area —
 * the ibis-Paint-derived "on-demand overlay" replacing the old permanently-
 * docked sidebar `Drawer`s. Positioned `absolute` inside the canvas row (a
 * `relative` ancestor), so opening/closing it never changes the canvas
 * host's own box size — no `forceResize()` wiring needed here, unlike the
 * old docked layout (see todo.md Section 10.2's root cause for why that
 * mattered).
 */
export function OverlayPanel({
  icon: Icon,
  title,
  side,
  onClose,
  children,
  widthClass = "w-72",
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  side: "left" | "right";
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}) {
  return (
    <div
      className={`absolute top-0 bottom-0 ${side === "left" ? "left-0" : "right-0"} ${widthClass} z-30 flex flex-col overflow-hidden rounded-xl border border-shell-border bg-shell-panel shadow-2xl`}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-shell-border px-4 py-3">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-shell-text">
          <Icon size={14} strokeWidth={2} /> {title}
        </span>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </IconButton>
      </div>
      <div className="custom-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto p-4">
        {children}
      </div>
    </div>
  );
}
