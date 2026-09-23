import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Center } from "@/components/layout/Center";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { HeroPointCloud } from "@/components/marketing/HeroPointCloud";
import { Button } from "@/components/ui/Button";

export default async function RootPage() {
  const { userId } = await auth();
  if (userId) {
    redirect("/splats");
  }

  return (
    <Center className="relative min-h-screen px-4 py-8">
      {/* This page renders with no header chrome at all (it's a sibling of web/app/(public)/layout.tsx's route
      group, not a descendant of it), so it's the one place ThemeToggle needs placing by hand rather than
      inheriting it from a shared header. */}
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="flex flex-col items-center gap-8">
        <HeroPointCloud />
        {/* MUI's sm breakpoint (600px) becomes Tailwind's default sm: (640px) here — a deliberate, cosmetically
        negligible shift for a single headline breakpoint, not worth a custom breakpoint override. */}
        <h1 className="text-center font-display text-[2.25rem] sm:text-[3.25rem]">
          <span className="block">Convert photos into a</span>
          <span className="block text-primary">3D Gaussian Splat</span>
        </h1>
        <p className="max-w-[35rem] text-center text-muted-foreground">
          Upload multi-angle photos of a physical object. Get back a real-time 3D reconstruction via AI, ready to view
          and share right in the browser.
        </p>
        <div className="flex flex-row gap-4">
          <Link href="/sign-up">
            <Button size="large" variant="contained">
              Sign up free
            </Button>
          </Link>
          <Link href="/sign-in">
            <Button size="large" variant="outlined">
              Sign in
            </Button>
          </Link>
        </div>
      </div>
    </Center>
  );
}
