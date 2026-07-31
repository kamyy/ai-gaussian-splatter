import { beforeEach, describe, expect, it } from "vitest";

import { useAppStore } from "./store";

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({ uploads: {}, banner: null });
  });

  it("setUploadStatus creates a new entry with defaults", () => {
    useAppStore.getState().setUploadStatus("a.jpg", "uploading");
    expect(useAppStore.getState().uploads["a.jpg"]).toEqual({
      filename: "a.jpg",
      status: "uploading",
      progress: 0,
      error: undefined,
    });
  });

  it("setUploadProgress preserves the existing status", () => {
    useAppStore.getState().setUploadStatus("a.jpg", "uploading");
    useAppStore.getState().setUploadProgress("a.jpg", 42);

    const item = useAppStore.getState().uploads["a.jpg"];
    expect(item.status).toBe("uploading");
    expect(item.progress).toBe(42);
  });

  it("setUploadStatus records an error message on failure", () => {
    useAppStore.getState().setUploadStatus("a.jpg", "failed", "network error");
    expect(useAppStore.getState().uploads["a.jpg"].error).toBe("network error");
  });

  it("resetUploads clears all entries", () => {
    useAppStore.getState().setUploadStatus("a.jpg", "uploaded");
    useAppStore.getState().resetUploads();
    expect(useAppStore.getState().uploads).toEqual({});
  });

  it("tracks multiple files independently", () => {
    useAppStore.getState().setUploadStatus("a.jpg", "uploaded");
    useAppStore.getState().setUploadStatus("b.jpg", "failed", "boom");

    const { uploads } = useAppStore.getState();
    expect(uploads["a.jpg"].status).toBe("uploaded");
    expect(uploads["b.jpg"].status).toBe("failed");
    expect(uploads["b.jpg"].error).toBe("boom");
  });

  it("showBanner and dismissBanner toggle banner state", () => {
    useAppStore.getState().showBanner({ message: "Rate limited", variant: "error" });
    expect(useAppStore.getState().banner).toEqual({ message: "Rate limited", variant: "error" });

    useAppStore.getState().dismissBanner();
    expect(useAppStore.getState().banner).toBeNull();
  });
});
