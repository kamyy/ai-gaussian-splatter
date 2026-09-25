import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppSnackbar } from "../useAppSnackbar";

const { enqueueSnackbarMock } = vi.hoisted(() => ({ enqueueSnackbarMock: vi.fn() }));
vi.mock("notistack", () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock }),
}));

describe("useAppSnackbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists an error until it is closed", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.enqueueSnackbar("Something failed", { variant: "error" });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Something failed", { variant: "error", persist: true });
  });

  it("lets every other variant time out on its own", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.enqueueSnackbar("Saved", { variant: "success" });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Saved", { variant: "success", persist: false });
  });
});
