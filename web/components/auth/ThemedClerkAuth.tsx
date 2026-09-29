/**
 * Clerk's sign-in and sign-up forms, in the app's colors.
 *
 * Clerk draws its own forms, so the app passes it the theme's colors (web/lib/clerkAppearance.ts). These are small
 * client components, not a plain "use client" on the sign-in and sign-up pages, so those pages can stay Server
 * Components and keep their `metadata` exports.
 */

"use client";

import { SignIn, SignUp } from "@clerk/nextjs";

import { clerkAppearanceVariables } from "@/lib/clerkAppearance";

export function ThemedSignIn() {
  return <SignIn appearance={{ variables: clerkAppearanceVariables }} />;
}

export function ThemedSignUp() {
  return <SignUp appearance={{ variables: clerkAppearanceVariables }} />;
}
