import { SignUp } from "@clerk/nextjs";
import type { Metadata } from "next";

import { Center } from "@/components/layout/Center";

export const metadata: Metadata = {
  title: "Sign up — AI Gaussian Splatter",
};

export default function SignUpPage() {
  return (
    <Center sx={{ py: 4 }}>
      <SignUp />
    </Center>
  );
}
