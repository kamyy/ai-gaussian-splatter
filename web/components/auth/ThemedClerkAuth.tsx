"use client";

import type { SignIn, SignUp } from "@clerk/nextjs";

import { clerkAppearanceVariables } from "@/lib/clerkAppearance";

interface ThemedClerkAuthProps {
  Component: typeof SignIn | typeof SignUp;
}

// Shared by web/components/auth/ThemedSignIn.tsx and ThemedSignUp.tsx, which are otherwise identical apart from
// which Clerk component they render.
export function ThemedClerkAuth({ Component }: ThemedClerkAuthProps) {
  return <Component appearance={{ variables: clerkAppearanceVariables }} />;
}
