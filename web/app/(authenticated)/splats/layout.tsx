import { SiteHeader } from "@/components/layout/SiteHeader";

// Pinned to the viewport height with only the content area scrolling, so a splat page's viewer can fill exactly the
// space the header leaves (h-full) while the library and the new-splat form still scroll normally.
// The scrollbar's space is always reserved. web/lib/hooks/useJustifiedPages.ts lays photos out for the width it measures,
// and a scrollbar that appears only once they render would narrow that width, re-lay them out shorter, disappear, and
// repeat every frame.
export default function SplatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <SiteHeader />
      <main className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">{children}</main>
    </div>
  );
}
