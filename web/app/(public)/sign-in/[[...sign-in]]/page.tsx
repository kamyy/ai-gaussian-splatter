/**
 * The /sign-in page.
 *
 * Renders Clerk's sign-in form in the app's own styling. The optional catch-all folder name ([[...sign-in]]) is needed
 * because Clerk puts its verification and single sign-on steps on sub-paths of this URL.
 */

import type { Metadata } from "next";

import { ThemedSignIn } from "@/components/auth/ThemedClerkAuth";
import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign in — AI Gaussian Splatter",
};

export default function SignInPage() {
  return (
    <Center className="py-8">
      <ThemedSignIn />
    </Center>
  );
}
