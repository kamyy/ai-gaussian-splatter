/**
 * The / landing page for signed-out visitors.
 *
 * Explains what the app does and links to sign-up. When the showcase account (a runtime setting) has
 * examples, the page is laid out around them, so a visitor can open a finished splat without an account. Otherwise the
 * hero shows a decorative point cloud beside the text instead. A signed-in visitor is sent straight to their library at
 * /splats.
 */

import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteHeader } from "@/components/layout/SiteHeader";
import { ExampleSplats } from "@/components/marketing/ExampleSplats";
import { HeroPointCloud } from "@/components/marketing/HeroPointCloud";
import { buttonClassName } from "@/components/ui/Button";
import { getExampleSplats } from "@/lib/server/data";
import { getRuntimeSettings } from "@/lib/server/runtimeSettings";
import type { ExampleSplat } from "@/lib/types";

const STEPS = [
  { numeral: "i.", title: "Photograph", body: "A slow lap around the object, with lots of overlap." },
  {
    numeral: "ii.",
    title: "Check",
    body: "Photogrammetry places each photo in 3D. Look over its rough sketch of the shape before the slow part runs.",
  },
  {
    numeral: "iii.",
    title: "Share",
    body: "A CUDA GPU trains the splat. One link shows it in any browser, with no app to install.",
  },
];

const PITCH =
  "Photograph something from every side. AI Gaussian Splatter turns it into a 3D Gaussian Splat anyone can turn over in their browser.";

function Headline() {
  return (
    <h1 className="font-display text-6xl leading-none tracking-tight sm:text-8xl">
      Every object,
      <br />
      <span className="italic">in the round.</span>
    </h1>
  );
}

function CallsToAction() {
  return (
    <div className="flex flex-wrap gap-4">
      <Link href="/sign-up" className={buttonClassName("contained", "large")}>
        Make your first splat
      </Link>
    </div>
  );
}

function StepList({ className }: { className: string }) {
  return (
    <ol className={className}>
      {STEPS.map(step => (
        <li key={step.title} className="flex flex-col gap-1">
          <span className="font-display text-4xl text-primary">{step.numeral}</span>
          <span className="text-sm font-semibold">{step.title}</span>
          <span className="text-sm text-muted-foreground">{step.body}</span>
        </li>
      ))}
    </ol>
  );
}

/** The text and the steps beside the point cloud, for when there are no examples to show. */
function PointCloudLanding() {
  return (
    <main className="mx-auto grid w-full max-w-(--breakpoint-2xl) flex-1 gap-8 px-4 py-8 sm:px-12 lg:grid-cols-2">
      <div className="flex flex-col justify-between gap-12 lg:py-10">
        <div className="flex flex-col gap-7">
          <Headline />
          <p className="max-w-120 text-lg text-muted-foreground">{PITCH}</p>
          <CallsToAction />
        </div>
        <StepList className="grid gap-6 sm:grid-cols-3" />
      </div>
      <figure className="flex min-h-120 items-center justify-center rounded-4xl bg-muted">
        <HeroPointCloud />
      </figure>
    </main>
  );
}

/** A full-width hero, the examples straight below it, then the steps. */
function ExamplesLanding({ splats }: { splats: ExampleSplat[] }) {
  return (
    <main className="mx-auto flex w-full max-w-(--breakpoint-2xl) flex-1 flex-col">
      <section className="grid gap-8 px-4 pt-10 pb-10 sm:px-12 sm:pt-16 lg:grid-cols-2 lg:items-end lg:gap-12">
        <Headline />
        <div className="flex flex-col gap-6 lg:justify-self-end lg:pb-2">
          <p className="max-w-130 text-lg text-muted-foreground">
            {PITCH} Try one of the examples below, no account needed.
          </p>
          <CallsToAction />
        </div>
      </section>
      <section aria-label="Examples" className="px-4 pb-12 sm:px-12">
        <ExampleSplats splats={splats} />
      </section>
      <section
        aria-labelledby="how-it-works"
        className="grid gap-6 border-divider border-t px-4 pt-10 pb-12 sm:px-12 lg:grid-cols-4 lg:gap-8"
      >
        <h2 id="how-it-works" className="font-display text-4xl">
          How it works
        </h2>
        <StepList className="grid gap-6 sm:grid-cols-3 lg:col-span-3 lg:gap-8" />
      </section>
    </main>
  );
}

export default async function RootPage() {
  const { userId } = await auth();
  if (userId) {
    redirect("/splats");
  }

  // A failed read falls back to the point-cloud layout rather than a 500. This page is the site's front door, and it
  // needs nothing else from the database.
  let exampleSplats: ExampleSplat[] = [];
  try {
    const { showcaseClerkUserId } = await getRuntimeSettings();
    if (showcaseClerkUserId !== null) {
      exampleSplats = await getExampleSplats(showcaseClerkUserId);
    }
  } catch (err) {
    console.error("Couldn't load the landing page's examples", err);
  }

  let body: React.ReactNode;
  if (exampleSplats.length > 0) {
    body = <ExamplesLanding splats={exampleSplats} />;
  } else {
    body = <PointCloudLanding />;
  }

  return (
    <>
      <SiteHeader />
      {body}
    </>
  );
}
