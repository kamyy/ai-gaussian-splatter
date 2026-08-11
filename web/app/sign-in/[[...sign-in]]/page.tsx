import { SignIn } from "@clerk/nextjs";
import { Center } from "@mantine/core";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in — AI Gaussian Splatter",
};

export default function SignInPage() {
  return (
    <Center py="xl">
      <SignIn />
    </Center>
  );
}
