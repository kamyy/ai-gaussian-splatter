/**
 * Layout for every page that needs a signed-in user.
 *
 * Everything under web/app/(authenticated)/ renders inside this layout, which sends a signed-out visitor to the sign-in
 * page. The (authenticated) folder is a Next.js route group: the parentheses keep it out of the URL, so /splats is
 * served from web/app/(authenticated)/splats/. It guards pages only. Each API route checks sign-in for itself.
 */

import { auth } from "@clerk/nextjs/server";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  await auth.protect(); // Sign-in gate for every authenticated route
  return children;
}
