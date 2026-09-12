import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";

import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign in — AI Gaussian Splatter",
};

export default function SignInPage() {
  return (
    <Center sx={{ py: 4 }}>
      <SignIn />
    </Center>
  );
}
