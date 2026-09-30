/**
 * The /sign-up page.
 *
 * Renders Clerk's sign-up form in the app's own styling. The optional catch-all folder name ([[...sign-up]]) is needed
 * because Clerk puts its verification and single sign-on steps on sub-paths of this URL.
 */

import type { Metadata } from "next";

import { ThemedSignUp } from "@/components/auth/ThemedClerkAuth";
import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign up",
};

export default function SignUpPage() {
  return (
    <Center className="py-8">
      <ThemedSignUp />
    </Center>
  );
}
