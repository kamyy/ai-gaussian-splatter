import type { Metadata } from "next";

import { ThemedSignUp } from "@/components/auth/ThemedSignUp";
import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign up — AI Gaussian Splatter",
};

export default function SignUpPage() {
  return (
    <Center className="py-8">
      <ThemedSignUp />
    </Center>
  );
}
