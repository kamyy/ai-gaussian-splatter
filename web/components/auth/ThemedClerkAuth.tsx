"use client";

import { SignIn, SignUp } from "@clerk/nextjs";

import { clerkAppearanceVariables } from "@/lib/clerkAppearance";

// Client wrappers, not a plain "use client" on the sign-in and sign-up pages, so those pages can keep their Server
// Component `metadata` exports.
export function ThemedSignIn() {
  return <SignIn appearance={{ variables: clerkAppearanceVariables }} />;
}

export function ThemedSignUp() {
  return <SignUp appearance={{ variables: clerkAppearanceVariables }} />;
}
