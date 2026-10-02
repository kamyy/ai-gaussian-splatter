/**
 * The /sign-up page.
 *
 * Renders Clerk's sign-up form in the app's own styling. The optional catch-all folder name ([[...sign-up]]) is needed
 * because Clerk puts its verification and single sign-on steps on sub-paths of this URL. Links to the terms of service
 * and privacy policy sit under the form, since signing up is where a user agrees to them.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { ThemedSignUp } from "@/components/auth/ThemedClerkAuth";
import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign up",
};

export default function SignUpPage() {
  return (
    <Center className="flex-col gap-4 py-8">
      <ThemedSignUp />
      <p className="text-sm text-muted-foreground">
        Read our{" "}
        <Link href="/terms" className="text-link">
          terms of service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="text-link">
          privacy policy
        </Link>
        .
      </p>
    </Center>
  );
}
