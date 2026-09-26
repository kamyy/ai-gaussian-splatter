"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";

// Radix's Tooltip is unstyled and needs a Provider above it, so each one carries its own rather than the app adding
// one to web/app/layout.tsx. The trigger has to accept a ref and forward props, which a DOM element such as <label>
// does.
export function Tooltip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-1200 max-w-60 rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
