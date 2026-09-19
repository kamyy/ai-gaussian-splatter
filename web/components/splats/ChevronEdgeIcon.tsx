interface ChevronEdgeIconProps {
  size?: number;
  style?: React.CSSProperties;
}

// A chevron with a bar past its point — "skip to the end of the list," not just "one step further" like a plain
// chevron. Inline rather than an icon library dependency, matching web/components/layout/NavMenu.tsx's HomeIcon.
// Drawn pointing down with the bar below. web/components/splats/SplatCarousel.tsx and
// web/components/splats/PhotoFilmstrip.tsx rotate it per direction (180/0 for the vertical carousel, 90/-90 for the
// horizontal one).
export function ChevronEdgeIcon({ size = 16, style }: ChevronEdgeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d="M6 9l6 6 6-6" />
      <path d="M5 19h14" />
    </svg>
  );
}
