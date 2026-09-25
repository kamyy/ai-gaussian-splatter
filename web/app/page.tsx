import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteHeader } from "@/components/layout/SiteHeader";
import { HeroPointCloud } from "@/components/marketing/HeroPointCloud";
import { buttonClassName } from "@/components/ui/Button";

const STEPS = [
  { numeral: "i.", title: "Photograph", body: "A slow lap around the object, with lots of overlap." },
  { numeral: "ii.", title: "Check", body: "Look over a rough sketch of the shape before the slow part runs." },
  { numeral: "iii.", title: "Share", body: "One link, viewable in any browser. No app to install." },
];

export default async function RootPage() {
  const { userId } = await auth();
  if (userId) {
    redirect("/splats");
  }

  return (
    <>
      <SiteHeader />
      <main className="grid flex-1 gap-8 px-4 py-8 sm:px-12 lg:grid-cols-2">
        <div className="flex flex-col justify-between gap-12 lg:py-10">
          <div className="flex flex-col gap-7">
            <h1 className="font-display text-6xl leading-none tracking-tight sm:text-8xl">
              Every object,
              <br />
              <span className="italic">in the round.</span>
            </h1>
            <p className="max-w-120 text-lg text-muted-foreground">
              Photograph something from every side. AI Gaussian Splatter turns it into a 3D Gaussian Splat anyone can
              turn over in their browser.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link href="/sign-up" className={buttonClassName("contained", "large")}>
                Make your first splat
              </Link>
              <Link href="/sign-in" className={buttonClassName("outlined", "large")}>
                Sign in
              </Link>
            </div>
          </div>
          <ol className="grid gap-6 sm:grid-cols-3">
            {STEPS.map(step => (
              <li key={step.title} className="flex flex-col gap-1">
                <span className="font-display text-4xl text-primary">{step.numeral}</span>
                <span className="text-sm font-semibold">{step.title}</span>
                <span className="text-sm text-muted-foreground">{step.body}</span>
              </li>
            ))}
          </ol>
        </div>
        <figure className="flex min-h-120 items-center justify-center rounded-4xl bg-muted">
          <HeroPointCloud />
        </figure>
      </main>
    </>
  );
}
