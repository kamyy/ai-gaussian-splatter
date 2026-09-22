"use client";

import { SignIn } from "@clerk/nextjs";

import { ThemedClerkAuth } from "./ThemedClerkAuth";

// A client wrapper, not a plain "use client" on web/app/(public)/sign-in/[[...sign-in]]/page.tsx, so that page can
// keep its Server Component `metadata` export.
export function ThemedSignIn() {
  return <ThemedClerkAuth Component={SignIn} />;
}
