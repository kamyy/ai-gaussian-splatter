import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../apiFetch";

describe("apiFetch", () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);

  afterEach(() => {
    fetchMock.mockReset();
  });

  it("sends the bearer token and a JSON body, and parses the JSON reply", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ id: "s1" }));

    await expect(apiFetch("/api/v1/splats", "POST", "tok", { name: "Mug" })).resolves.toEqual({ id: "s1" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/splats");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"name":"Mug"}');
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("sends no body and no Authorization header when given neither", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([]));

    await apiFetch("/api/v1/healthz", "GET");

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });

  it("resolves to undefined for a 204 instead of parsing an empty body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(apiFetch("/api/v1/splats/s1", "DELETE", "tok")).resolves.toBeUndefined();
  });

  it("rejects with the server's error text, or the status text when there is none", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"Splat not found"}', { status: 404 }));
    await expect(apiFetch("/api/v1/splats/s1", "GET", "tok")).rejects.toThrow('{"error":"Splat not found"}');

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502, statusText: "Bad Gateway" }));
    await expect(apiFetch("/api/v1/splats/s1", "GET", "tok")).rejects.toThrow("Bad Gateway");
  });
});
