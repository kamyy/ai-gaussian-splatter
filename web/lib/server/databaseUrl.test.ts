import { describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "./databaseUrl";

/**
 * The production path here is untestable against real AWS, so these pin the
 * contract instead: ECS projects the RDS secret's fields into
 * DATABASE_USER/DATABASE_PASSWORD (see the matching assertion in
 * infra/tests/test_backend_stack.py) and this assembles the URL from them.
 */
describe("resolveDatabaseUrl", () => {
  it("uses DATABASE_URL verbatim when set", () => {
    const url = "postgresql://postgres:test@localhost:5432/postgres";
    expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it("assembles the URL from the parts ECS supplies", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_HOST: "db.abc.us-west-2.rds.amazonaws.com",
        DATABASE_PORT: "5432",
        DATABASE_NAME: "ai_gaussian_splatter",
        DATABASE_USER: "splatter_admin",
        DATABASE_PASSWORD: "s3cret",
      }),
    ).toBe("postgresql://splatter_admin:s3cret@db.abc.us-west-2.rds.amazonaws.com:5432/ai_gaussian_splatter");
  });

  it("defaults the port to 5432", () => {
    const url = resolveDatabaseUrl({
      DATABASE_HOST: "h",
      DATABASE_NAME: "n",
      DATABASE_USER: "u",
      DATABASE_PASSWORD: "p",
    });
    expect(url).toBe("postgresql://u:p@h:5432/n");
  });

  it("percent-encodes credentials so a generated password can't corrupt the URL", () => {
    // RDS excludes `"@/\` but nothing stops `:` `?` `#` `%` appearing, any of
    // which would silently truncate the URL if interpolated raw.
    const url = resolveDatabaseUrl({
      DATABASE_HOST: "h",
      DATABASE_NAME: "n",
      DATABASE_USER: "u",
      DATABASE_PASSWORD: "p:a?b#c%d",
    });
    expect(url).toBe("postgresql://u:p%3Aa%3Fb%23c%25d@h:5432/n");
    // Round-trips: pg decodes these back to the original password.
    expect(decodeURIComponent(new URL(url as string).password)).toBe("p:a?b#c%d");
  });

  it("prefers DATABASE_URL when both forms are present", () => {
    const url = resolveDatabaseUrl({
      DATABASE_URL: "postgresql://override@h/db",
      DATABASE_HOST: "h",
      DATABASE_NAME: "n",
      DATABASE_USER: "u",
      DATABASE_PASSWORD: "p",
    });
    expect(url).toBe("postgresql://override@h/db");
  });

  it("returns undefined when the parts are incomplete, so drizzle-kit generate still runs", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
    expect(resolveDatabaseUrl({ DATABASE_HOST: "h", DATABASE_NAME: "n", DATABASE_USER: "u" })).toBeUndefined();
  });
});
