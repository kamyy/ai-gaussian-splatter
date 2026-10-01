/**
 * Shows a spinner in place of a signed-in page until Clerk has a session in the browser.
 *
 * Every page under web/app/(authenticated)/ fetches its data with the session token as soon as it mounts. Clerk has no
 * session while it is still loading. It also clears the session while it navigates away from the sign-in page, and
 * only sets the new one once that navigation finishes. A page mounted in either window gets no token, and its fetch
 * fails with "Not signed in". Holding the page back until the session exists means its first fetch always has a
 * token.
 */

"use client";

import { useAuth } from "@clerk/nextjs";

import { Center } from "@/components/layout/Center";
import { Spinner } from "@/components/ui/Spinner";

export function SignedInGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn } = useAuth();

  if (!isSignedIn) {
    return (
      <Center className="h-full" role="status" aria-label="Loading">
        <Spinner size="large" className="text-primary" />
      </Center>
    );
  }

  return children;
}
