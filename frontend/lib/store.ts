// Zustand store (plan §1: lib/store.ts) — scoped to genuinely client-only
// UI state that SWR doesn't cover: upload-queue progress before the server
// acknowledges it, and rate-limit/error banner visibility. Server-derived
// data (objects, job status) lives in SWR's cache instead — see lib/hooks.ts.

import { create } from "zustand";

export type UploadItemStatus = "pending" | "uploading" | "uploaded" | "failed";

export interface UploadItem {
  filename: string;
  status: UploadItemStatus;
  progress: number; // 0-100
  error?: string;
}

interface Banner {
  message: string;
  variant: "error" | "warning" | "info";
}

interface AppState {
  uploads: Record<string, UploadItem>; // keyed by filename for the in-progress batch
  setUploadStatus: (filename: string, status: UploadItemStatus, error?: string) => void;
  setUploadProgress: (filename: string, progress: number) => void;
  resetUploads: () => void;

  banner: Banner | null;
  showBanner: (banner: Banner) => void;
  dismissBanner: () => void;
}

export const useAppStore = create<AppState>(set => ({
  uploads: {},
  setUploadStatus: (filename, status, error) =>
    set(state => ({
      uploads: {
        ...state.uploads,
        [filename]: {
          ...(state.uploads[filename] ?? { filename, progress: 0 }),
          filename,
          status,
          error,
        },
      },
    })),
  setUploadProgress: (filename, progress) =>
    set(state => ({
      uploads: {
        ...state.uploads,
        [filename]: {
          ...(state.uploads[filename] ?? { filename, status: "pending" }),
          filename,
          progress,
        },
      },
    })),
  resetUploads: () => set({ uploads: {} }),

  banner: null,
  showBanner: banner => set({ banner }),
  dismissBanner: () => set({ banner: null }),
}));
