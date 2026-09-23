import { forwardRef } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

type ButtonVariant = "contained" | "outlined" | "text";
type ButtonSize = "small" | "medium" | "large";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

// Reproduces web/theme.ts's former MuiButton override: flat print look (rounded-[2px], not fully square, not MUI's
// own default radius), no uppercase transform, and a shorter minWidth/padding than MUI's own defaults sized for
// short labels like "Create" rather than a generic action bar.
const VARIANT: Record<ButtonVariant, string> = {
  contained: "bg-primary text-primary-foreground hover:opacity-90",
  outlined: "border border-primary text-primary hover:bg-primary/10",
  text: "text-primary hover:bg-primary/10",
};

const SIZE: Record<ButtonSize, string> = {
  small: "text-xs px-3 py-0.5",
  medium: "text-sm px-4 py-1",
  large: "text-base px-5 py-2",
};

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
      className={cn(
        "inline-flex min-w-10 items-center justify-center gap-2 rounded-[2px] font-body normal-case transition-colors disabled:pointer-events-none disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});
