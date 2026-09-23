"use client";

import { cn } from "@/lib/cn";

interface SubNavItem {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SubNavProps {
  items: SubNavItem[];
  value: string;
  onChange: (value: string) => void;
}

// Replaces MuiToggleButtonGroup/MuiToggleButton for web/components/splats/SplatSubNav.tsx's underline-tab look.
// Deliberately a plain <button aria-pressed>, not role="tab"/role="tablist": MUI's own ToggleButton never used tab
// semantics either, and web/components/splats/SplatSubNav.test.tsx already queries getByRole("button", { name }).
export function SubNav({ items, value, onChange }: SubNavProps) {
  return (
    <div className="flex gap-5">
      {items.map(item => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={selected}
            disabled={item.disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              "relative px-1 pt-0.5 pb-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40",
              selected
                ? "font-semibold text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:content-['']"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
