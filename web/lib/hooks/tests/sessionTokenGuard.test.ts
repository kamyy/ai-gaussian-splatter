import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCameras } from "../useCameras";
import { useLatestJob } from "../useLatestJob";
import { usePhotos } from "../usePhotos";
import { useSplat } from "../useSplat";
import { useSplats } from "../useSplats";

// Clerk resolves getToken() to null once it has loaded without a session, so the token is mutable here rather than a
// fixed string.
const { auth } = vi.hoisted(() => ({ auth: { token: "test-token" as string | null } }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => auth.token }),
}));

// Mocked so a fetcher that skipped the token guard fails the test rather than reaching fetch() and rejecting on jsdom's
// absent network for the wrong reason.
const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<(path: string, method: string, token?: string, body?: unknown) => Promise<unknown>>(),
}));
vi.mock("@/lib/apiFetch", () => ({
  apiFetch: apiFetchMock,
}));

// SWR is stubbed so each hook's fetcher can be run directly.
const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn<(key: unknown, fetcher: unknown) => { data: undefined }>(),
}));
vi.mock("swr", () => ({ default: useSWRMock }));

function runFetcher(callIndex = 0) {
  return (useSWRMock.mock.calls[callIndex][1] as () => Promise<unknown>)();
}

describe("session token guard", () => {
  // render is widened to unknown because the hooks return differently typed SWR responses, and only the call is
  // under test here.
  const hooks: { name: string; render: () => unknown }[] = [
    { name: "useSplats", render: () => useSplats() },
    { name: "useSplat", render: () => useSplat("splat-1") },
    { name: "useLatestJob", render: () => useLatestJob("splat-1") },
    { name: "usePhotos", render: () => usePhotos("splat-1") },
    { name: "useCameras", render: () => useCameras("splat-1", true) },
  ];

  beforeEach(() => {
    useSWRMock.mockClear();
    useSWRMock.mockReturnValue({ data: undefined });
    apiFetchMock.mockClear();
    apiFetchMock.mockResolvedValue(undefined);
    auth.token = "test-token";
  });

  it.each(hooks)("$name rejects without calling the API when the session has ended", async ({ render }) => {
    // Rejecting is what puts SWR in its error state; resolving to an empty result instead would render as a signed-in
    // user with no data.
    auth.token = null;
    renderHook(render);

    await expect(runFetcher()).rejects.toThrow("Not signed in");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it.each(hooks)("$name forwards the token once Clerk has a session", async ({ render }) => {
    renderHook(render);

    await expect(runFetcher()).resolves.toBeUndefined();
    expect(apiFetchMock.mock.calls[0][2]).toBe("test-token");
  });
});
