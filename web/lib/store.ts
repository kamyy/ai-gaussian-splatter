/**
 * The browser-side store for upload progress.
 *
 * Zustand is a small state library. This store holds the one piece of client-only state the app has: each photo's
 * upload progress, before the server has acknowledged it. Data the server owns (splats, job status) lives in SWR's
 * cache instead, through the hooks in web/lib/hooks/.
 */

import { create } from "zustand";

export type UploadItemStatus = "pending" | "uploading" | "uploaded" | "failed";

export interface UploadItem {
  filename: string;
  status: UploadItemStatus;
  progress: number; // 0-100
  error?: string;
}

interface AppState {
  uploads: Record<string, UploadItem>; // keyed by filename for the in-progress batch
  setUploadStatus: (filename: string, status: UploadItemStatus, error?: string) => void;
  setUploadProgress: (filename: string, progress: number) => void;
  resetUploads: () => void;
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
}));
