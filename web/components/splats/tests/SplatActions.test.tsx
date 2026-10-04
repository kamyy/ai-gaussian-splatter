import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiscardSplatButton, StopJobButton } from "../SplatActions";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mutateMock }) }));

vi.mock("notistack", () => ({ useSnackbar: () => ({ enqueueSnackbar: () => {} }) }));

describe("DiscardSplatButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue(undefined);
  });

  it("asks first, and does nothing when the visitor keeps the splat", () => {
    render(<DiscardSplatButton splatId="splat-1" variant="outlined" />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("dialog", { name: "Delete this splat?" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("deletes the splat and returns to the library", async () => {
    render(<DiscardSplatButton splatId="splat-1" variant="outlined" />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/splats"));
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1", "DELETE", "test-token");
    expect(mutateMock).toHaveBeenCalledWith("splats");
  });

  it("stays put when deleting fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Server error"));
    render(<DiscardSplatButton splatId="splat-1" variant="outlined" />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    });
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("StopJobButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue(undefined);
  });

  it("cancels the job after confirmation and asks the page to refetch it", async () => {
    const onJobChanged = vi.fn();
    render(<StopJobButton splatId="splat-1" onJobChanged={onJobChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Stop" }).at(-1) as HTMLElement);

    await waitFor(() => expect(onJobChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/cancel", "POST", "test-token");
  });
});
