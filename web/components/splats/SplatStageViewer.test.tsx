import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/lib/types";
import { SplatStageViewer } from "./SplatStageViewer";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: async () => "test-token" }),
}));

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

// Stands in for the WebGL viewer, which jsdom can't run. It shows the URL a scene would mount with.
vi.mock("@/components/viewer/SplatViewer", () => ({
  SplatViewer: ({ splatUrl }: { splatUrl: string | null }) => <p>viewer: {splatUrl}</p>,
}));

const job = { pointCloudS3Key: null } as Job;

// SWR's default cache is the app's, and like the app's it outlives a viewer across navigations. Each test uses its own
// splat so the tests share nothing in it.
function viewer(splatId: string) {
  return <SplatStageViewer splatId={splatId} job={job} complete cameras={undefined} cropBox={null} />;
}

describe("SplatStageViewer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    apiFetchMock.mockReset();
  });

  it("reuses a recent visit's URL straight away", async () => {
    apiFetchMock.mockResolvedValueOnce("url-1").mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(viewer("splat-recent"));
    expect(await screen.findByText("viewer: url-1")).toBeInTheDocument();
    rerender(<p>another page</p>);
    await act(() => vi.advanceTimersByTimeAsync(60_000));

    rerender(viewer("splat-recent"));
    expect(screen.getByText("viewer: url-1")).toBeInTheDocument();
  });

  it("re-mints the download URL well inside its 15-minute expiry", async () => {
    apiFetchMock.mockResolvedValueOnce("url-1").mockResolvedValueOnce("url-2");
    render(viewer("splat-refresh"));
    expect(await screen.findByText("viewer: url-1")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't reuse the last visit's URL on a return to the page", async () => {
    apiFetchMock.mockResolvedValueOnce("url-1");
    const { rerender } = render(viewer("splat-return"));
    expect(await screen.findByText("viewer: url-1")).toBeInTheDocument();
    rerender(<p>another page</p>);
    await act(() => vi.advanceTimersByTimeAsync(11 * 60_000));

    let resolveFresh: (url: string) => void = () => {};
    apiFetchMock.mockReturnValueOnce(new Promise(resolve => (resolveFresh = resolve)));
    rerender(viewer("splat-return"));
    expect(screen.queryByText("viewer: url-1")).not.toBeInTheDocument();

    await act(async () => resolveFresh("url-2"));
    expect(await screen.findByText("viewer: url-2")).toBeInTheDocument();
  });
});
