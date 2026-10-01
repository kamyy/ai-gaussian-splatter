/**
 * The /splats/new page: name a new splat and add its photos.
 *
 * Shows web/components/splats/NewSplatForm.tsx beside a short guide to taking photos that reconstruct well, since a
 * poor capture is the most common reason a splat comes out badly.
 */

import type { Metadata } from "next";
import { BackButton } from "@/components/layout/BackButton";
import { NewSplatForm } from "@/components/splats/NewSplatForm";

export const metadata: Metadata = {
  title: "New splat",
};

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

function ShootingTips() {
  return (
    <aside
      aria-labelledby="tips-heading"
      className="flex flex-col gap-6 self-start rounded-3xl border border-divider bg-paper p-7 lg:w-130 lg:shrink-0"
    >
      <h2 id="tips-heading" className="font-display text-3xl">
        Shooting tips
      </h2>
      <Tip
        title="Walk all the way round"
        body="A photo every few steps, about 25 a lap, with the object filling the frame. Then do a second lap higher up."
      >
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
        title="Move yourself, not the object"
        body="Don't turn it on a turntable or in your hand. Nothing in the background should move either."
      >
        <ellipse cx="36" cy="42" rx="22" ry="6" />
        <rect x="28" y="24" width="16" height="16" rx="2" className="fill-primary/15" />
        <path d="M18 18a20 10 0 0 1 36 0M54 18l-5-1M54 18l1-5" strokeLinecap="round" />
        <path d="M14 8L58 52" strokeLinecap="round" />
      </Tip>
      <Tip
        title="Set it on a busy surface"
        body="Newspaper or a patterned cloth works well. A plain table gives the software nothing to line the photos up with."
      >
        <path d="M14 48L24 30h44L58 48z" />
        <path d="M22 44h4M34 44h4M46 44h4M26 38h4M38 38h4M50 38h4M30 33h4M42 33h4M54 33h4" strokeLinecap="round" />
        <rect x="32" y="12" width="14" height="18" rx="2" className="fill-primary/15" />
      </Tip>
      <Tip
        title="Lock focus and exposure"
        body="Press and hold on the object until your camera app shows a lock, and keep it locked for every shot. Refrain from using zoom or flash."
      >
        <path d="M18 16v-6h8M46 10h8v6M54 40v6h-8M26 46h-8v-6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="36" cy="28" r="4" className="fill-primary stroke-none" />
      </Tip>
      <Tip
        title="Soft light, sharp photos"
        body="Shade or an overcast day beats direct sun. Stop still for each shot, and delete any that come out blurry."
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

export default function NewSplatPage() {
  return (
    <div className="page-width flex flex-col gap-8 px-4 py-9 sm:px-12 lg:flex-row lg:gap-12">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <div className="flex items-center gap-3.5">
          <BackButton href="/splats" label="Back to Library" />
          <h1 className="min-w-0 font-display text-5xl tracking-tight sm:text-6xl">New splat</h1>
        </div>
        <NewSplatForm />
      </div>
      <ShootingTips />
    </div>
  );
}
