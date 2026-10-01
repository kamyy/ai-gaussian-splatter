import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SignedInGate } from "./SignedInGate";

const { auth } = vi.hoisted(() => ({ auth: { isSignedIn: undefined as boolean | undefined } }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isSignedIn: auth.isSignedIn }) }));

describe("SignedInGate", () => {
  beforeEach(() => {
    auth.isSignedIn = undefined;
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
});
