/**
 * A labelled text input.
 *
 * Renders a <label> above a rounded <input> and links the two with a generated id, so clicking the label focuses the
 * input and screen readers announce the label.
 */

"use client";

import { forwardRef, useId } from "react";

import { cn } from "@/lib/cn";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, id, className, ...props }, ref) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm font-semibold">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className={cn(
          "h-12 rounded-full border border-outline bg-paper px-4.5 text-base focus:border-primary focus:outline-none",
          className,
        )}
        {...props}
      />
    </div>
  );
});
