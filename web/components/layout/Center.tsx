import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

// Plain CSS and Tailwind have no dedicated centering primitive. The app centers things often enough to justify this
// one-line wrapper instead of repeating the flex-centering classes at every call site.
export function Center({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-center", className)} {...props} />;
}
