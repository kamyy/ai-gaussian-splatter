import { AuthHeader } from "@/components/layout/AuthHeader";
import { SplatCarousel } from "@/components/splats/SplatCarousel";

// The workspace chrome for every splats route: a fixed-width navbar (the splat carousel) spanning the full
// viewport height, with a header row and the page content stacked in a column beside it. flex-none pins the
// navbar's width and the header's height so only the two growing panes (the right-hand column and the content
// area) give up space first; min-h-0/min-w-0 on those growing panes let them actually shrink instead of
// overflowing, which is a flex item's default content-based minimum size otherwise.
export default function SplatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh w-full">
      <nav className="h-full w-[12.5rem] flex-none">
        <SplatCarousel />
      </nav>
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <header className="h-[3.125rem] flex-none px-3">
          <AuthHeader />
        </header>
        <div className="relative min-h-0 w-full flex-1">{children}</div>
      </div>
    </div>
  );
}
