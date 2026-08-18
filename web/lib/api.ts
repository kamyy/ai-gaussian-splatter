// Typed REST client for the Route Handlers in app/api/v1/.
//
// Authenticated endpoints take a Clerk session token, obtained client-side via
// useAuth().getToken() and passed in by callers (lib/hooks.ts).
//
// Requests are same-origin now that the API lives in this app, so there is no
// base URL to configure — NEXT_PUBLIC_API_BASE_URL is gone. Server-side callers
// should skip this client entirely and use lib/server/data.ts directly rather
// than have the server make an HTTP request to itself.

import type { JobRead, PhotoPresignItem, SplatRead } from "./types";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new ApiError(response.status, detail || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

// --- Authenticated ---

export function listSplats(token: string) {
  return apiFetch<SplatRead[]>("/api/v1/splats", { token });
}

export function createSplat(token: string, name: string) {
  return apiFetch<SplatRead>("/api/v1/splats", { token, method: "POST", body: { name } });
}

export function getSplat(token: string, splatId: string) {
  return apiFetch<SplatRead>(`/api/v1/splats/${splatId}`, { token });
}

export function presignPhotos(token: string, splatId: string, files: { filename: string; contentType: string }[]) {
  return apiFetch<{ photos: PhotoPresignItem[] }>(`/api/v1/splats/${splatId}/photos/presign`, {
    token,
    method: "POST",
    body: files,
  });
}

export function completePhoto(token: string, splatId: string, photoId: string) {
  return apiFetch<void>(`/api/v1/splats/${splatId}/photos/${photoId}/complete`, {
    token,
    method: "POST",
  });
}

export function triggerProcess(token: string, splatId: string) {
  return apiFetch<JobRead>(`/api/v1/splats/${splatId}/process`, { token, method: "POST" });
}

export function getLatestJob(token: string, splatId: string) {
  return apiFetch<JobRead>(`/api/v1/splats/${splatId}/jobs/latest`, { token });
}

export function getSplatUrl(token: string, splatId: string) {
  return apiFetch<{ url: string }>(`/api/v1/splats/${splatId}/download`, { token });
}

// --- Direct-to-S3 upload (not through apiFetch — raw PUT with the file body,
// not JSON) ---

export async function uploadToS3(presignedUrl: string, file: File): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!response.ok) {
    throw new ApiError(response.status, `S3 upload failed: ${response.statusText}`);
  }
}

export { ApiError };
