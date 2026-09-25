"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/lib/cn";

export const Dialog = DialogPrimitive.Root;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-1300 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-x-4 top-1/2 z-1300 mx-auto max-w-lg -translate-y-1/2 rounded-3xl bg-paper p-6 focus:outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("mb-3 font-display text-3xl", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
