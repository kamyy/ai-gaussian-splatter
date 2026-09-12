import { auth } from "@clerk/nextjs/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  await auth.protect(); // Sign-in gate for every authenticated route
  return children;
}
