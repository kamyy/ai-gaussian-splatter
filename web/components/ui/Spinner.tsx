import { cn } from "@/lib/cn";

// A faint full ring with an arc running round it, both in the text color, so it matches whatever it sits on. "small"
// fits beside a button's label and "large" is a loading state on its own. Each ring is an eighth of its width thick.
const SIZE = {
  small: "h-4 w-4 border-2",
  large: "h-8 w-8 border-4",
};

export function Spinner({ size = "small", className }: { size?: keyof typeof SIZE; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block animate-spin rounded-full border-current/20 border-t-current", SIZE[size], className)}
    />
  );
}
