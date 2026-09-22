"use client";

import Box from "@mui/material/Box";
import { useColorScheme } from "@mui/material/styles";

import { rem } from "@/lib/rem";

const DARK_STOPS = ["#3A2318", "#B5602E", "#F0C68A"];
const LIGHT_STOPS = ["#6B4226", "#B5602E", "#E8A96B"];

function seededRandom(seed: number) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]
    .map(v => clamp(v).toString(16).padStart(2, "0"))
    .join("")}`;
}

function colorForDepth(depth: number, stops: string[]): string {
  return depth < 0.5 ? mix(stops[0], stops[1], depth / 0.5) : mix(stops[1], stops[2], (depth - 0.5) / 0.5);
}

interface Point {
  left: number;
  top: number;
  size: number;
  opacity: number;
  color: string;
}

// A mug-shaped scatter of soft dots standing in for a real Gaussian Splat render, deterministic (seeded) so it's
// stable across renders. Colored by depth from the ground, echoing how the real point-cloud/splat viewer
// (web/components/viewer/SplatViewer.tsx) reads distance.
function generatePoints(stops: string[]): Point[] {
  const rand = seededRandom(42);
  const points: Point[] = [];
  for (let i = 0; i < 200; i++) {
    const yNorm = rand();
    const y = 20 + yNorm * 300;
    const profile = 0.72 + 0.18 * Math.sin(yNorm * Math.PI) - 0.06 * Math.cos(yNorm * Math.PI * 2);
    const maxR = 92 * profile;
    const angle = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand()) * maxR;
    const x = 190 + Math.cos(angle) * rr * 0.92;
    const jitterY = (rand() - 0.5) * 6;
    const size = 3 + rand() * 7;
    const depth = 0.3 + 0.7 * (rr / maxR);
    points.push({
      left: Math.round(x - size / 2),
      top: Math.round(y + jitterY - size / 2),
      size: Math.round(size),
      opacity: 0.4 + rand() * 0.45,
      color: colorForDepth(depth, stops),
    });
  }
  for (let i = 0; i < 60; i++) {
    const a = -0.9 + rand() * 1.8;
    const cx = 190 + 92 * 0.6 + 36;
    const cy = 20 + 150;
    const radius = 46 + (rand() - 0.5) * 10;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius * 1.3;
    const size = 3 + rand() * 6;
    const depth = 0.5 + rand() * 0.4;
    points.push({
      left: Math.round(x - size / 2),
      top: Math.round(y - size / 2),
      size: Math.round(size),
      opacity: 0.35 + rand() * 0.45,
      color: colorForDepth(depth, stops),
    });
  }
  return points;
}

// The signed-out hero's visual: a client component (not inlined in the Server Component web/app/page.tsx) because
// its color stops depend on useColorScheme(), which needs the client-side ThemeRegistry context.
//
// mode/systemMode are undefined on the server and on the first client render; this falls back to "dark" until that
// resolves, matching web/theme.ts's own defaultColorScheme.
export function HeroPointCloud() {
  const { mode, systemMode } = useColorScheme();
  const resolvedMode = (mode === "system" ? systemMode : mode) ?? "dark";
  const points = generatePoints(resolvedMode === "dark" ? DARK_STOPS : LIGHT_STOPS);

  return (
    <Box sx={{ position: "relative", width: rem(288), height: rem(263) }} aria-hidden="true">
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          // theme.vars (not theme.palette) so this tracks the active scheme rather than freezing to
          // defaultColorScheme; mainChannel + rgba() composes the alpha since a var() reference can't be
          // string-suffixed with hex alpha digits the way a literal hex color could.
          backgroundImage: theme =>
            `radial-gradient(ellipse at 50% 50%, rgba(${theme.vars.palette.primary.mainChannel} / 0.102), transparent 68%)`,
        }}
      />
      {points.map((point, index) => (
        <Box
          // Index is stable and safe here: this list never reorders, filters, or adds/removes items — it's a
          // fixed decorative scatter generated once per mode.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative scatter, never reordered
          key={index}
          sx={{
            position: "absolute",
            left: point.left,
            top: point.top,
            width: point.size,
            height: point.size,
            borderRadius: "50%",
            backgroundColor: point.color,
            opacity: point.opacity,
          }}
        />
      ))}
    </Box>
  );
}
