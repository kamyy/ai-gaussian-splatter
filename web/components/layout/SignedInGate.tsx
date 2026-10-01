/**
 * Shows a spinner in place of a signed-in page until Clerk has a session in the browser, and gives each user their own
 * SWR cache.
 *
 * Every page under web/app/(authenticated)/ fetches its data with the session token as soon as it mounts. Clerk has no
 * session while it is still loading. It also clears the session while it navigates away from the sign-in page, and
 * only sets the new one once that navigation finishes. A page mounted in either window gets no token, and its fetch
 * fails with "Not signed in". Holding the page back until the session exists means its first fetch always has a
 * token.
 *
 * SWR caches responses under keys like "splats" that don't name the user. Switching accounts in the same tab would
 * otherwise show the previous account's library until the refetch lands. A new user ID mounts a fresh cache, and the
 * old one is discarded. Code inside it has to call useSWRConfig()'s mutate rather than the mutate exported by "swr",
 * which only reaches SWR's global cache.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { SWRConfig } from "swr";

import { Center } from "@/components/layout/Center";
import { Spinner } from "@/components/ui/Spinner";

export function SignedInGate({ children }: { children: React.ReactNode }) {
  const { isSignedIn, userId } = useAuth();

  if (!isSignedIn) {
    return (
      <Center className="h-full" role="status" aria-label="Loading">
        <Spinner size="large" className="text-primary" />
      </Center>
    );
  }

  return (
    <SWRConfig key={userId} value={{ provider: () => new Map() }}>
      {children}
    </SWRConfig>
  );
}
