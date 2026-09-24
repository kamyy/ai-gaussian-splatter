// Every position is in the component's own 320×420 px box, which the markup below sizes with the matching rem classes.
const WIDTH = 320;
const HEIGHT = 420;
// A celadon glaze, deliberately not the accent color, so the object never reads as part of the UI chrome. Ordered from
// the lit side to the shadow side.
const GLAZE = ["#cfe0d6", "#8fb3a4", "#5f8a7a", "#3c5e52"];
const RIM = "#e9dcc4";

function seededRandom(seed: number) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface Point {
  left: number;
  top: number;
  size: number;
  opacity: number;
  color: string;
  depth: number;
}

// A vase-shaped shell of soft dots standing in for a real Gaussian Splat render, deterministic (seeded) so the server
// and client renders match. Dots are sorted back to front so nearer ones paint over farther ones, as a real splat
// render would.
function generatePoints(): Point[] {
  const rand = seededRandom(47);
  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2 - 10;
  const height = 340;
  const points: Point[] = [];
  for (let i = 0; i < 1500; i++) {
    const t = rand();
    const angle = rand() * Math.PI * 2;
    const profile = t > 0.82 ? 0.13 + (t - 0.82) * 0.5 : 0.28 + 0.24 * Math.sin(t * Math.PI * 1.2) - 0.1 * t;
    const radius = profile * height * (0.98 + rand() * 0.04);
    const depth = Math.sin(angle);
    const light = Math.cos(angle + 0.9);
    const shade = light > 0.55 ? 0 : light > 0 ? 1 : light > -0.5 ? 2 : 3;
    const color = t > 0.35 && t < 0.42 ? RIM : GLAZE[shade];
    const size = (4 + (depth + 1) * 2.6) * (0.75 + rand() * 0.5);
    points.push({
      left: centerX + Math.cos(angle) * radius - size / 2,
      top: centerY + (0.5 - t) * height + depth * radius * 0.14 - size / 2,
      size,
      opacity: 0.45 + 0.5 * ((depth + 1) / 2),
      color,
      depth,
    });
  }
  return points.sort((a, b) => a.depth - b.depth);
}

const POINTS = generatePoints();

// The signed-out landing page's visual (web/app/page.tsx).
export function HeroPointCloud() {
  return (
    <div className="relative h-105 w-80" aria-hidden="true">
      <div className="absolute bottom-2 left-1/2 h-12 w-72 -translate-x-1/2 rounded-full bg-divider" />
      {POINTS.map(point => (
        <div
          // Left, top, and size together are unique for this seeded scatter, so they identify the dot.
          key={`${point.left}:${point.top}:${point.size}`}
          className="absolute rounded-full"
          style={{
            left: point.left,
            top: point.top,
            width: point.size,
            height: point.size,
            backgroundColor: point.color,
            opacity: point.opacity,
          }}
        />
      ))}
    </div>
  );
}
