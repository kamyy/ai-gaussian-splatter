"use client";

import { UserButton } from "@clerk/nextjs";

import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { useSplat } from "@/lib/hooks";
import { useActiveSplatId } from "@/lib/useActiveSplatId";

// Not a reuse of the header inlined in web/app/(public)/layout.tsx. Both sit inside a fixed-height header row (this
// one the <div> header in web/app/(authenticated)/splats/layout.tsx), but the content differs: this header looks up
// and shows the current splat's name, which the public layout has no notion of. A height of "100%" fills whatever
// height that row leaves, rather than repeating a pixel number here.
export function AuthHeader() {
  const splatId = useActiveSplatId();
  const { data: splat } = useSplat(splatId);

  return (
    <div className="grid h-full grid-cols-[1fr_auto_1fr] items-center">
      {splat && <h5 className="col-start-2 text-center font-display text-2xl">{splat.name}</h5>}
      <div className="col-start-3 flex items-center justify-end gap-2">
        <ThemeToggle />
        <UserButton />
      </div>
    </div>
  );
}
