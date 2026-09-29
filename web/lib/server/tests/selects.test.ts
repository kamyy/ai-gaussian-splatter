import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../db";
import { jobs, splats } from "../db/schema";
import { jobColumns } from "../selects";

describe("jobColumns", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("never selects the callback token or instance id into a job response", () => {
    // The omission is enforced by the SQL, not by deleting keys afterwards.
    const { sql } = getDb()
      .select(jobColumns)
      .from(jobs)
      .innerJoin(splats, eq(jobs.splatId, splats.id))
      .where(and(eq(jobs.splatId, "x"), eq(splats.userId, "y")))
      .orderBy(desc(jobs.createdAt))
      .limit(1)
      .toSQL();

    expect(sql).not.toContain("callback_token");
    expect(sql).not.toContain("ec2_instance_id");
  });
});
