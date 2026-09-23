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
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm text-muted-foreground">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className={cn(
          "border border-divider bg-transparent px-3 py-2 text-sm focus:border-primary focus:outline-none",
          className,
        )}
        {...props}
      />
    </div>
  );
});
