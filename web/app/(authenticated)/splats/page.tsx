"use client";

import Link from "next/link";
import { useState } from "react";

import { SplatCard } from "@/components/splats/SplatCard";
import { buttonClassName } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useSplats } from "@/lib/hooks";
import { type LibraryFilter, splatBadge } from "@/lib/splatBadge";

const FILTERS: { value: LibraryFilter | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs_you", label: "Needs you" },
  { value: "in_progress", label: "In progress" },
  { value: "complete", label: "Complete" },
];

export default function LibraryPage() {
  const { data: splats, isLoading, error } = useSplats();
  const [filter, setFilter] = useState<LibraryFilter | "all">("all");

  let body: React.ReactNode;
  if (isLoading) {
    body = <SplatGridSkeleton />;
  } else if (error || !splats) {
    body = <p className="text-error">Failed to load splats.</p>;
  } else if (splats.length === 0) {
    body = <EmptyLibrary />;
  } else {
    const shown = filter === "all" ? splats : splats.filter(splat => splatBadge(splat).filter === filter);
    body =
      shown.length === 0 ? (
        <p className="text-muted-foreground">Nothing here right now.</p>
      ) : (
        <ul className="grid gap-x-6 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map(splat => (
            <li key={splat.id}>
              <SplatCard splat={splat} />
            </li>
          ))}
        </ul>
      );
  }

  return (
    <div className="flex flex-col gap-8 px-4 py-10 sm:px-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-5xl tracking-tight sm:text-6xl">
          Your splats {splats && splats.length > 0 && <span className="text-muted-foreground">{splats.length}</span>}
        </h1>
        {splats && splats.length > 0 && (
          // Buttons with aria-pressed rather than a tablist: each option re-filters one list, there are no separate
          // tab panels for a tablist to point at.
          <fieldset className="flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-divider bg-paper p-1">
            <legend className="sr-only">Filter</legend>
            {FILTERS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                onClick={() => setFilter(option.value)}
                className={cn(
                  "h-9 rounded-full px-3 text-sm font-semibold whitespace-nowrap sm:px-4",
                  filter === option.value ? "bg-foreground text-background" : "hover:bg-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </fieldset>
        )}
      </div>
      {body}
    </div>
  );
}

function SplatGridSkeleton() {
  return (
    <div className="grid gap-x-6 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="h-59 animate-pulse rounded-3xl bg-muted" />
      ))}
    </div>
  );
}

function EmptyLibrary() {
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="max-w-120 text-lg text-muted-foreground">
        No splats yet. Photograph an object from every side and upload the photos to make your first one.
      </p>
      <Link href="/splats/new" className={buttonClassName("contained", "large")}>
        Make your first splat
      </Link>
    </div>
  );
}
