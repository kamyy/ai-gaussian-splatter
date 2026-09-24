import type { HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

// Shared chrome for every card-styled panel in the app. `className`/`style` carry whatever each caller needs on top of
// that shared look, most often floating positioning.
export function Card({ children, className, ...props }: CardProps) {
  return (
    <div className={cn("rounded-3xl border border-divider bg-paper p-3", className)} {...props}>
      {children}
    </div>
  );
}
