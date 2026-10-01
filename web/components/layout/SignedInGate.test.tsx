import { render, screen } from "@testing-library/react";
import { useSWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SignedInGate } from "./SignedInGate";

const { auth } = vi.hoisted(() => ({
  auth: { isSignedIn: undefined as boolean | undefined, userId: "user_a" },
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isSignedIn: auth.isSignedIn, userId: auth.userId }) }));

// Shows whether the SWR cache it sits in already holds the library, then fills it.
function CacheProbe() {
  const { cache } = useSWRConfig();
  const cached = cache.get("splats") !== undefined;
  cache.set("splats", { data: [] });
  return <p>{cached ? "cached" : "empty"}</p>;
}

describe("SignedInGate", () => {
  beforeEach(() => {
    auth.isSignedIn = undefined;
    auth.userId = "user_a";
  });

  it("shows a spinner instead of the page while Clerk has no session", () => {
    render(<SignedInGate>page</SignedInGate>);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByText("page")).not.toBeInTheDocument();
  });

  it("renders the page once the session exists", () => {
    auth.isSignedIn = true;
    render(<SignedInGate>page</SignedInGate>);
    expect(screen.getByText("page")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the cache for the same user and starts an empty one for a different user", () => {
    auth.isSignedIn = true;
    const { rerender } = render(
      <SignedInGate>
        <CacheProbe />
      </SignedInGate>,
    );
    expect(screen.getByText("empty")).toBeInTheDocument();

    rerender(
      <SignedInGate>
        <CacheProbe />
      </SignedInGate>,
    );
    expect(screen.getByText("cached")).toBeInTheDocument();

    auth.userId = "user_b";
    rerender(
      <SignedInGate>
        <CacheProbe />
      </SignedInGate>,
    );
    expect(screen.getByText("empty")).toBeInTheDocument();
  });
});
