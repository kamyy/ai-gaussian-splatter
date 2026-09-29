/**
 * A short text label that appears when hovering or focusing an element.
 *
 * A thin wrapper that gives Radix's Tooltip the app's styling. Radix's Tooltip is unstyled and needs a Provider above
 * it, so each one carries its own rather than the app adding one to web/app/layout.tsx. The wrapped element has to
 * accept a ref and forward props, which a DOM element such as <label> does.
 */

"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";

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
