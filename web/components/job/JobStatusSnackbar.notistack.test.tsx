import { render, screen } from "@testing-library/react";
import { SnackbarProvider } from "notistack";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { AlertSnackbar } from "@/components/layout/AlertSnackbar";
import type { Job } from "@/lib/types";
import { JobStatusSnackbar } from "./JobStatusSnackbar";

const { useLatestJobMock } = vi.hoisted(() => ({ useLatestJobMock: vi.fn() }));
vi.mock("@/lib/hooks", () => ({ useLatestJob: useLatestJobMock }));

const failedJob: Job = {
  id: "f4bc403c-d47f-4f73-9da0-0547947a1ac9",
  splatId: "splat-1",
  status: "failed",
  errorMessage: "COLMAP registered only 40% of photos",
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const FAILURE_TEXT = "Processing failed: COLMAP registered only 40% of photos";

function Frame({ shown }: { shown: boolean }) {
  return (
    <SnackbarProvider Components={{ info: AlertSnackbar, error: AlertSnackbar }}>
      {shown ? <JobStatusSnackbar splatId="splat-1" /> : null}
    </SnackbarProvider>
  );
}

function duplicateKeyWarnings(errors: unknown[][]) {
  return errors.flat().filter(entry => typeof entry === "string" && entry.includes("same key"));
}

describe("JobStatusSnackbar failure snackbar", () => {
  it("does not stack a second snackbar when the component remounts with the same failed job", () => {
    useLatestJobMock.mockReturnValue({ data: failedJob });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    const { rerender } = render(<Frame shown />);
    expect(screen.getAllByText(FAILURE_TEXT)).toHaveLength(1);

    // The failure snackbar is not closed on unmount, so it is still in the provider when the splat is opened again.
    rerender(<Frame shown={false} />);
    rerender(<Frame shown />);

    expect(screen.getAllByText(FAILURE_TEXT)).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(duplicateKeyWarnings(errors)).toEqual([]);

    spy.mockRestore();
  });

  it("does not stack a second snackbar when Strict Mode runs the effect twice", () => {
    useLatestJobMock.mockReturnValue({ data: failedJob });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    render(
      <StrictMode>
        <Frame shown />
      </StrictMode>,
    );

    expect(screen.getAllByText(FAILURE_TEXT)).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(duplicateKeyWarnings(errors)).toEqual([]);

    spy.mockRestore();
  });

  it("does not reuse one key for the stage snackbar when Strict Mode runs the effect twice", () => {
    useLatestJobMock.mockReturnValue({ data: { ...failedJob, status: "reconstruction_running", errorMessage: null } });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });

    render(
      <StrictMode>
        <Frame shown />
      </StrictMode>,
    );

    expect(screen.getAllByText("Reconstructing camera positions (COLMAP)…").length).toBeGreaterThan(0);
    // AlertSnackbar's progress spinner is a decorative aria-hidden svg with an adjacent sr-only label, not a
    // role="progressbar" element — this queries the "duplicate rendered once per snackbar instance" fact through
    // that label's text instead.
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
    expect(duplicateKeyWarnings(errors)).toEqual([]);

    spy.mockRestore();
  });
});
