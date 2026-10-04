import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DeleteAccountDialog } from "../DeleteAccountDialog";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
  useClerk: () => ({ signOut: signOutMock }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

vi.mock("notistack", () => ({ useSnackbar: () => ({ enqueueSnackbar: () => {} }) }));

describe("DeleteAccountDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue(undefined);
  });

  it("closes without deleting when the user keeps the account", () => {
    const onOpenChange = vi.fn();
    render(<DeleteAccountDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("deletes the account, then signs out to the home page", async () => {
    render(<DeleteAccountDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledWith({ redirectUrl: "/" }));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/account", "DELETE", "test-token");
  });

  it("stays open and stays signed in when deleting fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Server error"));
    render(<DeleteAccountDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Delete account" })).toBeEnabled();
    });
    expect(signOutMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete your account?" })).toBeInTheDocument();
  });
});
