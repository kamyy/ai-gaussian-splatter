import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError, withErrorHandling } from "../httpError";

function failingWith(status: number, message: string) {
  return withErrorHandling(async (_request: NextRequest) => {
    throw new HttpError(status, message);
  });
}

describe("withErrorHandling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers with the error's status and message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await failingWith(429, "Too many uploads")(new NextRequest("http://localhost/api/v1/x"));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ detail: "Too many uploads" });
  });

  it("logs a rejected request with its method and path, but not its query string", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await failingWith(
      401,
      "Missing bearer token",
    )(new NextRequest("http://localhost/api/v1/splats/s1/photos/p1/complete?token=secret", { method: "POST" }));

    expect(warn.mock.calls).toEqual([["401 POST /api/v1/splats/s1/photos/p1/complete: Missing bearer token"]]);
  });

  it("logs the cause's name and message after the error's own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = withErrorHandling(async (_request: NextRequest) => {
      throw new HttpError(503, "Try again later.", {
        cause: Object.assign(new Error("EC2's own wording"), { name: "InsufficientInstanceCapacity" }),
      });
    });

    const res = await handler(new NextRequest("http://localhost/api/v1/splats/s1/train", { method: "POST" }));

    expect(warn.mock.calls).toEqual([
      ["503 POST /api/v1/splats/s1/train: Try again later. (cause InsufficientInstanceCapacity: EC2's own wording)"],
    ]);
    expect(await res.json()).toEqual({ detail: "Try again later." });
  });

  it("leaves a 404 out of the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await failingWith(404, "Splat not found")(new NextRequest("http://localhost/api/v1/splats/s1"));

    expect(warn).not.toHaveBeenCalled();
  });
});
