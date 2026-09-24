import type { Metadata } from "next";
import Link from "next/link";

import { NewSplatForm } from "@/components/splats/NewSplatForm";

export const metadata: Metadata = {
  title: "New splat — AI Gaussian Splatter",
};

export default function NewSplatPage() {
  return (
    <div className="flex flex-col gap-8 px-4 py-9 sm:px-12 lg:flex-row lg:gap-12">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Link href="/splats" className="text-sm font-medium text-muted-foreground hover:text-foreground">
            ← All splats
          </Link>
          <h1 className="font-display text-5xl tracking-tight sm:text-6xl">New splat</h1>
        </div>
        <NewSplatForm />
      </div>
      <ShootingTips />
    </div>
  );
}

function ShootingTips() {
  return (
    <aside
      aria-labelledby="tips-heading"
      className="flex flex-col gap-6 self-start rounded-3xl border border-divider bg-paper p-7 lg:w-90 lg:shrink-0"
    >
      <h2 id="tips-heading" className="font-display text-3xl">
        Shooting tips
      </h2>
      <Tip title="Walk all the way round" body="A photo every few steps. Then do a second lap a little higher.">
        <ellipse cx="36" cy="30" rx="30" ry="16" className="stroke-divider" strokeDasharray="3 3" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map(i => {
          const angle = (i / 8) * Math.PI * 2;
          return (
            <circle
              key={i}
              cx={36 + Math.cos(angle) * 30}
              cy={30 + Math.sin(angle) * 16}
              r="3"
              className="fill-primary stroke-none"
            />
          );
        })}
      </Tip>
      <Tip title="Overlap each shot" body="Each photo should share most of what the last one saw.">
        <rect x="6" y="10" width="36" height="28" rx="3" />
        <rect x="28" y="18" width="36" height="28" rx="3" className="fill-primary/15" />
      </Tip>
      <Tip
        title="Even light, still object"
        body="Avoid harsh shadows. Shiny, see-through, or moving things come out blurry."
      >
        <circle cx="36" cy="26" r="10" />
        <path d="M36 8v4M36 40v4M18 26h4M50 26h4M23 13l3 3M46 36l3 3M23 39l3-3M46 16l3-3" strokeLinecap="round" />
      </Tip>
      <p className="text-sm text-muted-foreground">
        You check a sketch of the shape before the slow part runs, so a bad capture costs nothing but a re-shoot.
      </p>
    </aside>
  );
}

function Tip({ title, body, children }: { title: string; body: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <svg
        width="72"
        height="56"
        viewBox="0 0 72 56"
        fill="none"
        strokeWidth="1.6"
        className="shrink-0 stroke-primary"
        aria-hidden="true"
      >
        {children}
      </svg>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-sm text-muted-foreground">{body}</span>
      </div>
    </div>
  );
}
