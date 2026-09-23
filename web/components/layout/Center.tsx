import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

// No dedicated centering primitive in plain CSS/Tailwind either; used often enough across the app to warrant this
// one-line wrapper instead of repeating the flex-centering classes at every call site.
export function Center({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-center", className)} {...props} />;
}
