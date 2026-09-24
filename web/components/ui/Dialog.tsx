"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import { CARD_SHADOW } from "@/components/layout/Card";
import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-1300 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-1300 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 bg-paper p-4 focus:outline-none",
          className,
        )}
        style={{ boxShadow: CARD_SHADOW }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("mb-3 font-display text-lg font-semibold", className)} {...props} />;
}
