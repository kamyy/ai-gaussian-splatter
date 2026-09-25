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
