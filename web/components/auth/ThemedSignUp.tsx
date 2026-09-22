"use client";

import { SignUp } from "@clerk/nextjs";

import { ThemedClerkAuth } from "./ThemedClerkAuth";

// A client wrapper, not a plain "use client" on web/app/(public)/sign-up/[[...sign-up]]/page.tsx, so that page can
// keep its Server Component `metadata` export.
export function ThemedSignUp() {
  return <ThemedClerkAuth Component={SignUp} />;
}
