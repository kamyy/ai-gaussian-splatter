import type { Metadata } from "next";

import { ThemedSignIn } from "@/components/auth/ThemedSignIn";
import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign in — AI Gaussian Splatter",
};

export default function SignInPage() {
  return (
    <Center sx={{ py: 4 }}>
      <ThemedSignIn />
    </Center>
  );
}
