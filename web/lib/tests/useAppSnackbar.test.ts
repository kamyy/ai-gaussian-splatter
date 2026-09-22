import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAppSnackbar } from "../useAppSnackbar";

const { enqueueSnackbarMock, closeSnackbarMock } = vi.hoisted(() => ({
  enqueueSnackbarMock: vi.fn(),
  closeSnackbarMock: vi.fn(),
}));
vi.mock("notistack", () => ({
  useSnackbar: () => ({ enqueueSnackbar: enqueueSnackbarMock, closeSnackbar: closeSnackbarMock }),
}));

describe("useAppSnackbar", () => {
  it("forces persist on an error, even when the caller didn't ask for it", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.enqueueSnackbar("Something failed", { variant: "error" });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Something failed", { variant: "error", persist: true });
  });

  it("does not let a caller opt an error out of persisting", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.enqueueSnackbar("Something failed", { variant: "error", persist: false });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Something failed", { variant: "error", persist: true });
  });

  it("leaves a non-error variant to time out on its own by default", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.enqueueSnackbar("Saved", { variant: "success" });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Saved", { variant: "success", persist: undefined });
  });

  it("still lets a non-error variant persist when the caller explicitly asks for it", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.enqueueSnackbar("Still working…", { variant: "info", persist: true });

    expect(enqueueSnackbarMock).toHaveBeenCalledWith("Still working…", { variant: "info", persist: true });
  });

  it("passes closeSnackbar through unchanged", () => {
    const { result } = renderHook(() => useAppSnackbar());
    result.current.closeSnackbar("some-key");

    expect(closeSnackbarMock).toHaveBeenCalledWith("some-key");
  });
});
