import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StageCard } from "./StageCard";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("swr", () => ({ mutate: mutateMock }));

const { enqueueSnackbarMock } = vi.hoisted(() => ({ enqueueSnackbarMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/lib/useAppSnackbar", () => ({ useAppSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }) }));

describe("StageCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({});
  });

  it("starts processing from the ready stage and asks the page to refetch the job", async () => {
    const onJobChanged = vi.fn();
    render(<StageCard splatId="splat-1" stage={{ kind: "ready" }} onJobChanged={onJobChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(onJobChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/process", "POST", "test-token");
    expect(mutateMock).toHaveBeenCalledWith("splats");
  });

  it("starts training from the check stage", async () => {
    const onJobChanged = vi.fn();
    render(<StageCard splatId="splat-1" stage={{ kind: "check" }} onJobChanged={onJobChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Looks right, build it" }));

    await waitFor(() => expect(onJobChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/train", "POST", "test-token");
  });

  it("reports a failed action without claiming the job changed", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Daily limit reached"));
    const onJobChanged = vi.fn();
    render(<StageCard splatId="splat-1" stage={{ kind: "check" }} onJobChanged={onJobChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Looks right, build it" }));

    await waitFor(() => expect(enqueueSnackbarMock).toHaveBeenCalledWith("Daily limit reached", { variant: "error" }));
    expect(onJobChanged).not.toHaveBeenCalled();
  });

  it("shows the worker's error for a failed job and offers a retry", () => {
    render(
      <StageCard
        splatId="splat-1"
        stage={{ kind: "failed", step: "cameras", message: "Only 5% of photos registered" }}
        onJobChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("Only 5% of photos registered")).toBeInTheDocument();
    expect(screen.getByText(/re-shoot/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("offers only Stop while a stage is running", () => {
    render(
      <StageCard
        splatId="splat-1"
        stage={{ kind: "building", progress: null, startedAt: null }}
        onJobChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Building the splat" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Stop"]);
  });

  it("shows training progress and a time estimate once the worker reports it", () => {
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    render(
      <StageCard splatId="splat-1" stage={{ kind: "building", progress: 50, startedAt }} onJobChanged={vi.fn()} />,
    );
    expect(screen.getByRole("progressbar", { name: "Building the splat" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("About 10 minutes left")).toBeInTheDocument();
  });

  it("holds back the estimate while there's too little of the run to project from", () => {
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    render(<StageCard splatId="splat-1" stage={{ kind: "building", progress: 2, startedAt }} onJobChanged={vi.fn()} />);
    expect(screen.queryByText(/left$/)).not.toBeInTheDocument();
  });
});
