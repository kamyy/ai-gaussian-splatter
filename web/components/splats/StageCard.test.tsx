import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StageCard } from "./StageCard";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mutateMock }) }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("notistack", () => ({ useSnackbar: () => ({ enqueueSnackbar: () => {} }) }));

const { processingPausedMock } = vi.hoisted(() => ({ processingPausedMock: vi.fn(() => false) }));
vi.mock("@/lib/hooks/useProcessingPaused", () => ({ useProcessingPaused: processingPausedMock }));

describe("StageCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processingPausedMock.mockReturnValue(false);
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

  it("disables Start and says why while processing is paused", () => {
    processingPausedMock.mockReturnValue(true);
    render(<StageCard splatId="splat-1" stage={{ kind: "ready" }} onJobChanged={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Processing is paused for the whole site.");
  });

  it("disables the build button while processing is paused", () => {
    processingPausedMock.mockReturnValue(true);
    render(<StageCard splatId="splat-1" stage={{ kind: "check" }} onJobChanged={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Looks right, build it" })).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it.each([
    ["Try again", { kind: "failed", step: "cameras", message: null }],
    ["Start again", { kind: "cancelled", step: "cameras" }],
  ] as const)("disables %s while processing is paused", (label, stage) => {
    processingPausedMock.mockReturnValue(true);
    render(<StageCard splatId="splat-1" stage={stage} onJobChanged={vi.fn()} />);

    expect(screen.getByRole("button", { name: label })).toBeDisabled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("starts training from the check stage", async () => {
    const onJobChanged = vi.fn();
    render(<StageCard splatId="splat-1" stage={{ kind: "check" }} onJobChanged={onJobChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Looks right, build it" }));

    await waitFor(() => expect(onJobChanged).toHaveBeenCalled());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/train", "POST", "test-token");
  });

  it("leaves the job unchanged when building fails, and refetches whether processing is paused", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Daily limit reached"));
    const onJobChanged = vi.fn();
    render(<StageCard splatId="splat-1" stage={{ kind: "check" }} onJobChanged={onJobChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Looks right, build it" }));

    // So a pause that caused the failure shows its notice without waiting for the next poll.
    await waitFor(() => expect(mutateMock).toHaveBeenCalledWith("processing"));
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

  it("offers only Stop and Discard while a stage is running", () => {
    render(
      <StageCard
        splatId="splat-1"
        stage={{ kind: "building", progress: null, startedAt: null }}
        onJobChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Building the splat" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Stop", "Discard"]);
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
