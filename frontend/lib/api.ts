// Typed REST client (plan §1: lib/api.ts, "used both server- and
// client-side"). Public endpoints (gallery, public objects) need no token
// and are called from Server Components' generateMetadata; authenticated
// endpoints take a Clerk session token, obtained client-side via
// useAuth().getToken() and passed in by callers (lib/hooks.ts).

import type {
  GalleryItemRead,
  JobRead,
  ObjectRead,
  PhotoPresignItem,
  PublicObjectRead,
} from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {}
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
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

export const listObjects = (token: string) => apiFetch<ObjectRead[]>("/api/v1/objects", { token });

export const createObject = (token: string, name: string) =>
  apiFetch<ObjectRead>("/api/v1/objects", { token, method: "POST", body: { name } });

export const getObject = (token: string, objectId: string) =>
  apiFetch<ObjectRead>(`/api/v1/objects/${objectId}`, { token });

export const presignPhotos = (
  token: string,
  objectId: string,
  files: { filename: string; content_type: string }[]
) =>
  apiFetch<{ photos: PhotoPresignItem[] }>(`/api/v1/objects/${objectId}/photos/presign`, {
    token,
    method: "POST",
    body: files,
  });

export const completePhoto = (token: string, objectId: string, photoId: string) =>
  apiFetch<void>(`/api/v1/objects/${objectId}/photos/${photoId}/complete`, {
    token,
    method: "POST",
  });

export const triggerProcess = (token: string, objectId: string) =>
  apiFetch<JobRead>(`/api/v1/objects/${objectId}/process`, { token, method: "POST" });

export const getLatestJob = (token: string, objectId: string) =>
  apiFetch<JobRead>(`/api/v1/objects/${objectId}/jobs/latest`, { token });

export const getSplatUrl = (token: string, objectId: string) =>
  apiFetch<{ url: string }>(`/api/v1/objects/${objectId}/splat`, { token });

// --- Public (no token; safe to call from Server Components) ---

export const getGallery = () => apiFetch<GalleryItemRead[]>("/api/v1/gallery");

export const getGalleryItem = (itemId: string) =>
  apiFetch<GalleryItemRead>(`/api/v1/gallery/${itemId}`);

export const getPublicObject = (objectId: string) =>
  apiFetch<PublicObjectRead>(`/api/v1/public/objects/${objectId}`);

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
