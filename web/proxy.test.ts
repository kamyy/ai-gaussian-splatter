import { afterEach, describe, expect, it, vi } from "vitest";

import { contentSecurityPolicy } from "./proxy";

function directive(name: string): string[] {
  const found = contentSecurityPolicy()
    .split("; ")
    .find(entry => entry.startsWith(`${name} `));

  return found === undefined ? [] : found.split(" ").slice(1);
}

describe("contentSecurityPolicy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets the browser reach both buckets, and no other S3 origin", () => {
    const buckets = [
      "https://test-uploads.s3.us-west-2.amazonaws.com",
      "https://test-splats.s3.us-west-2.amazonaws.com",
    ];

    expect(directive("connect-src")).toEqual(expect.arrayContaining(buckets));
    expect(directive("img-src")).toEqual(expect.arrayContaining(buckets));
    expect(contentSecurityPolicy()).not.toMatch(/\*\.s3|\*\.amazonaws/);
  });

  it("names the Clerk Frontend API host the publishable key encodes", () => {
    // The base64 of "example.clerk.accounts.dev$".
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk");

    expect(directive("script-src")).toContain("https://example.clerk.accounts.dev");
    expect(directive("connect-src")).toContain("https://example.clerk.accounts.dev");
  });

  it("allows eval only in development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");

    vi.stubEnv("NODE_ENV", "development");
    expect(directive("script-src")).toContain("'unsafe-eval'");
  });

  it("allows Google Analytics from every source Google documents", () => {
    expect(directive("script-src")).toContain("https://*.googletagmanager.com");
    expect(directive("img-src")).toEqual(
      expect.arrayContaining(["https://*.google-analytics.com", "https://*.googletagmanager.com"]),
    );
    expect(directive("connect-src")).toEqual(
      expect.arrayContaining([
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
        "https://*.googletagmanager.com",
      ]),
    );
  });

  it("refuses to be framed, and blocks plugins", () => {
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
  });
});
