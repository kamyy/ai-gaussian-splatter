export type ScrollEdgeDirection = "up" | "down" | "left" | "right";

const DIRECTION_PATH: Record<ScrollEdgeDirection, string> = {
  up: "M6 15l6-6 6 6M6 9l6 6 6-6",
  down: "M6 9l6 6 6-6M6 15l6 6 6-6",
  left: "M15 6l-6 6 6 6M9 6l-6 6 6 6",
  right: "M9 6l6 6-6 6M15 6l6 6-6 6",
};

interface ScrollEdgeButtonProps {
  label: string;
  direction: ScrollEdgeDirection;
  onClick: () => void;
}

// Shared by web/components/splats/SplatCarousel.tsx and web/components/splats/PhotoFilmstrip.tsx: a small button
// that jumps a scroll container to one end. Inline double-chevron SVGs (not an icon library), matching
// web/components/layout/NavMenu.tsx/ThemeToggle.tsx's own inline icons.
export function ScrollEdgeButton({ label, direction, onClick }: ScrollEdgeButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={DIRECTION_PATH[direction]} />
      </svg>
    </button>
  );
}
