import { forwardRef } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

type ButtonVariant = "contained" | "ink" | "outlined" | "text";
type ButtonSize = "small" | "medium" | "large";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const BASE =
  "inline-flex min-w-10 items-center justify-center gap-2 whitespace-nowrap rounded-full font-body font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50";

// Pill-shaped throughout. "contained" is the accent call to action. "ink" is the neutral high-contrast button, which inverts with the theme because it reads foreground/background rather than a fixed color.
const VARIANT: Record<ButtonVariant, string> = {
  contained: "bg-primary text-primary-foreground hover:opacity-90",
  ink: "bg-foreground text-background hover:opacity-90",
  outlined: "border border-divider text-foreground hover:bg-muted",
  text: "text-primary hover:bg-primary/10",
};

// medium and large keep a 44px minimum height, the touch-target floor.
const SIZE: Record<ButtonSize, string> = {
  small: "h-8 px-3 text-xs",
  medium: "h-11 px-5 text-sm",
  large: "h-13 px-7 text-base",
};

// For a next/link <Link> that should look like a button: a <button> nested inside an <a> is invalid HTML.
export function buttonClassName(variant: ButtonVariant = "text", size: ButtonSize = "medium", className?: string) {
  return cn(BASE, VARIANT[variant], SIZE[size], className);
}

// type="button" is hardcoded rather than left to the native default ("submit"): no current usage relies on native
// form submission, and a future Dialog use (web/components/splats/CreateSplatModal.tsx) needs to not submit a form
// by accident.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "text", size = "medium", loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClassName(variant, size, className)}
      {...props}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});
