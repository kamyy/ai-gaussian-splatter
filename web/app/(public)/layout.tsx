import { Show, UserButton } from "@clerk/nextjs";

import { NavMenu } from "@/components/layout/NavMenu";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

// Sign-in, sign-up, and the public share view all keep this in-flow app header. The signed-out "/" hero and the
// authenticated splat workspace are siblings of this route group, not descendants of it, which is what lets each of
// them render its own header treatment instead — the hero has none, and the workspace renders its own
// AuthHeader (web/components/layout/AuthHeader.tsx) as a real row above its content instead of joining this shell.
//
// The header is fixed so it stays visible while the page scrolls beneath it. <main> compensates with a top padding
// equal to the header's own height (h-[3.125rem], 50px) plus one Tailwind spacing step, so nothing renders
// underneath the fixed header.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-[1100] h-[3.125rem] border-divider border-b bg-background">
        <div className="flex h-full items-center justify-between px-4">
          <NavMenu />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Show when="signed-in">
              <UserButton />
            </Show>
          </div>
        </div>
      </header>
      <main className="min-h-dvh px-4 pt-[4.125rem] pb-4">{children}</main>
    </>
  );
}
