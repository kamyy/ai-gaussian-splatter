/**
 * Runs once when the Next.js server starts.
 *
 * Starts the hourly deletion of finished rate-limit counters (web/lib/server/rateLimit.ts). Doing it on a timer, not
 * on a request, means IP addresses are deleted on schedule even when nobody uploads. Next also runs this file in its
 * Edge runtime, which has no Postgres driver, so the import happens only under Node.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRateLimitPruning } = await import("./lib/server/rateLimit");
    startRateLimitPruning();
  }
}
