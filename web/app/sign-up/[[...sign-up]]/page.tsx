import { SignUp } from "@clerk/nextjs";
import { Center } from "@mantine/core";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign up — AI Gaussian Splatter",
};

export default function SignUpPage() {
  return (
    <Center py="xl">
      <SignUp />
    </Center>
  );
}
