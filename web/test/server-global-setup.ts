import { execFileSync } from "node:child_process";

/**
 * Applies migrations once before the server suite runs, so CI's fresh Postgres
 * service container has the schema. No-op when TEST_DATABASE_URL is unset —
 * those tests skip anyway.
 */
export default function setup(): void {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    return;
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}
