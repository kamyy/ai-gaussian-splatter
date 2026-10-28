import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";

// Requires a real Postgres (TEST_DATABASE_URL). web/drizzle/0001_readonly_role.sql is what scripts/prod/db-tunnel.sh
// logs in as, so what the role can and can't do is checked against the real grants. The test connection is a
// superuser, so each statement runs after SET LOCAL ROLE in a transaction that rolls back.
afterAll(async () => {
  await closeDb();
});

const INSUFFICIENT_PRIVILEGE = "42501";

async function asReadonlyRole(statement: ReturnType<typeof sql>) {
  return await getDb().transaction(async tx => {
    await tx.execute(sql`set local role splatter_readonly`);
    return await tx.execute(statement);
  });
}

describe("splatter_readonly", () => {
  it("reads the tables", async () => {
    await expect(asReadonlyRole(sql`select * from users`)).resolves.toBeDefined();
    await expect(asReadonlyRole(sql`select * from jobs`)).resolves.toBeDefined();
  });

  it("cannot change data or the schema", async () => {
    await expect(asReadonlyRole(sql`delete from users`)).rejects.toMatchObject({
      cause: { code: INSUFFICIENT_PRIVILEGE },
    });
    await expect(asReadonlyRole(sql`create table readonly_role_probe (id int)`)).rejects.toMatchObject({
      cause: { code: INSUFFICIENT_PRIVILEGE },
    });
  });
});
