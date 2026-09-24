import { SiteHeader } from "@/components/layout/SiteHeader";

// Pinned to the viewport height with only the content area scrolling, so a splat page's viewer can fill exactly the
// space the header leaves (h-full) while the library and the new-splat form still scroll normally.
export default function SplatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col">
      <SiteHeader />
      <main className="relative min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
