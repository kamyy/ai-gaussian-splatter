import { render, screen } from "@testing-library/react";
import { SnackbarProvider, useSnackbar } from "notistack";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { AlertSnackbar } from "./AlertSnackbar";

function Trigger({ message, progress }: { message: string; progress?: boolean }) {
  const { enqueueSnackbar } = useSnackbar();
  useEffect(() => {
    enqueueSnackbar(message, { variant: "info", persist: true, progress });
  }, [message, progress, enqueueSnackbar]);
  return null;
}

function renderSnackbar(props: { message: string; progress?: boolean }) {
  return render(
    <SnackbarProvider Components={{ info: AlertSnackbar }}>
      <Trigger {...props} />
    </SnackbarProvider>,
  );
}

describe("AlertSnackbar", () => {
  // web/components/job/JobStatusSnackbar.tsx persists a snackbar like this one for as long as a job stage runs,
  // often many minutes, with no other event that re-enqueues it. Closing it must not be possible, matching the
  // floating card it replaced, which also couldn't be dismissed.
  it("has no close button while it reports an in-progress job stage", () => {
    renderSnackbar({ message: "Training the Gaussian Splat…", progress: true });

    expect(screen.getByText("Training the Gaussian Splat…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("has a close button for a snackbar that isn't reporting progress", () => {
    renderSnackbar({ message: "Saved" });

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
