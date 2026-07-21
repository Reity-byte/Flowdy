import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "warning";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  /** Forces the accent-filled "selected" look regardless of `variant` — the
   * toggle pattern used across theme/tool/layer-property switches (Alpha
   * Lock, Clip to Layer Below, active tool, Rectangle/Lasso, active theme).
   * Callers keep their own on/off boolean; this just standardizes what
   * "on" looks like everywhere instead of each toggle reinventing it. */
  pressed?: boolean;
  /** Floating-over-canvas buttons (Focus toggle, selection "Done") get a
   * stronger lift; everything else stays flat, matching the flat-button
   * convention already used almost everywhere else in the app. */
  elevated?: boolean;
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-shell-accent text-white hover:brightness-110",
  secondary: "border border-shell-border bg-shell-bg text-shell-text hover:border-shell-accent",
  ghost: "border border-transparent text-shell-text opacity-80 hover:opacity-100 hover:bg-shell-bg hover:border-shell-border",
  danger: "border border-transparent text-red-400 hover:bg-red-500 hover:text-white",
  warning: "border border-transparent bg-amber-600 text-white hover:bg-amber-500",
};

const PRESSED_CLASSES = "border border-shell-accent bg-shell-accent text-white shadow-inner hover:brightness-110";

/**
 * Single source of truth for button chrome (radius, border, transition,
 * disabled state, hover behavior) — every button in the app should render
 * through this instead of a one-off Tailwind class string. Callers still
 * pass their own `className` for layout (padding, width, text size, gap):
 * Button never sets those itself, so there's no specificity fight between
 * the variant recipe and a caller's spacing overrides.
 */
export function Button({
  variant = "secondary",
  pressed = false,
  elevated = false,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const look = pressed ? PRESSED_CLASSES : VARIANT_CLASSES[variant];
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${look} ${elevated ? "shadow-lg" : ""} ${className}`}
      {...rest}
    />
  );
}

export type IconButtonProps = Omit<ButtonProps, "variant"> & {
  /** Accessible label — also used as the hover tooltip (`title`), matching every icon-only button in the app so far. */
  label: string;
  /** Tints the hover state red — for destructive icon actions (e.g. delete layer) that don't warrant a full danger-variant button. */
  danger?: boolean;
};

/** Compact icon-only button — replaces the LayerPanel-local `IconBtn` and every hand-rolled icon button (visibility toggle, eyedropper, etc.) with one shared, consistently-sized ghost button. */
export function IconButton({ label, danger = false, className = "", pressed, ...rest }: IconButtonProps) {
  return (
    <Button
      variant="ghost"
      pressed={pressed}
      title={label}
      aria-label={label}
      className={`p-1.5 ${danger ? "hover:bg-red-500/15 hover:text-red-400 hover:border-red-500/40" : ""} ${className}`}
      {...rest}
    />
  );
}
