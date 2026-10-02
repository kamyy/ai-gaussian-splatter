import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import { POST, splatSessionPolicy } from "./route";

// aws-sdk-client-mock is a call stub with no simulated IAM, so these assert on what AssumeRole was asked for.
const stsMock = mockClient(STSClient);

function req(token: string): NextRequest {
  return { headers: new Headers({ Authorization: `Bearer ${token}` }) } as unknown as NextRequest;
}

function ctx(jobId: string) {
  return { params: Promise.resolve({ jobId }) } as never;
}

// The four statements in splatSessionPolicy's order: list photos, read photos, list results, read and write results.
function statements(policy: string) {
  return JSON.parse(policy).Statement as { Action: string | string[]; Resource: string; Condition?: unknown }[];
}

describe("worker S3 credentials", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AKIA",
        SecretAccessKey: "secret",
        SessionToken: "session",
        Expiration: new Date("2026-01-01T01:00:00Z"),
      },
    });
  });

  afterEach(() => {
    stsMock.reset();
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed() {
    const [user] = await getDb().insert(users).values({ clerkUserId: "u1" }).returning();
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [job] = await getDb().insert(jobs).values({ splatId: splat.id, callbackToken: "tok" }).returning();

    return { splat, job };
  }

  it("returns credentials scoped to the job's own splat", async () => {
    const { splat, job } = await seed();

    const res = await POST(req("tok"), ctx(job.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_key_id: "AKIA", secret_access_key: "secret", session_token: "session" });

    const calls = stsMock.commandCalls(AssumeRoleCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.RoleArn).toBe(process.env.WORKER_DATA_ROLE_ARN);
    expect(input.Policy).toBe(splatSessionPolicy("test-uploads", "test-splats", splat.id));
  });

  it("refuses a wrong token without assuming the role", async () => {
    const { job } = await seed();

    const res = await POST(req("not-the-token"), ctx(job.id));
    expect(res.status).toBe(401);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it("refuses a job that has ended", async () => {
    const { job } = await seed();
    await getDb().update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, job.id));

    const res = await POST(req("tok"), ctx(job.id));
    expect(res.status).toBe(409);
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
});

describe("splatSessionPolicy", () => {
  const policy = statements(splatSessionPolicy("uploads", "splats", "abc"));

  it("reads only the splat's photos, not their thumbnails or another splat's", () => {
    expect(policy[0].Resource).toBe("arn:aws:s3:::uploads");
    expect(policy[0].Condition).toEqual({ StringLike: { "s3:prefix": "splats/abc/photos/*" } });
    expect(policy[1]).toMatchObject({ Action: "s3:GetObject", Resource: "arn:aws:s3:::uploads/splats/abc/photos/*" });
  });

  it("reads and writes only the splat's own results", () => {
    expect(policy[2].Condition).toEqual({ StringLike: { "s3:prefix": "splats/abc/*" } });
    expect(policy[3].Resource).toBe("arn:aws:s3:::splats/splats/abc/*");
    expect(policy[3].Action).not.toContain("s3:DeleteObject");
  });

  it("never names a whole bucket's objects", () => {
    for (const statement of policy) {
      expect(statement.Resource).not.toMatch(/:::[^/]+\/\*$/);
    }
  });
});
